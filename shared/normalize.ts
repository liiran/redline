import { Graph, layout as dagreLayout } from "@dagrejs/dagre"
import { z } from "zod"
import { KINDS, edgeRole, type Kind } from "./catalog.ts"
import { DEFAULT_WORKLOAD, edgeId, nodeSettings, uniqueId, type Design, type DesignEdge, type DesignNode } from "./design.ts"

export const NODE_WIDTH = 200
export const NODE_HEIGHT = 60

export const sketchSchema = z.object({
  name: z.string().max(200).nullish(),
  nodes: z
    .array(
      z.object({
        ref: z.string().min(1).max(60),
        label: z.string().max(60),
        kind: z.enum([...KINDS, "unknown"]),
        box: z.array(z.number()).length(4),
        replicas: z.number().int().min(1).max(50).nullish(),
      }),
    )
    .max(40),
  edges: z.array(z.object({ from: z.string(), to: z.string() })).max(120),
})

export type Sketch = z.infer<typeof sketchSchema>

const KEYWORDS: [Kind, RegExp][] = [
  ["client", /\b(users?|clients?|browsers?|mobile|customers?|visitors?|frontend|web ?app|people)\b/i],
  ["cdn", /\b(cdn|cloudfront|fastly|akamai|edge)\b/i],
  ["loadbalancer", /\b(lb|load ?balancer|alb|elb|nlb|nginx|haproxy|envoy|gateway|ingress|proxy|traefik)\b/i],
  ["worker", /\b(workers?|consumers?|jobs?|processors?|cron|background)\b/i],
  ["queue", /\b(queues?|kafka|sqs|rabbit(mq)?|pub ?sub|nats|streams?|message ?bus|kinesis|bull(mq)?)\b/i],
  ["cache", /\b(cache|redis|memcached?|valkey|elasticache)\b/i],
  ["database", /\b(db|database|postgres(ql)?|mysql|sql|mongo(db)?|dynamo(db)?|cassandra|aurora|rds|maria(db)?|sqlite|store|storage)\b/i],
  ["external", /\b(stripe|payments?|paypal|email|sendgrid|twilio|sms|third[- ]party|external|openai|s3)\b/i],
]

export function guessKind(label: string): Kind {
  for (const [kind, pattern] of KEYWORDS) if (pattern.test(label)) return kind
  return "service"
}

function cleanLabel(label: string, kind: Kind) {
  const text = label.replace(/\s+/g, " ").trim().slice(0, 40)
  if (text) return text
  return { client: "Users", cdn: "CDN", loadbalancer: "Load balancer", service: "Service", worker: "Worker", queue: "Queue", cache: "Cache", database: "Database", external: "External API" }[kind]
}

export function orientEdges(nodes: DesignNode[], raw: { from: string; to: string }[]): DesignEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const pairs: [string, string][] = []
  for (const { from, to } of raw) {
    const a = byId.get(from)
    const b = byId.get(to)
    if (!a || !b || a.id === b.id) continue
    if (edgeRole(a.kind, b.kind) === null && edgeRole(b.kind, a.kind) !== null) pairs.push([b.id, a.id])
    else pairs.push([a.id, b.id])
  }

  for (const worker of nodes.filter((node) => node.kind === "worker")) {
    const consumes = pairs.some(([from, to]) => to === worker.id && byId.get(from)?.kind === "queue")
    if (consumes) continue
    const index = pairs.findIndex(([from, to]) => from === worker.id && byId.get(to)?.kind === "queue")
    if (index >= 0) pairs[index] = [pairs[index]![1], pairs[index]![0]]
  }

  const seen = new Set<string>()
  const edges: DesignEdge[] = []
  for (const [from, to] of pairs) {
    const id = edgeId(from, to)
    if (seen.has(id)) continue
    seen.add(id)
    edges.push({ id, from, to })
  }
  return edges
}

export function fromSketch(sketch: Sketch, photo?: { id: string; width: number; height: number }, name = "Whiteboard sketch"): Design {
  const taken = new Set<string>()
  const refToId = new Map<string, string>()
  let nodes: DesignNode[] = []

  for (const item of sketch.nodes) {
    if (refToId.has(item.ref)) continue
    const kind = item.kind === "unknown" ? guessKind(item.label) : item.kind
    const label = cleanLabel(item.label, kind)
    const id = uniqueId(label, taken)
    refToId.set(item.ref, id)
    const [x, y, w, h] = item.box.map((value) => (Number.isFinite(value) ? value : 0)) as [number, number, number, number]
    const cx = x + Math.max(0, w) / 2
    const cy = y + Math.max(0, h) / 2
    nodes.push({
      id,
      kind,
      label,
      x: Math.round(cx - NODE_WIDTH / 2),
      y: Math.round(cy - NODE_HEIGHT / 2),
      settings: item.replicas && item.replicas > 1 && (kind === "service" || kind === "worker") ? { replicas: Math.min(8, item.replicas) } : {},
      box: [x, y, w, h],
    })
  }

  let rawEdges = sketch.edges
    .map((edge) => ({ from: refToId.get(edge.from) ?? "", to: refToId.get(edge.to) ?? "" }))
    .filter((edge) => edge.from && edge.to)

  const clients = nodes.filter((node) => node.kind === "client").sort((a, b) => a.x - b.x)
  if (clients.length > 1) {
    const keep = clients[0]!
    const drop = new Set(clients.slice(1).map((node) => node.id))
    rawEdges = rawEdges.map((edge) => ({ from: drop.has(edge.from) ? keep.id : edge.from, to: drop.has(edge.to) ? keep.id : edge.to }))
    nodes = nodes.filter((node) => !drop.has(node.id))
  }

  let edges = orientEdges(nodes, rawEdges)

  if (!nodes.some((node) => node.kind === "client")) {
    const hasIncoming = new Set(edges.map((edge) => edge.to))
    const entryKinds: Kind[] = ["cdn", "loadbalancer", "service"]
    let entries = nodes.filter((node) => entryKinds.includes(node.kind) && !hasIncoming.has(node.id))
    const front = entries.filter((node) => node.kind !== "service")
    if (front.length) entries = front
    if (entries.length) {
      const id = uniqueId("users", taken)
      const minX = Math.min(...entries.map((node) => node.x))
      const avgY = entries.reduce((sum, node) => sum + node.y, 0) / entries.length
      nodes.unshift({ id, kind: "client", label: "Users", x: minX - NODE_WIDTH - 80, y: Math.round(avgY), settings: {} })
      edges = [...entries.map((node) => ({ id: edgeId(id, node.id), from: id, to: node.id })), ...edges]
    }
  }

  return {
    name: cleanName(sketch.name, name),
    nodes,
    edges,
    workload: { ...DEFAULT_WORKLOAD },
    ...(photo ? { photo } : {}),
  }
}

/** A short title: no trailing punctuation, first letter capitalised, cut at a word. */
export function cleanName(name: string | null | undefined, fallback: string) {
  let text = (name ?? "").replace(/\s+/g, " ").trim().replace(/[.:;,!?-]+$/, "")
  if (!text) return fallback
  if (text.length > 48) text = text.slice(0, 48).replace(/\s+\S*$/, "")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const FILLER = new Set(["the", "and", "for", "with", "service", "server", "svc", "api", "app", "backend", "database", "cache", "queue", "worker", "store"])

function words(label: string) {
  return new Set(
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((word) => word.replace(/(es|s)$/, ""))
      .filter((word) => word.length > 2 && !FILLER.has(word)),
  )
}

function affinity(a: DesignNode, b: DesignNode) {
  const left = words(a.label)
  let shared = 0
  for (const word of words(b.label)) if (left.has(word)) shared++
  return shared
}

// Who should send requests to a box that nothing reaches, most likely first.
const CALLERS: Partial<Record<Kind, Kind[]>> = {
  cdn: ["client"],
  loadbalancer: ["client", "cdn", "service"],
  service: ["loadbalancer", "client", "service", "cdn"],
  queue: ["service", "worker"],
  worker: ["queue"],
  cache: ["service", "worker"],
  database: ["service", "worker"],
  external: ["service", "worker"],
}
const FIX_ORDER: Kind[] = ["cdn", "loadbalancer", "service", "queue", "worker", "cache", "database", "external"]

function pick(target: DesignNode, candidates: DesignNode[], kinds: Kind[]) {
  const scored = candidates
    .filter((c) => c.id !== target.id && kinds.includes(c.kind))
    .map((c) => ({
      c,
      score: affinity(c, target) * 100 - kinds.indexOf(c.kind) * 10 - Math.hypot(c.x - target.x, c.y - target.y) / 1000,
    }))
    .sort((a, b) => b.score - a.score)
  return scored[0]?.c
}

/**
 * Makes sure every box takes part. A CDN or load balancer gets the service behind it, a worker gets its
 * queue, and a box nothing reaches gets an arrow from the most likely caller: one whose name shares a
 * word with it ("Skins CDN" → "Skins service"), otherwise the nearest box of a kind that would call it.
 */
export function connectAll(design: Design): { design: Design; added: DesignEdge[] } {
  const nodes = design.nodes
  const edges = [...design.edges]
  const added: DesignEdge[] = []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const valid = (e: DesignEdge) => {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    return !!a && !!b && edgeRole(a.kind, b.kind) !== null
  }
  const add = (from: DesignNode, to: DesignNode) => {
    const id = edgeId(from.id, to.id)
    if (edges.some((e) => e.id === id) || edgeRole(from.kind, to.kind) === null) return false
    const edge = { id, from: from.id, to: to.id }
    edges.push(edge)
    added.push(edge)
    return true
  }
  const outs = (node: DesignNode) => edges.filter((e) => e.from === node.id && valid(e)).map((e) => byId.get(e.to)!)
  const ins = (node: DesignNode) => edges.filter((e) => e.to === node.id && valid(e)).map((e) => byId.get(e.from)!)

  for (const node of nodes) {
    if (node.kind === "cdn" && !outs(node).some((n) => n.kind === "service" || n.kind === "loadbalancer")) {
      const target = pick(node, nodes, ["service", "loadbalancer"])
      const lb = nodes.find((n) => n.kind === "loadbalancer")
      const best = target && affinity(node, target) > 0 ? target : (lb ?? target)
      if (best) add(node, best)
    }
    if (node.kind === "loadbalancer" && !outs(node).some((n) => n.kind === "service")) {
      const free = nodes.filter((n) => n.kind === "service" && ins(n).length === 0)
      const target = pick(node, free.length ? free : nodes, ["service"])
      if (target) add(node, target)
    }
    if (node.kind === "worker" && !ins(node).some((n) => n.kind === "queue")) {
      const queue = pick(node, nodes, ["queue"])
      if (queue) add(queue, node)
    }
  }
  for (const queue of nodes.filter((n) => n.kind === "queue" && outs(n).length === 0)) {
    const idle = nodes.find((n) => n.kind === "worker" && !ins(n).some((m) => m.kind === "queue"))
    if (idle) add(queue, idle)
  }

  const client = nodes.find((node) => node.kind === "client")
  if (client) {
    for (let round = 0; round < nodes.length; round++) {
      const reached = new Set([client.id])
      const todo = [client.id]
      while (todo.length) {
        for (const e of edges) {
          if (e.from === todo[0] && valid(e) && !reached.has(e.to)) {
            reached.add(e.to)
            todo.push(e.to)
          }
        }
        todo.shift()
      }
      const lost = nodes.filter((n) => !reached.has(n.id) && n.kind !== "client")
      if (!lost.length) break
      // Fix the box at the front of each lost group first: its own callers may be lost too.
      const fronts = lost.filter((n) => !ins(n).some((m) => !reached.has(m.id)))
      const order = (fronts.length ? fronts : lost).sort((a, b) => FIX_ORDER.indexOf(a.kind) - FIX_ORDER.indexOf(b.kind))
      const fixed = order.some((node) => {
        const caller = pick(node, nodes.filter((n) => reached.has(n.id)), CALLERS[node.kind] ?? [])
        return caller ? add(caller, node) : false
      })
      if (!fixed) break
    }
  }
  return { design: added.length ? { ...design, edges } : design, added }
}

/**
 * Pushes overlapping boxes apart, each pair along whichever way they overlap least, until none overlap.
 * Boxes read from a photo sit where they were drawn; this keeps them there, only not on top of each other.
 */
export function separate(design: Design, gap = 16): Design {
  const nodes = design.nodes.map((node) => ({ ...node }))
  for (let pass = 0; pass < 60; pass++) {
    let moved = false
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!
        const b = nodes[j]!
        const dx = NODE_WIDTH + gap - Math.abs(a.x - b.x)
        const dy = NODE_HEIGHT + gap - Math.abs(a.y - b.y)
        if (dx <= 0 || dy <= 0) continue
        moved = true
        if (dx * NODE_HEIGHT < dy * NODE_WIDTH) {
          const push = Math.ceil(dx / 2) * (a.x <= b.x ? 1 : -1)
          a.x -= push
          b.x += push
        } else {
          const push = Math.ceil(dy / 2) * (a.y <= b.y ? 1 : -1)
          a.y -= push
          b.y += push
        }
      }
    }
    if (!moved) break
  }
  return { ...design, nodes }
}

export const COLUMN_GAP = 112
export const ROW_GAP = 36

/**
 * The column each box goes in: its step along the longest request path from the users, so the users
 * come first, then CDNs and gateways, then services, then what they call. Arrows that would loop
 * back are left out, and the arrows kept always run from one column to a later one.
 */
export function columns(design: Design) {
  const ids = new Set(design.nodes.map((node) => node.id))
  const out = new Map<string, string[]>()
  for (const edge of design.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to])
  }
  const incoming = new Set(design.edges.map((edge) => edge.to))
  const roots = [
    ...design.nodes.filter((node) => node.kind === "client"),
    ...design.nodes.filter((node) => node.kind !== "client" && !incoming.has(node.id)),
    ...design.nodes,
  ]
  const state = new Map<string, 1 | 2>()
  const forward: [string, string][] = []
  const visit = (id: string) => {
    state.set(id, 1)
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 1) continue
      forward.push([id, to])
      if (!state.has(to)) visit(to)
    }
    state.set(id, 2)
  }
  for (const root of roots) if (!state.has(root.id)) visit(root.id)

  const rank = new Map(design.nodes.map((node) => [node.id, 0]))
  const pending = new Map(design.nodes.map((node) => [node.id, 0]))
  for (const [, to] of forward) pending.set(to, pending.get(to)! + 1)
  const ready = design.nodes.filter((node) => pending.get(node.id) === 0).map((node) => node.id)
  while (ready.length) {
    const id = ready.shift()!
    for (const [from, to] of forward) {
      if (from !== id) continue
      rank.set(to, Math.max(rank.get(to)!, rank.get(id)! + 1))
      pending.set(to, pending.get(to)! - 1)
      if (pending.get(to) === 0) ready.push(to)
    }
  }
  return { rank, forward }
}

/** Lays boxes out left to right in the order requests flow, keeping crossings down. */
export function layout(design: Design): Design {
  if (design.nodes.length === 0) return design
  const { rank, forward } = columns(design)
  const g = new Graph()
  g.setGraph({ rankdir: "LR", nodesep: ROW_GAP, ranksep: COLUMN_GAP, edgesep: 18, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const node of design.nodes) {
    const copies = Math.min(2, nodeSettings(node).replicas - 1)
    g.setNode(node.id, { width: NODE_WIDTH + copies * 4, height: NODE_HEIGHT + copies * 4 })
  }
  // Each arrow must span at least its column difference. Every arrow then sits exactly at its minimum,
  // which is the cheapest ranking there is, so dagre's own ranker lands on these columns.
  for (const [from, to] of forward) g.setEdge(from, to, { weight: 1, minlen: rank.get(to)! - rank.get(from)! })
  dagreLayout(g)
  const placed = new Map<string, { x: number; y: number }>()
  for (const node of design.nodes) {
    const at = g.node(node.id)
    placed.set(node.id, { x: Math.round((at.x ?? 0) - NODE_WIDTH / 2), y: Math.round((at.y ?? 0) - NODE_HEIGHT / 2) })
  }
  return { ...design, nodes: design.nodes.map((node) => ({ ...node, ...placed.get(node.id)! })) }
}
