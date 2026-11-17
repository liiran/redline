import { EventEmitter } from "node:events"
import type { Design } from "../shared/design.ts"
import type { RampResult, Step } from "../shared/results.ts"
import type { Sample, Usage } from "../shared/samples.ts"
import { canRun, containerCount, validate } from "../shared/validate.ts"
import { run, type Docker } from "./docker.ts"
import { ramp } from "./ramp.ts"
import { newId, type Store } from "./store.ts"

export type Phase = "starting" | "ready" | "stopping" | "stopped" | "failed"

export type RampState = {
  testId: string
  running: boolean
  steps: Step[]
  current: number | null
  startedAt: number
  result: RampResult | null
}

export type SessionView = {
  id: string
  designId: string | null
  design: Design
  phase: Phase
  step: string
  log: string[]
  error: string | null
  startedAt: number
  readyMs: number | null
  containers: number
  rate: number
  ramp: RampState | null
}

/** What actually runs a design: real containers in Docker, or a stand-in for tests. */
export type Runtime = {
  start(say: (step: string) => void, log: (line: string) => void, signal: AbortSignal): Promise<void>
  setRate(rps: number): Promise<void>
  samples(after: number, signal: AbortSignal): Promise<Sample[]>
  usage(): Record<string, Usage>
  stop(): Promise<void>
}

const KEEP_SAMPLES = 900

export class Session extends EventEmitter {
  readonly id: string
  readonly design: Design
  readonly designId: string | null
  phase: Phase = "starting"
  step = "Checking the design"
  log: string[] = []
  error: string | null = null
  readonly startedAt = Date.now()
  readyMs: number | null = null
  rate = 0
  rampState: RampState | null = null
  samples: Sample[] = []

  #store: Store
  #runtime: Runtime
  #abort = new AbortController()
  #starting: Promise<void> | null = null
  #rampAbort: AbortController | null = null
  #rampOptions: { settle?: number; hold?: number }
  #waiters: { count: number; got: Sample[]; resolve: (s: Sample[]) => void; reject: (e: Error) => void }[] = []

  constructor(
    options: { store: Store; runtime: (id: string) => Runtime; ramp?: { settle?: number; hold?: number } },
    design: Design,
    designId: string | null,
  ) {
    super()
    this.id = newId()
    this.#store = options.store
    this.#runtime = options.runtime(this.id)
    this.#rampOptions = options.ramp ?? {}
    this.design = design
    this.designId = designId
  }

  view(): SessionView {
    return {
      id: this.id,
      designId: this.designId,
      design: this.design,
      phase: this.phase,
      step: this.step,
      log: this.log.slice(-60),
      error: this.error,
      startedAt: this.startedAt,
      readyMs: this.readyMs,
      containers: containerCount(this.design),
      rate: this.rate,
      ramp: this.rampState,
    }
  }

  #changed() {
    this.emit("state", this.view())
  }

  #say(step: string) {
    this.step = step
    this.#log(step)
    this.#changed()
  }

  #log(line: string) {
    this.log.push(line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").slice(0, 300))
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400)
  }

  start() {
    // A run stopped before it started stays stopped.
    if (this.#abort.signal.aborted) return Promise.resolve()
    this.#starting ??= this.#start()
    return this.#starting
  }

  async #start() {
    const signal = this.#abort.signal
    try {
      const issues = validate(this.design)
      if (!canRun(issues)) throw new Error(issues.find((issue) => issue.level === "error")!.message)
      await this.#runtime.start(
        (step) => this.#say(step),
        (line) => {
          this.#log(line)
          this.#changed()
        },
        signal,
      )
      if (signal.aborted) return
      void this.#pollSamples()
      this.readyMs = Date.now() - this.startedAt
      this.phase = "ready"
      this.#say(`Running ${containerCount(this.design)} containers`)
    } catch (error) {
      if (signal.aborted) return
      this.phase = "failed"
      this.error = error instanceof Error ? error.message : String(error)
      this.#log(this.error)
      this.#changed()
      await this.#runtime.stop().catch(() => {})
    }
  }

  async #pollSamples() {
    let after = 0
    const signal = this.#abort.signal
    while (!signal.aborted) {
      try {
        const batch = await this.#runtime.samples(after, signal)
        for (const sample of batch) {
          after = Math.max(after, sample.seq)
          sample.usage = this.#runtime.usage()
          this.samples.push(sample)
          if (this.samples.length > KEEP_SAMPLES) this.samples.splice(0, this.samples.length - KEEP_SAMPLES)
          this.emit("sample", sample)
          for (const waiter of [...this.#waiters]) {
            waiter.got.push(sample)
            if (waiter.got.length >= waiter.count) {
              this.#waiters.splice(this.#waiters.indexOf(waiter), 1)
              waiter.resolve(waiter.got)
            }
          }
        }
      } catch {
        if (signal.aborted) return
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }

  next(count: number, signal?: AbortSignal) {
    return new Promise<Sample[]>((resolve, reject) => {
      if (count <= 0) return resolve([])
      if (signal?.aborted) return reject(new Error("aborted"))
      const waiter = { count, got: [] as Sample[], resolve, reject }
      this.#waiters.push(waiter)
      signal?.addEventListener("abort", () => {
        const i = this.#waiters.indexOf(waiter)
        if (i >= 0) this.#waiters.splice(i, 1)
        reject(new Error("aborted"))
      })
    })
  }

  async setRate(rps: number) {
    if (this.phase !== "ready") throw new Error("The system isn't running.")
    if (this.rampState?.running) throw new Error("A test is running. Stop it first.")
    const rate = Math.max(0, Math.min(20_000, Math.round(rps)))
    await this.#runtime.setRate(rate)
    this.rate = rate
    this.#changed()
  }

  startRamp() {
    if (this.phase !== "ready") throw new Error("The system isn't running.")
    if (this.rampState?.running) throw new Error("A test is already running.")
    const abort = new AbortController()
    this.#rampAbort = abort
    const state: RampState = { testId: newId(), running: true, steps: [], current: null, startedAt: Date.now(), result: null }
    this.rampState = state
    this.#changed()
    const firstSeq = (this.samples.at(-1)?.seq ?? 0) + 1
    const driver = {
      setRate: async (rps: number) => {
        await this.#runtime.setRate(rps)
        this.rate = rps
      },
      next: (count: number, signal?: AbortSignal) => this.next(count, signal),
    }
    void ramp(this.design, driver, {
      ...this.#rampOptions,
      signal: AbortSignal.any([abort.signal, this.#abort.signal]),
      onStep: (step) => {
        if ("pending" in step) state.current = step.rate
        else state.steps.push(step)
        this.#changed()
      },
    })
      .then((result) => {
        state.result = result
        this.#saveTest(state, firstSeq)
      })
      .catch((error) => this.#log(`The test stopped: ${error instanceof Error ? error.message : error}`))
      .finally(() => {
        state.running = false
        state.current = null
        this.rate = 0
        this.#rampAbort = null
        this.#changed()
      })
  }

  stopRamp() {
    this.#rampAbort?.abort()
  }

  #saveTest(state: RampState, firstSeq: number) {
    if (!state.result || state.result.steps.length === 0) return
    this.#store.saveTest({
      id: state.testId,
      designId: this.designId,
      name: this.design.name,
      design: this.design,
      startedAt: state.startedAt,
      finishedAt: Date.now(),
      result: state.result,
    })
    this.#store.saveSamples(
      state.testId,
      this.samples.filter((s) => s.seq >= firstSeq),
    )
    this.emit("test", state.testId)
  }

  async stop() {
    if (this.phase === "stopped" || this.phase === "stopping") return
    const wasFailed = this.phase === "failed"
    this.phase = "stopping"
    this.#say("Stopping containers")
    this.#rampAbort?.abort()
    this.#abort.abort()
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error("stopped"))
    // Let a start still under way see the abort and finish first, or `down` could run before
    // `up` has made its containers and leave them behind.
    await this.#starting?.catch(() => {})
    await this.#runtime.stop().catch(() => {})
    this.phase = wasFailed ? "failed" : "stopped"
    this.step = "Stopped"
    this.#changed()
  }
}

/** Removes containers left behind if Redline was closed without stopping a run. */
export async function sweep(docker: Docker) {
  const containers = await docker.containers("redline.managed=true").catch(() => [])
  const projects = new Set(containers.map((c) => c.Labels["com.docker.compose.project"]).filter((p): p is string => !!p))
  for (const project of projects) await run("docker", ["compose", "-p", project, "down", "-v", "--remove-orphans", "-t", "1"], { timeoutMs: 120_000 })
  return projects.size
}
