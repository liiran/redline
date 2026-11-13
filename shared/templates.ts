import type { Kind, Settings } from "./catalog.ts"
import { DEFAULT_WORKLOAD, edgeId, type Design, type Workload } from "./design.ts"

type Spec = {
  slug: string
  name: string
  summary: string
  nodes: [id: string, kind: Kind, label: string, col: number, row: number, settings?: Partial<Settings>][]
  edges: [from: string, to: string][]
  workload?: Partial<Workload>
}

const COL = 290
const ROW = 120

const SPECS: Spec[] = [
  {
    slug: "url-shortener",
    name: "URL shortener",
    summary: "One API in front of one database. Every click is a database read.",
    nodes: [
      ["users", "client", "Users", 0, 0],
      ["api", "service", "API", 1, 0],
      ["postgres", "database", "Postgres", 2, 0],
    ],
    edges: [
      ["users", "api"],
      ["api", "postgres"],
    ],
    workload: { readRatio: 0.95 },
  },
  {
    slug: "cached-feed",
    name: "Cached feed",
    summary: "A load balancer, two API copies and a cache in front of the database.",
    nodes: [
      ["users", "client", "Users", 0, 0],
      ["lb", "loadbalancer", "Load balancer", 1, 0],
      ["api", "service", "API", 2, 0, { replicas: 2 }],
      ["redis", "cache", "Redis", 3, -0.6],
      ["postgres", "database", "Postgres", 3, 0.6],
    ],
    edges: [
      ["users", "lb"],
      ["lb", "api"],
      ["api", "redis"],
      ["api", "postgres"],
    ],
  },
  {
    slug: "checkout",
    name: "Checkout",
    summary: "Orders write to the database, call a payments API and queue an email for a worker.",
    nodes: [
      ["users", "client", "Shoppers", 0, 0],
      ["orders", "service", "Orders API", 1, 0],
      ["payments", "external", "Payments", 2, -1, { latencyMs: 150 }],
      ["postgres", "database", "Postgres", 2, 0],
      ["jobs", "queue", "Email jobs", 2, 1],
      ["mailer", "worker", "Mailer", 3, 1],
    ],
    edges: [
      ["users", "orders"],
      ["orders", "payments"],
      ["orders", "postgres"],
      ["orders", "jobs"],
      ["jobs", "mailer"],
      ["mailer", "postgres"],
    ],
    workload: { readRatio: 0.3, sloP95Ms: 500 },
  },
  {
    slug: "microservices",
    name: "Microservices",
    summary: "A gateway routes to two services, one of which calls the other.",
    nodes: [
      ["users", "client", "Users", 0, 0],
      ["cdn", "cdn", "CDN", 1, 0],
      ["gateway", "loadbalancer", "Gateway", 2, 0],
      ["catalog", "service", "Catalog", 3, -0.6],
      ["pricing", "service", "Pricing", 4, -0.6],
      ["redis", "cache", "Redis", 4, 0.6],
      ["postgres", "database", "Postgres", 5, 0],
    ],
    edges: [
      ["users", "cdn"],
      ["cdn", "gateway"],
      ["gateway", "catalog"],
      ["catalog", "pricing"],
      ["catalog", "redis"],
      ["catalog", "postgres"],
      ["pricing", "postgres"],
    ],
  },
]

export type Template = { slug: string; name: string; summary: string; design: Design }

export const TEMPLATES: Template[] = SPECS.map((spec) => ({
  slug: spec.slug,
  name: spec.name,
  summary: spec.summary,
  design: {
    name: spec.name,
    nodes: spec.nodes.map(([id, kind, label, col, row, settings]) => ({
      id,
      kind,
      label,
      x: col * COL,
      y: Math.round(row * ROW),
      settings: settings ?? {},
    })),
    edges: spec.edges.map(([from, to]) => ({ id: edgeId(from, to), from, to })),
    workload: { ...DEFAULT_WORKLOAD, ...spec.workload },
  },
}))

export function template(slug: string) {
  const found = TEMPLATES.find((item) => item.slug === slug)
  if (!found) throw new Error(`No template called ${slug}`)
  return structuredClone(found.design)
}
