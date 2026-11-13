import type { NodeSample, Sample, Usage } from "./samples.ts"

type SampleInput = Omit<Partial<Sample>, "nodes" | "usage" | "errors" | "latency"> & {
  nodes?: Record<string, Partial<NodeSample>>
  usage?: Record<string, Partial<Usage>>
  errors?: Partial<Sample["errors"]>
  latency?: Partial<Sample["latency"]>
}

export function sample(partial: SampleInput = {}): Sample {
  const nodes: Record<string, NodeSample> = {}
  for (const [id, node] of Object.entries(partial.nodes ?? {})) nodes[id] = { kind: "service", up: 1, ...node }
  const usage: Record<string, Usage> = {}
  for (const [id, item] of Object.entries(partial.usage ?? {})) usage[id] = { cores: 0, limit: 1, memoryMb: 50, memoryLimitMb: 256, containers: 1, ...item }
  return {
    seq: partial.seq ?? 1,
    t: partial.t ?? 0,
    rate: partial.rate ?? 100,
    sent: partial.sent ?? partial.rate ?? 100,
    ok: partial.ok ?? partial.rate ?? 100,
    errors: { timeout: 0, conn: 0, server: 0, client: 0, dropped: 0, ...partial.errors },
    failedBy: partial.failedBy ?? null,
    latency: { count: 100, p50: 5, p95: 10, p99: 20, max: 30, ...partial.latency },
    nodes,
    usage,
  }
}
