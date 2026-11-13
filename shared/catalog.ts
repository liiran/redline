export const KINDS = ["client", "cdn", "loadbalancer", "service", "worker", "queue", "cache", "database", "external"] as const

export type Kind = (typeof KINDS)[number]

export type Settings = {
  cpus: number
  memoryMb: number
  replicas: number
  workMs: number
  pool: number
  ttlSec: number
  latencyMs: number
}

export type SettingKey = keyof Settings

export type KindInfo = {
  title: string
  blurb: string
  runs: string
  image: "runtime" | "postgres" | "redis" | "none"
  defaults: Settings
  editable: SettingKey[]
}

const base: Settings = { cpus: 0.5, memoryMb: 128, replicas: 1, workMs: 0, pool: 0, ttlSec: 0, latencyMs: 0 }

export const CATALOG: Record<Kind, KindInfo> = {
  client: {
    title: "Users",
    blurb: "Where the traffic comes from.",
    runs: "Redline's load generator",
    image: "none",
    defaults: { ...base, cpus: 0 },
    editable: [],
  },
  cdn: {
    title: "CDN",
    blurb: "Keeps copies of responses close to users and answers repeat reads itself.",
    runs: "Redline edge cache (in-memory, LRU)",
    image: "runtime",
    defaults: { ...base, memoryMb: 256, ttlSec: 30 },
    editable: ["cpus", "ttlSec"],
  },
  loadbalancer: {
    title: "Load balancer",
    blurb: "Spreads requests across every copy of the services behind it.",
    runs: "Redline reverse proxy (round robin)",
    image: "runtime",
    defaults: { ...base, memoryMb: 256 },
    editable: ["cpus"],
  },
  service: {
    title: "Service",
    blurb: "Your application code: it handles a request and talks to what it points at.",
    runs: "Redline service (Go)",
    image: "runtime",
    defaults: { ...base, memoryMb: 256, workMs: 1, pool: 10 },
    editable: ["replicas", "cpus", "workMs", "pool"],
  },
  worker: {
    title: "Worker",
    blurb: "Takes jobs off a queue and does the slow part in the background.",
    runs: "Redline worker (Go)",
    image: "runtime",
    defaults: { ...base, memoryMb: 256, workMs: 5, pool: 5 },
    editable: ["replicas", "cpus", "workMs", "pool"],
  },
  queue: {
    title: "Queue",
    blurb: "Holds jobs until a worker picks them up.",
    runs: "Redis Streams",
    image: "redis",
    defaults: { ...base },
    editable: ["cpus"],
  },
  cache: {
    title: "Cache",
    blurb: "Keeps hot data in memory so reads skip the database.",
    runs: "Redis",
    image: "redis",
    defaults: { ...base, memoryMb: 128, ttlSec: 60 },
    editable: ["cpus", "ttlSec"],
  },
  database: {
    title: "Database",
    blurb: "Stores the data. Every write lands here.",
    runs: "PostgreSQL",
    image: "postgres",
    defaults: { ...base, cpus: 1, memoryMb: 512 },
    editable: ["cpus"],
  },
  external: {
    title: "External API",
    blurb: "A service you don't run, like payments or email. Redline stands in for it with a fixed delay.",
    runs: "Redline stand-in with a set delay",
    image: "runtime",
    defaults: { ...base, cpus: 0.25, latencyMs: 120 },
    editable: ["latencyMs"],
  },
}

export const SETTING_INFO: Record<SettingKey, { label: string; unit: string; min: number; max: number; step: number; hint: string }> = {
  replicas: { label: "Copies", unit: "", min: 1, max: 8, step: 1, hint: "How many identical containers run this box." },
  cpus: { label: "CPU", unit: "cores", min: 0.1, max: 4, step: 0.1, hint: "The most CPU each container may use." },
  memoryMb: { label: "Memory", unit: "MB", min: 64, max: 2048, step: 64, hint: "The most memory each container may use." },
  workMs: { label: "Work per request", unit: "ms CPU", min: 0, max: 50, step: 0.5, hint: "CPU time your code spends on each request, besides waiting on others." },
  pool: { label: "Database connections", unit: "", min: 1, max: 100, step: 1, hint: "Connections each copy keeps open to each database." },
  ttlSec: { label: "Keep entries for", unit: "s", min: 1, max: 3600, step: 1, hint: "How long a cached answer stays fresh." },
  latencyMs: { label: "Response time", unit: "ms", min: 1, max: 5000, step: 1, hint: "How long the outside service takes to answer." },
}

export type Role = "traffic" | "upstream" | "database" | "cache" | "produce" | "consume" | "call"

const UPSTREAM_TARGETS: Kind[] = ["loadbalancer", "service"]
const CODE_TARGETS: Partial<Record<Kind, Role>> = {
  database: "database",
  cache: "cache",
  queue: "produce",
  service: "call",
  loadbalancer: "call",
  external: "call",
}

export function edgeRole(from: Kind, to: Kind): Role | null {
  switch (from) {
    case "client":
      return to === "cdn" || to === "loadbalancer" || to === "service" ? "traffic" : null
    case "cdn":
      return UPSTREAM_TARGETS.includes(to) ? "upstream" : null
    case "loadbalancer":
      return to === "service" ? "upstream" : null
    case "service":
    case "worker":
      return CODE_TARGETS[to] ?? null
    case "queue":
      return to === "worker" ? "consume" : null
    default:
      return null
  }
}

export function settingsFor(kind: Kind, overrides: Partial<Settings> = {}): Settings {
  const merged = { ...CATALOG[kind].defaults }
  for (const key of CATALOG[kind].editable) {
    const value = overrides[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      const info = SETTING_INFO[key]
      merged[key] = Math.min(info.max, Math.max(info.min, value))
    }
  }
  return merged
}
