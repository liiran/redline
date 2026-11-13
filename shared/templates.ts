import type { Kind, Settings } from "./catalog.ts"
import { DEFAULT_WORKLOAD, edgeId, type Design, type Workload } from "./design.ts"
import { layout } from "./normalize.ts"

type Spec = {
  slug: string
  name: string
  summary: string
  nodes: [id: string, kind: Kind, label: string, settings?: Partial<Settings>][]
  edges: [from: string, to: string][]
  workload?: Partial<Workload>
}

// Positions come from the same layout every design gets, so the examples look like what Redline draws.
const SPECS: Spec[] = [
  {
    slug: "url-shortener",
    name: "URL shortener",
    summary: "One API and one database.",
    nodes: [
      ["users", "client", "Users"],
      ["api", "service", "API"],
      ["postgres", "database", "Postgres"],
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
    summary: "API copies, Redis and Postgres.",
    nodes: [
      ["users", "client", "Users"],
      ["lb", "loadbalancer", "Load balancer"],
      ["api", "service", "API", { replicas: 2 }],
      ["redis", "cache", "Redis"],
      ["postgres", "database", "Postgres"],
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
    summary: "Payments, a database and an email queue.",
    nodes: [
      ["users", "client", "Shoppers"],
      ["orders", "service", "Orders API"],
      ["payments", "external", "Payments", { latencyMs: 150 }],
      ["postgres", "database", "Postgres"],
      ["jobs", "queue", "Email jobs"],
      ["mailer", "worker", "Mailer"],
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
    slug: "chat",
    name: "Chat app",
    summary: "Messages, presence and push alerts.",
    nodes: [
      ["users", "client", "Users"],
      ["lb", "loadbalancer", "Load balancer"],
      ["chat", "service", "Chat API", { replicas: 2 }],
      ["presence", "cache", "Presence"],
      ["messages", "database", "Messages DB"],
      ["push-jobs", "queue", "Push jobs"],
      ["pusher", "worker", "Push worker"],
      ["push", "external", "Push service", { latencyMs: 80 }],
    ],
    edges: [
      ["users", "lb"],
      ["lb", "chat"],
      ["chat", "presence"],
      ["chat", "messages"],
      ["chat", "push-jobs"],
      ["push-jobs", "pusher"],
      ["pusher", "push"],
    ],
    workload: { readRatio: 0.6 },
  },
  {
    slug: "video",
    name: "Video platform",
    summary: "A CDN in front, transcoding behind.",
    nodes: [
      ["users", "client", "Viewers"],
      ["cdn", "cdn", "Video CDN"],
      ["catalog", "service", "Catalog API"],
      ["cache", "cache", "Catalog cache"],
      ["db", "database", "Videos DB"],
      ["uploads", "queue", "Uploads"],
      ["transcoder", "worker", "Transcoder", { workMs: 15 }],
      ["storage", "external", "Object storage", { latencyMs: 60 }],
    ],
    edges: [
      ["users", "cdn"],
      ["cdn", "catalog"],
      ["catalog", "cache"],
      ["catalog", "db"],
      ["catalog", "uploads"],
      ["uploads", "transcoder"],
      ["transcoder", "storage"],
      ["transcoder", "db"],
    ],
    workload: { readRatio: 0.97 },
  },
  {
    slug: "online-store",
    name: "Online store",
    summary: "Three services, each with its own data.",
    nodes: [
      ["users", "client", "Shoppers"],
      ["cdn", "cdn", "CDN"],
      ["gateway", "loadbalancer", "Gateway"],
      ["catalog", "service", "Catalog"],
      ["cart", "service", "Cart"],
      ["orders", "service", "Orders"],
      ["catalog-cache", "cache", "Catalog cache"],
      ["catalog-db", "database", "Catalog DB"],
      ["carts", "cache", "Carts"],
      ["orders-db", "database", "Orders DB"],
      ["payments", "external", "Payments", { latencyMs: 150 }],
    ],
    edges: [
      ["users", "cdn"],
      ["cdn", "gateway"],
      ["gateway", "catalog"],
      ["gateway", "cart"],
      ["gateway", "orders"],
      ["catalog", "catalog-cache"],
      ["catalog", "catalog-db"],
      ["cart", "carts"],
      ["orders", "catalog"],
      ["orders", "orders-db"],
      ["orders", "payments"],
    ],
  },
  {
    slug: "battle-royale",
    name: "Battle royale backend",
    summary: "Shop, matchmaking and leaderboards.",
    nodes: [
      ["players", "client", "Players"],
      ["assets", "cdn", "Asset CDN"],
      ["gateway", "loadbalancer", "API gateway"],
      ["profile", "service", "Profile"],
      ["shop", "service", "Shop"],
      ["matchmaking", "service", "Matchmaking"],
      ["leaderboard", "service", "Leaderboard"],
      ["player-cache", "cache", "Player cache"],
      ["player-db", "database", "Player DB"],
      ["payments", "external", "Payments", { latencyMs: 150 }],
      ["results", "queue", "Match results"],
      ["results-worker", "worker", "Results worker"],
      ["ranks", "cache", "Leaderboard cache"],
    ],
    edges: [
      ["players", "assets"],
      ["players", "gateway"],
      ["assets", "shop"],
      ["gateway", "profile"],
      ["gateway", "shop"],
      ["gateway", "matchmaking"],
      ["gateway", "leaderboard"],
      ["profile", "player-cache"],
      ["profile", "player-db"],
      ["shop", "player-cache"],
      ["shop", "player-db"],
      ["shop", "payments"],
      ["matchmaking", "results"],
      ["results", "results-worker"],
      ["results-worker", "player-db"],
      ["results-worker", "ranks"],
      ["leaderboard", "ranks"],
    ],
    workload: { readRatio: 0.85 },
  },
]

export type Template = { slug: string; name: string; summary: string; design: Design }

export const TEMPLATES: Template[] = SPECS.map((spec) => ({
  slug: spec.slug,
  name: spec.name,
  summary: spec.summary,
  design: layout({
    name: spec.name,
    nodes: spec.nodes.map(([id, kind, label, settings]) => ({ id, kind, label, x: 0, y: 0, settings: settings ?? {} })),
    edges: spec.edges.map(([from, to]) => ({ id: edgeId(from, to), from, to })),
    workload: { ...DEFAULT_WORKLOAD, ...spec.workload },
  }),
}))

export function template(slug: string) {
  const found = TEMPLATES.find((item) => item.slug === slug)
  if (!found) throw new Error(`No template called ${slug}`)
  return structuredClone(found.design)
}
