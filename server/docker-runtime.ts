import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { compile, projectName, PROBE_PORT } from "../shared/compile.ts"
import { nodeSettings, type Design } from "../shared/design.ts"
import type { Sample, Usage } from "../shared/samples.ts"
import { PROBE_CPUS, containerCount } from "../shared/validate.ts"
import { compose, run, stream, type Docker } from "./docker.ts"
import { ensureImages } from "./images.ts"
import type { Runtime } from "./session.ts"

/** Runs a design as real containers: Docker Compose brings them up, the probe container drives and measures them. */
export class DockerRuntime implements Runtime {
  readonly project: string
  #docker: Docker
  #design: Design
  #runId: string
  #file: string
  #probe = ""
  #stopStats: (() => void)[] = []
  #usage = new Map<string, { node: string; cores: number; memoryMb: number }>()

  constructor(docker: Docker, design: Design, runId: string, dataDir: string) {
    this.#docker = docker
    this.#design = design
    this.#runId = runId
    this.project = projectName(runId)
    const dir = join(dataDir, "runs", runId)
    mkdirSync(dir, { recursive: true })
    this.#file = join(dir, "compose.json")
  }

  async start(say: (step: string) => void, log: (line: string) => void, signal: AbortSignal) {
    say("Getting images ready")
    const tag = await ensureImages(this.#docker, log, signal)
    const compiled = compile(this.#design, { runId: this.#runId, runtimeImage: tag })
    writeFileSync(this.#file, JSON.stringify(compiled.compose, null, 2))

    say(`Starting ${containerCount(this.#design)} containers`)
    const up = await stream("docker", compose(this.project, this.#file, ["up", "-d", "--wait", "--wait-timeout", "180", "--quiet-pull"]), log, { signal })
    if (signal.aborted) return
    if (up !== 0) throw new Error(await this.#whyItFailed(log))

    const port = await run("docker", compose(this.project, this.#file, ["port", "probe", String(PROBE_PORT)]))
    const match = port.stdout.trim().match(/:(\d+)$/)
    if (!match) throw new Error("Redline couldn't find its load generator's port.")
    this.#probe = `http://127.0.0.1:${match[1]}`

    const seeded = this.#design.nodes.some((node) => node.kind === "database")
    say(seeded ? `Filling the database with ${this.#design.workload.keys.toLocaleString("en-US")} rows` : "Getting ready")
    await this.#call("POST", "/prepare", undefined, 120_000, signal)
    await this.#watchStats()
  }

  async #whyItFailed(log: (line: string) => void) {
    const ps = await run("docker", compose(this.project, this.#file, ["ps", "-a", "--format", "{{.Service}}\t{{.State}}\t{{.Health}}"]))
    const bad = ps.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, state, health]) => state && (state !== "running" || (health && health !== "healthy")))
    if (!bad) return "The containers didn't start. The log below says why."
    const logs = await run("docker", compose(this.project, this.#file, ["logs", "--no-color", "--tail", "8", bad[0]!]))
    for (const line of logs.stdout.split("\n").filter(Boolean)) log(line)
    return `“${this.#design.nodes.find((n) => n.id === bad[0])?.label ?? bad[0]}” didn't start (${bad[1]}${bad[2] ? `, ${bad[2]}` : ""}).`
  }

  async #call(method: string, path: string, body?: unknown, timeoutMs = 10_000, signal?: AbortSignal) {
    const res = await fetch(this.#probe + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(text.trim() || `The load generator answered ${res.status}.`)
    return text ? JSON.parse(text) : null
  }

  async #watchStats() {
    const containers = await this.#docker.containers(`redline.run=${this.#runId}`)
    for (const container of containers) {
      const node = container.Labels["redline.node"]
      if (!node) continue
      this.#usage.set(container.Id, { node, cores: 0, memoryMb: 0 })
      const stop = await this.#docker.stats(container.Id, (cores, memoryMb) => this.#usage.set(container.Id, { node, cores, memoryMb }))
      this.#stopStats.push(stop)
    }
  }

  usage(): Record<string, Usage> {
    const out: Record<string, Usage> = {}
    for (const { node, cores, memoryMb } of this.#usage.values()) {
      const entry = out[node] ?? { cores: 0, limit: 0, memoryMb: 0, memoryLimitMb: 0, containers: 0 }
      entry.cores += cores
      entry.memoryMb += memoryMb
      entry.containers += 1
      out[node] = entry
    }
    for (const [id, entry] of Object.entries(out)) {
      const node = this.#design.nodes.find((n) => n.id === id)
      if (node) {
        const settings = nodeSettings(node)
        entry.limit = settings.cpus * entry.containers
        entry.memoryLimitMb = settings.memoryMb * entry.containers
      } else if (id === "probe") {
        entry.limit = PROBE_CPUS
        entry.memoryLimitMb = 1024
      }
      entry.cores = Math.round(entry.cores * 1000) / 1000
      entry.memoryMb = Math.round(entry.memoryMb)
    }
    return out
  }

  async setRate(rps: number) {
    await this.#call("PUT", "/rate", { rps })
  }

  async samples(after: number, signal: AbortSignal) {
    return (await this.#call("GET", `/samples?after=${after}&wait=2500`, undefined, 8_000, signal)) as Sample[]
  }

  async stop() {
    for (const stop of this.#stopStats.splice(0)) stop()
    await run("docker", compose(this.project, this.#file, ["down", "-v", "--remove-orphans", "-t", "2"]), { timeoutMs: 120_000 })
  }
}
