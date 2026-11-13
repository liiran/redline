import { CATALOG, POSTGRES_MAX_CONNECTIONS, edgeRole } from "./catalog.ts"
import { nodeSettings, type Design, type DesignNode } from "./design.ts"

export type Issue = {
  level: "error" | "warning"
  message: string
  nodeId?: string
  edgeId?: string
  fix?: { kind: "flip-edge"; edgeId: string } | { kind: "add-client" }
}

export const PROBE_CPUS = 2
export const MAX_CONTAINERS = 32

export function containerCount(design: Design) {
  let count = 1
  for (const node of design.nodes) {
    if (CATALOG[node.kind].image === "none") continue
    count += nodeSettings(node).replicas
  }
  return count
}

export function cpuBudget(design: Design) {
  let total = PROBE_CPUS
  for (const node of design.nodes) total += nodeSettings(node).cpus * nodeSettings(node).replicas
  return Math.round(total * 100) / 100
}

/** How many connections the services and workers pointing at a database would open to it. */
export function connectionsTo(design: Design, databaseId: string) {
  let total = 0
  for (const edge of design.edges) {
    if (edge.to !== databaseId) continue
    const from = design.nodes.find((node) => node.id === edge.from)
    if (!from || (from.kind !== "service" && from.kind !== "worker")) continue
    const settings = nodeSettings(from)
    total += settings.replicas * settings.pool
  }
  return total
}

function name(node: DesignNode) {
  return `“${node.label}”`
}

export function validate(design: Design, hostCpus?: number): Issue[] {
  const issues: Issue[] = []
  const byId = new Map(design.nodes.map((node) => [node.id, node]))
  const clients = design.nodes.filter((node) => node.kind === "client")

  if (byId.size !== design.nodes.length) issues.push({ level: "error", message: "Two boxes share the same id." })

  if (clients.length === 0) {
    issues.push({ level: "error", message: "Add a Users box so Redline knows where traffic enters.", fix: { kind: "add-client" } })
  } else if (clients.length > 1) {
    for (const extra of clients.slice(1)) {
      issues.push({ level: "error", nodeId: extra.id, message: `Only one Users box is allowed. Remove ${name(extra)} or join its arrows to the first one.` })
    }
  }

  const seen = new Set<string>()
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()

  for (const edge of design.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) {
      issues.push({ level: "error", edgeId: edge.id, message: "An arrow points at a box that no longer exists." })
      continue
    }
    if (from.id === to.id) {
      issues.push({ level: "error", edgeId: edge.id, nodeId: from.id, message: `${name(from)} points at itself.` })
      continue
    }
    const key = `${from.id}\u0000${to.id}`
    if (seen.has(key)) {
      issues.push({ level: "warning", edgeId: edge.id, message: `There are two arrows from ${name(from)} to ${name(to)}. Only one is used.` })
      continue
    }
    seen.add(key)
    if (!edgeRole(from.kind, to.kind)) {
      const flippable = edgeRole(to.kind, from.kind) !== null
      issues.push({
        level: "error",
        edgeId: edge.id,
        message: flippable
          ? `The arrow between ${name(from)} and ${name(to)} points the wrong way.`
          : `A ${CATALOG[from.kind].title.toLowerCase()} can't send requests to a ${CATALOG[to.kind].title.toLowerCase()}.`,
        ...(flippable ? { fix: { kind: "flip-edge" as const, edgeId: edge.id } } : {}),
      })
      continue
    }
    outgoing.set(from.id, [...(outgoing.get(from.id) ?? []), to.id])
    incoming.set(to.id, [...(incoming.get(to.id) ?? []), from.id])
  }

  const roleCount = (node: DesignNode, role: string) =>
    (outgoing.get(node.id) ?? []).filter((target) => edgeRole(node.kind, byId.get(target)!.kind) === role).length

  for (const node of design.nodes) {
    const outs = outgoing.get(node.id) ?? []
    const ins = incoming.get(node.id) ?? []
    switch (node.kind) {
      case "client":
        if (outs.length === 0) issues.push({ level: "error", nodeId: node.id, message: `Draw an arrow from ${name(node)} to the box that takes their requests.` })
        break
      case "loadbalancer":
      case "cdn":
        if (roleCount(node, "upstream") === 0) issues.push({ level: "error", nodeId: node.id, message: `${name(node)} needs an arrow to the service it sends requests to.` })
        break
      case "worker":
        if (!ins.some((source) => byId.get(source)?.kind === "queue")) {
          issues.push({ level: "error", nodeId: node.id, message: `${name(node)} needs a queue to take jobs from. Draw an arrow from a queue to it.` })
        }
        break
      case "queue":
        if (outs.length === 0) issues.push({ level: "warning", nodeId: node.id, message: `Nothing reads from ${name(node)}, so its jobs will pile up.` })
        break
    }
  }

  const callGraph = new Map<string, string[]>()
  for (const node of design.nodes) {
    if (node.kind !== "service" && node.kind !== "loadbalancer") continue
    callGraph.set(
      node.id,
      (outgoing.get(node.id) ?? []).filter((target) => {
        const kind = byId.get(target)?.kind
        return kind === "service" || kind === "loadbalancer"
      }),
    )
  }
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): string | null => {
    state.set(id, 1)
    for (const next of callGraph.get(id) ?? []) {
      if (state.get(next) === 1) return next
      if (!state.has(next)) {
        const found = visit(next)
        if (found) return found
      }
    }
    state.set(id, 2)
    return null
  }
  for (const id of callGraph.keys()) {
    if (state.has(id)) continue
    const loop = visit(id)
    if (loop) {
      issues.push({ level: "error", nodeId: loop, message: `Requests would go round in a loop through ${name(byId.get(loop)!)}.` })
      break
    }
  }

  if (clients.length === 1) {
    const reached = new Set<string>([clients[0]!.id])
    const queue = [clients[0]!.id]
    while (queue.length) {
      for (const next of outgoing.get(queue.shift()!) ?? []) {
        if (!reached.has(next)) {
          reached.add(next)
          queue.push(next)
        }
      }
    }
    for (const node of design.nodes) {
      if (!reached.has(node.id)) {
        issues.push({ level: "warning", nodeId: node.id, message: `No traffic reaches ${name(node)}. It will run, but sit idle.` })
      }
    }
  }

  for (const database of design.nodes.filter((node) => node.kind === "database")) {
    const total = connectionsTo(design, database.id)
    if (total > POSTGRES_MAX_CONNECTIONS) {
      issues.push({
        level: "warning",
        nodeId: database.id,
        message: `The boxes using ${name(database)} would open ${total} connections, but it accepts ${POSTGRES_MAX_CONNECTIONS}. Requests past that fail. Use fewer replicas or database connections.`,
      })
    }
  }

  const containers = containerCount(design)
  if (containers > MAX_CONTAINERS) {
    issues.push({ level: "error", message: `This design needs ${containers} containers. Redline runs at most ${MAX_CONTAINERS}.` })
  }
  if (hostCpus && cpuBudget(design) > hostCpus) {
    issues.push({
      level: "warning",
      message: `The boxes ask for ${cpuBudget(design)} vCPU but Docker has ${hostCpus} cores. They will share, so results get noisier.`,
    })
  }

  return issues
}

export function canRun(issues: Issue[]) {
  return !issues.some((issue) => issue.level === "error")
}
