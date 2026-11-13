import { describe, expect, it } from "vitest"
import { edgeRole, settingsFor } from "./catalog.ts"
import { designSchema, slug, uniqueId, type Design } from "./design.ts"
import { fromSketch, guessKind, layout, orientEdges } from "./normalize.ts"
import { TEMPLATES, template } from "./templates.ts"
import { canRun, containerCount, cpuBudget, validate } from "./validate.ts"

function design(nodes: [string, Design["nodes"][number]["kind"]][], edges: [string, string][]): Design {
  return {
    name: "t",
    nodes: nodes.map(([id, kind], i) => ({ id, kind, label: id, x: i * 200, y: 0, settings: {} })),
    edges: edges.map(([from, to]) => ({ id: `${from}->${to}`, from, to })),
    workload: { readRatio: 0.9, keys: 1000, payloadBytes: 64, sloP95Ms: 250, timeoutMs: 2000 },
  }
}

describe("ids", () => {
  it("makes compose-safe ids from any label", () => {
    expect(slug("Orders API (v2)")).toBe("orders-api-v2")
    expect(slug("123 Postgres!")).toBe("postgres")
    expect(slug("数据库")).toBe("box")
    expect(slug("A very long label that keeps going and going")).toMatch(/^[a-z][a-z0-9-]{0,19}$/)
  })

  it("keeps ids unique and away from reserved names", () => {
    const taken = new Set<string>()
    expect(uniqueId("API", taken)).toBe("api")
    expect(uniqueId("api", taken)).toBe("api-2")
    expect(uniqueId("probe", taken)).toBe("probe-1")
  })
})

describe("catalog", () => {
  it("knows which arrows make sense", () => {
    expect(edgeRole("client", "loadbalancer")).toBe("traffic")
    expect(edgeRole("service", "database")).toBe("database")
    expect(edgeRole("queue", "worker")).toBe("consume")
    expect(edgeRole("database", "service")).toBeNull()
    expect(edgeRole("loadbalancer", "database")).toBeNull()
  })

  it("clamps settings and ignores ones a kind doesn't have", () => {
    expect(settingsFor("service", { replicas: 99, cpus: 0 })).toMatchObject({ replicas: 8, cpus: 0.1 })
    expect(settingsFor("database", { replicas: 3 }).replicas).toBe(1)
  })
})

describe("templates", () => {
  it.each(TEMPLATES.map((t) => [t.slug, t.design] as const))("%s is valid and runnable", (_, d) => {
    expect(designSchema.parse(d)).toBeTruthy()
    const issues = validate(d, 12)
    expect(issues.filter((i) => i.level === "error")).toEqual([])
    expect(canRun(issues)).toBe(true)
  })

  it("returns a copy", () => {
    const a = template("url-shortener")
    a.nodes[0]!.label = "changed"
    expect(template("url-shortener").nodes[0]!.label).toBe("Users")
  })
})

describe("validate", () => {
  it("asks for a Users box", () => {
    const issues = validate(design([["api", "service"], ["db", "database"]], [["api", "db"]]))
    expect(issues).toContainEqual(expect.objectContaining({ level: "error", fix: { kind: "add-client" } }))
  })

  it("offers to flip an arrow drawn backwards", () => {
    const issues = validate(design([["users", "client"], ["api", "service"], ["db", "database"]], [["users", "api"], ["db", "api"]]))
    expect(issues).toContainEqual(expect.objectContaining({ level: "error", fix: { kind: "flip-edge", edgeId: "db->api" } }))
  })

  it("rejects arrows that can never work", () => {
    const issues = validate(design([["users", "client"], ["lb", "loadbalancer"], ["db", "database"]], [["users", "lb"], ["lb", "db"]]))
    expect(issues.some((i) => i.level === "error" && i.message.includes("can't send requests"))).toBe(true)
  })

  it("needs a queue for every worker", () => {
    const issues = validate(design([["users", "client"], ["api", "service"], ["w", "worker"]], [["users", "api"]]))
    expect(issues.some((i) => i.nodeId === "w" && i.level === "error")).toBe(true)
  })

  it("catches request loops", () => {
    const issues = validate(design([["users", "client"], ["a", "service"], ["b", "service"]], [["users", "a"], ["a", "b"], ["b", "a"]]))
    expect(issues.some((i) => i.message.includes("loop"))).toBe(true)
  })

  it("warns about boxes no traffic reaches", () => {
    const issues = validate(design([["users", "client"], ["api", "service"], ["cache", "cache"]], [["users", "api"]]))
    expect(issues).toContainEqual(expect.objectContaining({ level: "warning", nodeId: "cache" }))
  })

  it("counts containers and CPU, and warns when Docker is too small", () => {
    const d = template("cached-feed")
    expect(containerCount(d)).toBe(6)
    expect(cpuBudget(d)).toBe(5)
    expect(validate(d, 4).some((i) => i.message.includes("CPU cores"))).toBe(true)
  })
})

describe("reading a sketch", () => {
  const sketch = {
    nodes: [
      { ref: "u", label: "Users", kind: "client" as const, box: [79, 284, 161, 124], replicas: null },
      { ref: "a", label: "API", kind: "service" as const, box: [417, 329, 203, 115], replicas: 3 },
      { ref: "r", label: "Redis", kind: "cache" as const, box: [819, 177, 214, 108], replicas: null },
      { ref: "p", label: "Postgres", kind: "database" as const, box: [828, 505, 203, 140], replicas: null },
    ],
    edges: [
      { from: "u", to: "a" },
      { from: "r", to: "a" },
      { from: "a", to: "p" },
      { from: "p", to: "a" },
    ],
  }

  it("turns boxes and arrows into a runnable design", () => {
    const d = fromSketch(sketch, { id: "0123456789abcdef", width: 1200, height: 800 })
    expect(d.nodes.map((n) => n.id)).toEqual(["users", "api", "redis", "postgres"])
    expect(d.edges.map((e) => e.id).sort()).toEqual(["api->postgres", "api->redis", "users->api"])
    expect(d.nodes.find((n) => n.id === "api")!.settings.replicas).toBe(3)
    expect(Math.abs(d.nodes[1]!.x + 100 - (417 + 203 / 2))).toBeLessThanOrEqual(1)
    expect(canRun(validate(d))).toBe(true)
  })

  it("adds Users when the drawing has none", () => {
    const d = fromSketch({ nodes: sketch.nodes.slice(1), edges: [{ from: "a", to: "p" }] })
    const client = d.nodes.find((n) => n.kind === "client")!
    expect(d.edges).toContainEqual(expect.objectContaining({ from: client.id, to: "api" }))
  })

  it("merges extra Users boxes and guesses unknown kinds from labels", () => {
    const d = fromSketch({
      nodes: [
        { ref: "1", label: "Mobile", kind: "client", box: [0, 0, 10, 10] },
        { ref: "2", label: "Web", kind: "client", box: [0, 100, 10, 10] },
        { ref: "3", label: "Kafka", kind: "unknown", box: [200, 0, 10, 10] },
        { ref: "4", label: "Gateway", kind: "unknown", box: [100, 0, 10, 10] },
      ],
      edges: [
        { from: "1", to: "4" },
        { from: "2", to: "4" },
      ],
    })
    expect(d.nodes.filter((n) => n.kind === "client")).toHaveLength(1)
    expect(d.nodes.find((n) => n.label === "Kafka")!.kind).toBe("queue")
    expect(d.edges).toHaveLength(1)
  })

  it("reads a worker's arrow to its queue as taking jobs from it", () => {
    const d = design([["q", "queue"], ["w", "worker"], ["db", "database"]], [])
    const edges = orientEdges(d.nodes, [{ from: "w", to: "q" }, { from: "db", to: "w" }])
    expect(edges.map((e) => e.id).sort()).toEqual(["q->w", "w->db"])
  })

  it("guesses kinds", () => {
    expect(guessKind("Postgres primary")).toBe("database")
    expect(guessKind("nginx")).toBe("loadbalancer")
    expect(guessKind("Stripe")).toBe("external")
    expect(guessKind("Billing")).toBe("service")
  })

  it("lays out a design from left to right", () => {
    const d = layout(template("checkout"))
    const x = (id: string) => d.nodes.find((n) => n.id === id)!.x
    expect(x("users")).toBeLessThan(x("orders"))
    expect(x("orders")).toBeLessThan(x("jobs"))
    expect(x("jobs")).toBeLessThan(x("mailer"))
  })
})
