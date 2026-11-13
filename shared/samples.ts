export type Latency = { count: number; p50: number; p95: number; p99: number; max: number }

export type DepRate = { callsPs?: number; errorsPs?: number; avgMs?: number }

export type NodeSample = {
  kind: string
  up: number
  error?: string
  rps?: number
  errorsPs?: number
  inFlight?: number
  waiting?: number
  latency?: Latency
  deps?: Record<string, DepRate>
  hitsPs?: number
  missesPs?: number
  processedPs?: number
  failedPs?: number
  poolInUse?: number
  poolMax?: number
  poolWaitsPs?: number
  poolWaitMs?: number
  tps?: number
  active?: number
  conns?: number
  opsPs?: number
  memoryMb?: number
  backlog?: number
  length?: number
}

export type Usage = { cores: number; limit: number; memoryMb: number; memoryLimitMb: number; containers: number }

export type Sample = {
  seq: number
  t: number
  rate: number
  sent: number
  ok: number
  errors: { timeout: number; conn: number; server: number; client: number; dropped: number }
  failedBy?: Record<string, number> | null
  latency: Latency
  nodes: Record<string, NodeSample>
  usage?: Record<string, Usage>
}

export function errorCount(sample: Pick<Sample, "errors">) {
  const e = sample.errors
  return e.timeout + e.conn + e.server + e.client + e.dropped
}

export function errorRate(sample: Pick<Sample, "errors" | "ok">) {
  const errors = errorCount(sample)
  const total = errors + sample.ok
  return total === 0 ? 0 : errors / total
}
