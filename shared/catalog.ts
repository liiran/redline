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
  short: string
  /** What a box of this kind says under its name: short enough to always fit. */
  tag: string
  blurb: string
  runs: string
  image: "runtime" | "postgres" | "redis" | "none"
  defaults: Settings
  editable: SettingKey[]
  /** The settings shown up front; the rest of `editable` sits under "More settings". */
  primary: SettingKey[]
  /** Wording for this kind where the general one doesn't fit, like "CPU per job" for a worker. */
  labels?: Partial<Record<SettingKey, string>>
  hints?: Partial<Record<SettingKey, string>>
}

/** Postgres is started with this many connections allowed (its own default is 100). */
export const POSTGRES_MAX_CONNECTIONS = 300

const base: Settings = { cpus: 0.5, memoryMb: 128, replicas: 1, workMs: 0, pool: 0, ttlSec: 0, latencyMs: 0 }

export const CATALOG: Record<Kind, KindInfo> = {
  client: {
    tag: "Traffic source",
    short: "Traffic source",
    title: "Users",
    blurb: "Where the traffic comes from.",
    runs: "Redline's load generator",
    image: "none",
    defaults: { ...base, cpus: 0 },
    editable: [],
    primary: [],
  },
  cdn: {
    tag: "CDN · edge cache",
    short: "Edge cache",
    title: "CDN",
    blurb: "Keeps copies of responses close to users and answers repeat reads itself.",
    runs: "Redline edge cache (in-memory, LRU)",
    image: "runtime",
    defaults: { ...base, memoryMb: 256, ttlSec: 30 },
    editable: ["ttlSec", "cpus"],
    primary: ["ttlSec"],
    hints: {
      ttlSec: "How long the CDN keeps a copy before asking the service again, like Cache-Control: max-age.",
      cpus: "The CPU of Redline's stand-in. Real CDNs grow on their own, so raise this only if the CDN box itself turns red.",
    },
  },
  loadbalancer: {
    tag: "Load balancer",
    short: "Round robin",
    title: "Load balancer",
    blurb: "Spreads requests across every replica of the services behind it, in turn.",
    runs: "Redline reverse proxy (round robin)",
    image: "runtime",
    defaults: { ...base, memoryMb: 256 },
    editable: ["cpus"],
    primary: [],
    hints: {
      cpus: "The CPU of Redline's stand-in proxy. Managed load balancers grow on their own, so raise this only if this box turns red.",
    },
  },
  service: {
    tag: "Service",
    short: "Your code",
    title: "Service",
    blurb: "Your application code: it handles a request and talks to what it points at.",
    runs: "Redline service (Go)",
    image: "runtime",
    defaults: { ...base, memoryMb: 256, workMs: 1, pool: 10 },
    editable: ["replicas", "cpus", "workMs", "pool"],
    primary: ["replicas", "cpus", "workMs", "pool"],
  },
  worker: {
    tag: "Background worker",
    short: "Background jobs",
    title: "Worker",
    blurb: "Takes jobs off a queue and does the slow part in the background.",
    runs: "Redline worker (Go)",
    image: "runtime",
    defaults: { ...base, memoryMb: 256, workMs: 5, pool: 5 },
    editable: ["replicas", "cpus", "workMs", "pool"],
    primary: ["replicas", "cpus", "workMs", "pool"],
    labels: { workMs: "CPU per job" },
    hints: {
      replicas: "Identical workers. Each takes its own jobs off the queue, so more replicas drain it faster.",
      workMs: "CPU time your code spends on one job, not counting time spent waiting for the database or other services.",
    },
  },
  queue: {
    tag: "Job queue",
    short: "Redis Streams",
    title: "Queue",
    blurb: "Holds jobs until a worker picks them up.",
    runs: "Redis Streams",
    image: "redis",
    defaults: { ...base },
    editable: ["cpus"],
    primary: [],
    hints: { cpus: "The CPU of the Redis that holds the queue. It's rarely the limit." },
  },
  cache: {
    tag: "Redis cache",
    short: "Redis",
    title: "Cache",
    blurb: "Keeps hot data in memory so reads skip the database.",
    runs: "Redis",
    image: "redis",
    defaults: { ...base, memoryMb: 128, ttlSec: 60 },
    editable: ["ttlSec", "memoryMb", "cpus"],
    primary: ["ttlSec", "memoryMb"],
    hints: {
      ttlSec: "How long an item stays in the cache before it's read from the database again.",
      memoryMb: "Redis keeps data in up to 75% of this. When it's full, it drops the items read least recently.",
      cpus: "Redis runs commands on one core, so more than 1 vCPU barely helps.",
    },
  },
  database: {
    tag: "Postgres database",
    short: "PostgreSQL",
    title: "Database",
    blurb: "Stores the data. Every write lands here.",
    runs: "PostgreSQL",
    image: "postgres",
    defaults: { ...base, cpus: 1, memoryMb: 512 },
    editable: ["cpus"],
    primary: ["cpus"],
    hints: { cpus: "The size of the database machine. All its connections and queries share it." },
  },
  external: {
    tag: "Outside service",
    short: "Outside service",
    title: "External API",
    blurb: "A service you don't run, like payments or email. Redline stands in for it with a fixed delay.",
    runs: "Redline stand-in with a set delay",
    image: "runtime",
    defaults: { ...base, cpus: 0.25, latencyMs: 120 },
    editable: ["latencyMs"],
    primary: ["latencyMs"],
    hints: { latencyMs: "How long the outside service takes to answer. Payment APIs often take a few hundred milliseconds." },
  },
}

export type Choice = { value: number; label: string; note?: string }

export type SettingInfo = {
  label: string
  /** Shown after a value: "vCPU", "ms", "MB". */
  unit: string
  min: number
  max: number
  step: number
  hint: string
  /** Standard sizes to pick from. */
  choices?: Choice[]
}

export const SETTING_INFO: Record<SettingKey, SettingInfo> = {
  replicas: {
    label: "Replicas",
    unit: "",
    min: 1,
    max: 8,
    step: 1,
    hint: "Identical copies of this box. Requests are spread across them, so more replicas handle more traffic.",
  },
  cpus: {
    label: "CPU",
    unit: "vCPU",
    min: 0.25,
    max: 4,
    step: 0.25,
    hint: "The most CPU each replica may use, like a container's CPU limit. 1 vCPU is one core. These are the sizes cloud containers come in.",
    choices: [0.25, 0.5, 1, 2, 4].map((value) => ({ value, label: String(value) })),
  },
  memoryMb: {
    label: "Memory",
    unit: "MB",
    min: 64,
    max: 1024,
    step: 64,
    hint: "The most memory each replica may use.",
    choices: [
      { value: 64, label: "64 MB" },
      { value: 128, label: "128 MB" },
      { value: 256, label: "256 MB" },
      { value: 512, label: "512 MB" },
      { value: 1024, label: "1 GB" },
    ],
  },
  workMs: {
    label: "CPU per request",
    unit: "ms",
    min: 0.5,
    max: 50,
    step: 0.5,
    hint: "CPU time your code spends on one request, not counting time spent waiting for the database or other services.",
    choices: [
      { value: 0.5, label: "0.5", note: "Very light: hands data back almost as it is." },
      { value: 1, label: "1", note: "Light: a small JSON API in Go, Java or Node." },
      { value: 5, label: "5", note: "Moderate: real business logic, or a Python or Ruby framework." },
      { value: 20, label: "20", note: "Heavy: rendering pages or building large responses." },
      { value: 50, label: "50", note: "Very heavy: images, PDFs or number crunching." },
    ],
  },
  pool: {
    label: "Database connections",
    unit: "",
    min: 1,
    max: 100,
    step: 1,
    hint: "The connection pool: how many connections each replica keeps open to each database. Most libraries start at 10.",
  },
  ttlSec: {
    label: "Cache TTL",
    unit: "s",
    min: 1,
    max: 3600,
    step: 1,
    hint: "How long an item stays cached before it's fetched again.",
    choices: [
      { value: 5, label: "5 s" },
      { value: 30, label: "30 s" },
      { value: 60, label: "1 min" },
      { value: 300, label: "5 min" },
      { value: 3600, label: "1 h" },
    ],
  },
  latencyMs: {
    label: "Response time",
    unit: "ms",
    min: 1,
    max: 5000,
    step: 10,
    hint: "How long the outside service takes to answer.",
  },
}

/** A setting's name and explanation for one kind of box. */
export function settingText(kind: Kind, key: SettingKey) {
  const info = CATALOG[kind]
  return { label: info.labels?.[key] ?? SETTING_INFO[key].label, hint: info.hints?.[key] ?? SETTING_INFO[key].hint }
}

function trim(value: number) {
  return String(Math.round(value * 100) / 100)
}

/** A setting's value the way people write it: "0.5 vCPU", "1 min", "128 MB". */
export function formatSetting(key: SettingKey, value: number) {
  const choice = SETTING_INFO[key].choices?.find((c) => c.value === value)
  switch (key) {
    case "cpus":
      return `${trim(value)} vCPU`
    case "memoryMb":
      return choice?.label ?? (value >= 1024 ? `${trim(value / 1024)} GB` : `${trim(value)} MB`)
    case "ttlSec":
      return choice?.label ?? (value >= 3600 && value % 3600 === 0 ? `${value / 3600} h` : value >= 60 && value % 60 === 0 ? `${value / 60} min` : `${value} s`)
    case "workMs":
    case "latencyMs":
      return `${trim(value)} ms`
    default:
      return trim(value)
  }
}

/** The next standard size up or down from a value, or null at the end of the range. */
export function nextChoice(key: SettingKey, value: number, direction: 1 | -1) {
  const choices = SETTING_INFO[key].choices?.map((c) => c.value) ?? []
  const found = direction > 0 ? choices.find((c) => c > value + 1e-9) : [...choices].reverse().find((c) => c < value - 1e-9)
  return found ?? null
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
