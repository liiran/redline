import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { compile, projectName, PROBE_PORT } from "../shared/compile.ts"
import { nodeSettings, type Design } from "../shared/design.ts"
import type { Sample, Usage } from "../shared/samples.ts"
import { canRun, containerCount, validate } from "../shared/validate.ts"
import { compose, run, stream, type Docker } from "./docker.ts"
import { ensureImages } from "./images.ts"
import { ramp, type RampResult, type Step } from "./ramp.ts"
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

type Deps = { docker: Docker; store: Store; fetch?: typeof fetch }

const KEEP_SAMPLES = 900

export class Session extends EventEmitter {
  readonly id = newId()
  readonly design: Design
  readonly designId: string | null
  readonly project: string
  phase: Phase = "starting"
  step = "Checking the design"
  log: string[] = []
  error: string | null = null
  readonly startedAt = Date.now()
  readyMs: number | null = null
  rate = 0
  rampState: RampState | null = null
  samples: Sample[] = []

  #deps: Deps
  #file: string
  #probe = ""
  #abort = new AbortController()
  #rampAbort: AbortController | null = null
  #stopStats: (() => void)[] = []
  #usage = new Map<string, { node: string; cores: number; memoryMb: number }>()
  #waiters: { count: number; got: Sample[]; resolve: (s: Sample[]) => void; reject: (e: Error) => void }[] = []

  constructor(deps: Deps, design: Design, designId: string | null) {
    super()
    this.#deps = deps
    this.design = design
    this.designId = designId
    this.project = projectName(this.id)
    const dir = join(deps.store.dir, "runs", this.id)
    mkdirSync(dir, { recursive: true })
    this.#file = join(dir, "compose.json")
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

  async start() {
    const signal = this.#abort.signal
    try {
      const issues = validate(this.design)
      if (!canRun(issues)) throw new Error(issues.find((issue) => issue.level === "error")!.message)

      this.#say("Getting images ready")
      const tag = await ensureImages(this.#deps.docker, (line) => this.#log(line), signal)
      const compiled = compile(this.design, { runId: this.id, runtimeImage: tag })
      writeFileSync(this.#file, JSON.stringify(compiled.compose, null, 2))

      this.#say(`Starting ${containerCount(this.design)} containers`)
      const up = await stream(
        "docker",
        compose(this.project, this.#file, ["up", "-d", "--wait", "--wait-timeout", "180", "--quiet-pull"]),
        (line) => {
          this.#log(line)
          this.#changed()
        },
        { signal },
      )
      if (signal.aborted) return
      if (up !== 0) throw new Error(await this.#whyItFailed())

      const port = await run("docker", compose(this.project, this.#file, ["port", "probe", String(PROBE_PORT)]))
      const match = port.stdout.trim().match(/:(\d+)$/)
      if (!match) throw new Error("Redline couldn't find its load generator's port.")
      this.#probe = `http://127.0.0.1:${match[1]}`

      const seeded = this.design.nodes.some((node) => node.kind === "database")
      this.#say(seeded ? `Filling the database with ${this.design.workload.keys.toLocaleString("en-US")} rows` : "Getting ready")
      await this.#call("POST", "/prepare", undefined, 120_000)

      await this.#watchStats()
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
      await this.#down()
    }
  }

  async #whyItFailed() {
    const ps = await run("docker", compose(this.project, this.#file, ["ps", "-a", "--format", "{{.Service}}\t{{.State}}\t{{.Health}}"]))
    const bad = ps.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, state, health]) => state && (state !== "running" || (health && health !== "healthy")))
    if (!bad) return "The containers didn't start. The log below says why."
    const logs = await run("docker", compose(this.project, this.#file, ["logs", "--no-color", "--tail", "8", bad[0]!]))
    for (const line of logs.stdout.split("\n").filter(Boolean)) this.#log(line)
    return `“${this.design.nodes.find((n) => n.id === bad[0])?.label ?? bad[0]}” didn't start (${bad[1]}${bad[2] ? `, ${bad[2]}` : ""}).`
  }

  async #call(method: string, path: string, body?: unknown, timeoutMs = 10_000) {
    const doFetch = this.#deps.fetch ?? fetch
    const res = await doFetch(this.#probe + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(timeoutMs)]),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(text.trim() || `The load generator answered ${res.status}.`)
    return text ? JSON.parse(text) : null
  }

  async #watchStats() {
    const containers = await this.#deps.docker.containers(`redline.run=${this.id}`)
    for (const container of containers) {
      const node = container.Labels["redline.node"]
      if (!node) continue
      this.#usage.set(container.Id, { node, cores: 0, memoryMb: 0 })
      const stop = await this.#deps.docker.stats(container.Id, (cores, memoryMb) => {
        this.#usage.set(container.Id, { node, cores, memoryMb })
      })
      this.#stopStats.push(stop)
    }
  }

  #usageNow(): Record<string, Usage> {
    const out: Record<string, Usage> = {}
    for (const { node, cores, memoryMb } of this.#usage.values()) {
      const entry = out[node] ?? { cores: 0, limit: 0, memoryMb: 0, memoryLimitMb: 0, containers: 0 }
      entry.cores += cores
      entry.memoryMb += memoryMb
      entry.containers += 1
      out[node] = entry
    }
    for (const [id, entry] of Object.entries(out)) {
      const node = this.design.nodes.find((n) => n.id === id)
      if (node) {
        const settings = nodeSettings(node)
        entry.limit = settings.cpus * entry.containers
        entry.memoryLimitMb = settings.memoryMb * entry.containers
      } else if (id === "probe") {
        entry.limit = 2
        entry.memoryLimitMb = 1024
      }
      entry.cores = Math.round(entry.cores * 1000) / 1000
      entry.memoryMb = Math.round(entry.memoryMb)
    }
    return out
  }

  async #pollSamples() {
    let after = 0
    while (!this.#abort.signal.aborted) {
      try {
        const batch = (await this.#call("GET", `/samples?after=${after}&wait=2500`, undefined, 8_000)) as Sample[]
        for (const sample of batch) {
          after = Math.max(after, sample.seq)
          sample.usage = this.#usageNow()
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
        if (this.#abort.signal.aborted) return
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }

  next(count: number, signal?: AbortSignal) {
    return new Promise<Sample[]>((resolve, reject) => {
      if (count <= 0) return resolve([])
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
    const rate = Math.max(0, Math.min(20_000, Math.round(rps)))
    await this.#call("PUT", "/rate", { rps: rate })
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
        await this.#call("PUT", "/rate", { rps })
        this.rate = rps
      },
      next: (count: number, signal?: AbortSignal) => this.next(count, signal),
    }
    void ramp(this.design, driver, {
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
      .catch((error) => {
        this.#log(`The test stopped: ${error instanceof Error ? error.message : error}`)
      })
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
    const { store } = this.#deps
    store.saveTest({
      id: state.testId,
      designId: this.designId,
      name: this.design.name,
      design: this.design,
      startedAt: state.startedAt,
      finishedAt: Date.now(),
      result: state.result,
    })
    store.saveSamples(
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
    await this.#down()
    this.phase = wasFailed ? "failed" : "stopped"
    this.step = "Stopped"
    this.#changed()
  }

  async #down() {
    for (const stop of this.#stopStats.splice(0)) stop()
    await run("docker", compose(this.project, this.#file, ["down", "-v", "--remove-orphans", "-t", "2"]), { timeoutMs: 120_000 })
  }
}

/** Removes containers left behind if Redline was closed without stopping a run. */
export async function sweep(docker: Docker) {
  const containers = await docker.containers("redline.managed=true").catch(() => [])
  const projects = new Set(containers.map((c) => c.Labels["com.docker.compose.project"]).filter((p): p is string => !!p))
  for (const project of projects) await run("docker", ["compose", "-p", project, "down", "-v", "--remove-orphans", "-t", "1"], { timeoutMs: 120_000 })
  return projects.size
}
