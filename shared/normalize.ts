import { z } from "zod"
import { KINDS, edgeRole, type Kind } from "./catalog.ts"
import { DEFAULT_WORKLOAD, edgeId, uniqueId, type Design, type DesignEdge, type DesignNode } from "./design.ts"

export const NODE_WIDTH = 200
export const NODE_HEIGHT = 60

export const sketchSchema = z.object({
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
    name,
    nodes,
    edges,
    workload: { ...DEFAULT_WORKLOAD },
    ...(photo ? { photo } : {}),
  }
}

export function layout(design: Design): Design {
  const rank = new Map<string, number>()
  const client = design.nodes.find((node) => node.kind === "client")
  const order: string[] = []
  if (client) {
    rank.set(client.id, 0)
    order.push(client.id)
  }
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!
    for (const edge of design.edges) {
      if (edge.from !== id || rank.has(edge.to)) continue
      rank.set(edge.to, rank.get(id)! + 1)
      order.push(edge.to)
    }
  }
  for (const node of design.nodes) if (!rank.has(node.id)) rank.set(node.id, 0)

  const columns = new Map<number, DesignNode[]>()
  for (const node of design.nodes) {
    const r = rank.get(node.id)!
    columns.set(r, [...(columns.get(r) ?? []), node])
  }
  const placed = new Map<string, { x: number; y: number }>()
  for (const [r, column] of columns) {
    column.forEach((node, i) => {
      placed.set(node.id, { x: r * (NODE_WIDTH + 96), y: (i - (column.length - 1) / 2) * (NODE_HEIGHT + 64) })
    })
  }
  return { ...design, nodes: design.nodes.map((node) => ({ ...node, ...placed.get(node.id)! })) }
}
