import { edgeRole } from "../shared/catalog.ts"
import { nodeSettings, type Design, type DesignNode } from "../shared/design.ts"
import type { Sketch } from "../shared/normalize.ts"
import type { NodeSample, Sample, Usage } from "../shared/samples.ts"
import { containerCount } from "../shared/validate.ts"
import { Docker } from "./docker.ts"
import type { Reader } from "./recognize.ts"
import type { Runtime } from "./session.ts"

/**
 * A stand-in for Docker, for tests of the server and the page only. It makes up plausible numbers
 * from a rough capacity model so a run, a test and a verdict can be exercised in seconds. Real runs
 * never use it: REDLINE_FAKE=1 has to be set on purpose.
 */
export class FakeRuntime implements Runtime {
  #design: Design
  #tickMs: number
  #rate = 0
  #seq = 0
  #samples: Sample[] = []
  #timer: ReturnType<typeof setInterval> | null = null
  #usage: Record<string, Usage> = {}

  constructor(design: Design, tickMs = 1000) {
    this.#design = design
    this.#tickMs = tickMs
  }

  async start(say: (step: string) => void, log: (line: string) => void, signal: AbortSignal) {
    const pause = () => new Promise((r) => setTimeout(r, Math.min(200, this.#tickMs)))
    say("Getting images ready")
    await pause()
    say(`Starting ${containerCount(this.#design)} containers`)
    log("(test mode: no containers are started)")
    await pause()
    if (this.#design.nodes.some((n) => n.label.toLowerCase().includes("fail to start"))) throw new Error("“fail to start” didn't start (exited, unhealthy).")
    say("Getting ready")
    await pause()
    if (signal.aborted) return
    this.#timer = setInterval(() => this.#tick(), this.#tickMs)
  }

  async setRate(rps: number) {
    this.#rate = rps
  }

  async samples(after: number, signal: AbortSignal) {
    const deadline = Date.now() + 2500
    while (!signal.aborted && Date.now() < deadline) {
      const out = this.#samples.filter((s) => s.seq > after)
      if (out.length) return out
      await new Promise((r) => setTimeout(r, Math.min(50, this.#tickMs / 2)))
    }
    return []
  }

  usage() {
    return this.#usage
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  #capacity(node: DesignNode) {
    const s = nodeSettings(node)
    switch (node.kind) {
      case "service":
        return (s.replicas * s.cpus * 1000) / (s.workMs + 0.25)
      case "worker":
        return (s.replicas * s.cpus * 1000) / (s.workMs + 0.5)
      case "database":
        return s.cpus * 3000
      case "cache":
      case "queue":
        return s.cpus * 40_000
      case "loadbalancer":
      case "cdn":
        return s.cpus * 8000
      default:
        return Infinity
    }
  }

  #tick() {
    const d = this.#design
    const rate = this.#rate
    const reads = d.workload.readRatio
    const byId = new Map(d.nodes.map((n) => [n.id, n]))
    const load = new Map<string, number>()
    const deps = new Map<string, Record<string, number>>()
    const add = (id: string, value: number) => load.set(id, (load.get(id) ?? 0) + value)
    const call = (from: string, to: string, value: number) => {
      const entry = deps.get(from) ?? {}
      entry[to] = (entry[to] ?? 0) + value
      deps.set(from, entry)
    }
    const visit = (node: DesignNode, value: number, depth: number) => {
      if (depth > 12 || value <= 0) return
      add(node.id, value)
      const outs = d.edges.filter((e) => e.from === node.id).map((e) => byId.get(e.to)!).filter((t) => t && edgeRole(node.kind, t.kind))
      const cached = outs.some((t) => t.kind === "cache")
      for (const target of outs) {
        const role = edgeRole(node.kind, target.kind)
        let share = value
        if (role === "traffic" || role === "upstream") share = value / outs.filter((t) => edgeRole(node.kind, t.kind) === role).length
        if (node.kind === "cdn") share *= 0.35
        if (role === "database") share = node.kind === "worker" ? value : value * (cached ? reads * 0.2 : reads) + value * (1 - reads)
        if (role === "produce") share = value * (1 - reads)
        if (node.kind !== "client") call(node.id, target.id, share)
        visit(target, share, depth + 1)
      }
    }
    const client = d.nodes.find((n) => n.kind === "client")
    if (client) visit(client, rate, 0)

    let worst = 0
    const usage: Record<string, Usage> = {}
    for (const node of d.nodes) {
      if (node.kind === "client") continue
      const s = nodeSettings(node)
      const u = (load.get(node.id) ?? 0) / this.#capacity(node)
      worst = Math.max(worst, u)
      usage[node.id] = {
        cores: Math.round(Math.min(1, u) * s.cpus * s.replicas * 1000) / 1000,
        limit: s.cpus * s.replicas,
        memoryMb: 40,
        memoryLimitMb: s.memoryMb * s.replicas,
        containers: s.replicas,
      }
    }
    this.#usage = usage

    const over = worst > 1
    const ok = over ? Math.round(rate / worst) : rate
    const base = 4 + d.nodes.filter((n) => n.kind === "external").reduce((sum, n) => sum + nodeSettings(n).latencyMs, 0)
    const p95 = over ? d.workload.timeoutMs : Math.min(d.workload.timeoutMs, base / Math.max(0.05, 1 - worst))
    const nodes: Record<string, NodeSample> = {}
    for (const node of d.nodes) {
      if (node.kind === "client") continue
      const value = Math.round(Math.min(load.get(node.id) ?? 0, this.#capacity(node)))
      const sample: NodeSample = { kind: node.kind, up: nodeSettings(node).replicas }
      const out = deps.get(node.id)
      if (out) sample.deps = Object.fromEntries(Object.entries(out).map(([id, calls]) => [id, { callsPs: Math.round(calls), avgMs: 1 }]))
      if (node.kind === "database") sample.tps = value
      else if (node.kind === "cache") Object.assign(sample, { opsPs: value, hitsPs: Math.round(value * 0.8), missesPs: Math.round(value * 0.2) })
      else if (node.kind === "queue") sample.backlog = 0
      else if (node.kind === "worker") sample.processedPs = value
      else Object.assign(sample, { rps: value, latency: { count: value, p50: p95 / 3, p95, p99: p95 * 1.2, max: p95 * 1.5 } })
      nodes[node.id] = sample
    }
    this.#samples.push({
      seq: ++this.#seq,
      t: Date.now(),
      rate,
      sent: rate,
      ok,
      errors: { timeout: rate - ok, conn: 0, server: 0, client: 0, dropped: 0 },
      failedBy: null,
      latency: { count: rate, p50: p95 / 3, p95, p99: p95 * 1.2, max: p95 * 1.5 },
      nodes,
    })
    if (this.#samples.length > 300) this.#samples.splice(0, this.#samples.length - 300)
  }
}

const FAKE_SKETCH: Sketch = {
  name: "cached API.",
  nodes: [
    { ref: "u", label: "Users", kind: "client", box: [79, 284, 161, 124], replicas: null },
    { ref: "a", label: "API", kind: "service", box: [417, 329, 203, 115], replicas: null },
    { ref: "r", label: "Redis", kind: "cache", box: [819, 177, 214, 108], replicas: null },
    { ref: "p", label: "Postgres", kind: "database", box: [828, 505, 203, 140], replicas: null },
  ],
  edges: [
    { from: "u", to: "a" },
    { from: "a", to: "r" },
    { from: "a", to: "p" },
  ],
}

/** Answers every drawing with the same four boxes, for tests of the page. */
export function fakeReader(): Reader {
  return {
    name: "cli",
    model: "test-reader",
    async read(input) {
      await new Promise((r) => setTimeout(r, 300))
      if (input.text?.includes("nothing")) return { sketch: { nodes: [], edges: [] }, model: "test-reader", costUsd: 0 }
      const sketch = structuredClone(FAKE_SKETCH)
      // A description also gets a CDN with no arrows, so tests see Redline join it up.
      if (input.text) sketch.nodes.push({ ref: "c", label: "Assets CDN", kind: "cdn", box: [0, 0, 0, 0], replicas: null })
      return { sketch, model: "test-reader", costUsd: 0 }
    },
  }
}

/** Reports a healthy Docker without asking one, for tests. */
export class FakeDocker extends Docker {
  override async info() {
    return { ok: true as const, cpus: 8, memoryGb: 16, version: "test", os: "test mode" }
  }
}
