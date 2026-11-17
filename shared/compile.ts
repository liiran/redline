import { CATALOG, POSTGRES_MAX_CONNECTIONS, edgeRole, type Kind } from "./catalog.ts"
import { nodeSettings, type Design, type DesignNode, type Workload } from "./design.ts"
import { PROBE_CPUS } from "./validate.ts"

export const IMAGES = {
  postgres: "postgres:17-alpine",
  redis: "redis:8-alpine",
} as const

export const AGENT_PORT = 8080
export const PROBE_PORT = 7000
const PG = { user: "redline", password: "redline", db: "redline" }

export type Mode = "service" | "worker" | "lb" | "cdn" | "external"

export type AgentConfig = {
  id: string
  mode: Mode
  port: number
  workMs: number
  ttlSec: number
  latencyMs: number
  timeoutMs: number
  payloadBytes: number
  upstreams: string[]
  databases: { id: string; dsn: string; pool: number }[]
  caches: { id: string; addr: string; ttlSec: number }[]
  queues: { id: string; addr: string; stream: string }[]
  consume: { id: string; addr: string; stream: string; group: string }[]
  calls: { id: string; url: string }[]
}

export type ProbeNode =
  | { id: string; kind: Kind; type: "agent"; host: string; port: number }
  | { id: string; kind: Kind; type: "postgres"; dsn: string }
  | { id: string; kind: Kind; type: "redis"; addr: string; stream?: string; groups?: string[] }

export type ProbeConfig = {
  port: number
  targets: string[]
  workload: Workload
  nodes: ProbeNode[]
}

export type Compiled = {
  project: string
  compose: Record<string, unknown>
  agents: AgentConfig[]
  probe: ProbeConfig
}

const STREAM = "jobs"

/**
 * A run's containers need each other and nothing else. They share a network with no way out to
 * the internet; only the load generator also joins a second network, so Redline can reach it on
 * 127.0.0.1. No container can gain privileges, and each has a process limit.
 */
const RUN_NETWORK = "run"
const EDGE_NETWORK = "edge"
const LOCKED = { security_opt: ["no-new-privileges:true"], pids_limit: 1024 }
/** Postgres's and Redis's start scripts hand the data folder to their own user, then switch to it: only that is allowed. */
const DATA_CAPS = { cap_drop: ["ALL"], cap_add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"] }
/** Redline's own program needs no privileges at all and writes no files. */
const RUNTIME_CAPS = { cap_drop: ["ALL"], read_only: true }

function dsn(id: string) {
  return `postgres://${PG.user}:${PG.password}@${id}:5432/${PG.db}?sslmode=disable`
}

function modeOf(kind: Kind): Mode | null {
  switch (kind) {
    case "service":
      return "service"
    case "worker":
      return "worker"
    case "loadbalancer":
      return "lb"
    case "cdn":
      return "cdn"
    case "external":
      return "external"
    default:
      return null
  }
}

function cpus(value: number) {
  return String(Math.round(value * 100) / 100)
}

export function projectName(runId: string) {
  return `redline-${runId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}`
}

export function compile(design: Design, options: { runId: string; runtimeImage: string }): Compiled {
  const byId = new Map(design.nodes.map((node) => [node.id, node]))
  const outgoing = (node: DesignNode) =>
    design.edges
      .filter((edge) => edge.from === node.id)
      .map((edge) => byId.get(edge.to))
      .filter((target): target is DesignNode => !!target && edgeRole(node.kind, target.kind) !== null)
  const incoming = (node: DesignNode) =>
    design.edges
      .filter((edge) => edge.to === node.id)
      .map((edge) => byId.get(edge.from))
      .filter((source): source is DesignNode => !!source && edgeRole(source.kind, node.kind) !== null)

  const labels = (nodeId: string) => ({
    "redline.managed": "true",
    "redline.run": options.runId,
    "redline.node": nodeId,
  })

  const services: Record<string, Record<string, unknown>> = {}
  const agents: AgentConfig[] = []
  const probeNodes: ProbeNode[] = []

  for (const node of design.nodes) {
    const settings = nodeSettings(node)
    const limits = { cpus: cpus(settings.cpus), mem_limit: `${settings.memoryMb}m` }
    const info = CATALOG[node.kind]

    if (info.image === "postgres") {
      services[node.id] = {
        image: IMAGES.postgres,
        environment: { POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db },
        command: ["postgres", "-c", `max_connections=${POSTGRES_MAX_CONNECTIONS}`, "-c", "shared_buffers=128MB", "-c", "fsync=on"],
        healthcheck: { test: ["CMD-SHELL", `pg_isready -U ${PG.user} -d ${PG.db}`], interval: "1s", timeout: "3s", retries: 60 },
        labels: labels(node.id),
        networks: [RUN_NETWORK],
        ...LOCKED,
        ...DATA_CAPS,
        ...limits,
      }
      probeNodes.push({ id: node.id, kind: node.kind, type: "postgres", dsn: dsn(node.id) })
      continue
    }

    if (info.image === "redis") {
      const queue = node.kind === "queue"
      const maxmemory = Math.max(16, Math.floor(settings.memoryMb * 0.75))
      services[node.id] = {
        image: IMAGES.redis,
        command: [
          "redis-server",
          "--save",
          "",
          "--appendonly",
          "no",
          "--maxmemory",
          `${maxmemory}mb`,
          "--maxmemory-policy",
          queue ? "noeviction" : "allkeys-lru",
        ],
        healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: "1s", timeout: "3s", retries: 60 },
        labels: labels(node.id),
        networks: [RUN_NETWORK],
        ...LOCKED,
        ...DATA_CAPS,
        ...limits,
      }
      probeNodes.push(
        queue
          ? {
              id: node.id,
              kind: node.kind,
              type: "redis",
              addr: `${node.id}:6379`,
              stream: STREAM,
              groups: outgoing(node).filter((target) => target.kind === "worker").map((target) => target.id),
            }
          : { id: node.id, kind: node.kind, type: "redis", addr: `${node.id}:6379` },
      )
      continue
    }

    const mode = modeOf(node.kind)
    if (!mode) continue

    const targets = outgoing(node)
    const config: AgentConfig = {
      id: node.id,
      mode,
      port: AGENT_PORT,
      workMs: settings.workMs,
      ttlSec: settings.ttlSec,
      latencyMs: settings.latencyMs,
      timeoutMs: design.workload.timeoutMs,
      payloadBytes: design.workload.payloadBytes,
      upstreams: mode === "lb" || mode === "cdn" ? targets.map((target) => target.id) : [],
      databases: [],
      caches: [],
      queues: [],
      consume: [],
      calls: [],
    }
    if (mode === "service" || mode === "worker") {
      for (const target of targets) {
        const role = edgeRole(node.kind, target.kind)
        if (role === "database") config.databases.push({ id: target.id, dsn: dsn(target.id), pool: settings.pool })
        if (role === "cache") config.caches.push({ id: target.id, addr: `${target.id}:6379`, ttlSec: nodeSettings(target).ttlSec })
        if (role === "produce") config.queues.push({ id: target.id, addr: `${target.id}:6379`, stream: STREAM })
        if (role === "call") config.calls.push({ id: target.id, url: `http://${target.id}:${AGENT_PORT}` })
      }
    }
    if (mode === "worker") {
      for (const source of incoming(node)) {
        if (source.kind === "queue") config.consume.push({ id: source.id, addr: `${source.id}:6379`, stream: STREAM, group: node.id })
      }
    }
    agents.push(config)

    const dependsOn = Object.fromEntries(
      [...targets, ...(mode === "worker" ? incoming(node).filter((source) => source.kind === "queue") : [])].map((dep) => [
        dep.id,
        { condition: "service_healthy" },
      ]),
    )
    services[node.id] = {
      image: options.runtimeImage,
      command: ["agent"],
      environment: { REDLINE_CONFIG: JSON.stringify(config) },
      healthcheck: { test: ["CMD", "/redline", "health"], interval: "1s", timeout: "3s", retries: 60 },
      labels: labels(node.id),
      networks: [RUN_NETWORK],
      ...LOCKED,
      ...RUNTIME_CAPS,
      ...(settings.replicas > 1 ? { deploy: { replicas: settings.replicas } } : {}),
      ...(Object.keys(dependsOn).length ? { depends_on: dependsOn } : {}),
      ...limits,
    }
    probeNodes.push({ id: node.id, kind: node.kind, type: "agent", host: node.id, port: AGENT_PORT })
  }

  const client = design.nodes.find((node) => node.kind === "client")
  const probe: ProbeConfig = {
    port: PROBE_PORT,
    targets: client ? outgoing(client).map((target) => target.id) : [],
    workload: design.workload,
    nodes: probeNodes,
  }
  services.probe = {
    image: options.runtimeImage,
    command: ["probe"],
    environment: { REDLINE_CONFIG: JSON.stringify(probe) },
    ports: [`127.0.0.1::${PROBE_PORT}`],
    healthcheck: { test: ["CMD", "/redline", "health", String(PROBE_PORT)], interval: "1s", timeout: "3s", retries: 60 },
    labels: labels("probe"),
    networks: [RUN_NETWORK, EDGE_NETWORK],
    ...LOCKED,
    ...RUNTIME_CAPS,
    depends_on: Object.fromEntries(Object.keys(services).map((id) => [id, { condition: "service_healthy" }])),
    cpus: cpus(PROBE_CPUS),
    mem_limit: "1g",
  }

  const project = projectName(options.runId)
  return {
    project,
    compose: { name: project, services, networks: { [RUN_NETWORK]: { internal: true }, [EDGE_NETWORK]: {} } },
    agents,
    probe,
  }
}
