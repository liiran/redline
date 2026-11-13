import { describe, expect, it } from "vitest"
import { compact, findBottleneck, ms, nodeHealth } from "./analyze.ts"
import { sample } from "./fixtures.ts"
import { applyChange, suggest } from "./suggest.ts"
import { template } from "./templates.ts"
import { canRun, validate } from "./validate.ts"

describe("formatting", () => {
  it("keeps numbers short", () => {
    expect(compact(1234)).toBe("1.2k")
    expect(compact(25_400)).toBe("25k")
    expect(compact(812.4)).toBe("812")
    expect(compact(2.25)).toBe("2.3")
    expect(ms(1530)).toBe("1.5 s")
    expect(ms(12)).toBe("12 ms")
  })
})

describe("node health", () => {
  const d = template("url-shortener")
  const db = d.nodes.find((n) => n.id === "postgres")!

  it("is idle before anything runs", () => {
    expect(nodeHealth(d, db, undefined).status).toBe("idle")
  })

  it("turns hot when CPU is nearly used up", () => {
    const s = sample({ nodes: { postgres: { kind: "database", tps: 900 } }, usage: { postgres: { cores: 0.95, limit: 1 } } })
    const health = nodeHealth(d, db, s)
    expect(health).toMatchObject({ status: "hot", pressure: "cpu" })
    expect(health.lines[0]).toBe("900 queries/s")
  })

  it("is down when a box stops answering", () => {
    const s = sample({ nodes: { postgres: { kind: "database", up: 0, error: "not answering" } } })
    expect(nodeHealth(d, db, s).status).toBe("down")
  })
})

describe("finding the bottleneck", () => {
  it("names the box that ran out of CPU", () => {
    const d = template("url-shortener")
    const window = [1, 2, 3].map((seq) =>
      sample({
        seq,
        nodes: { api: { rps: 800 }, postgres: { kind: "database", tps: 800 } },
        usage: { api: { cores: 0.3, limit: 0.5 }, postgres: { cores: 0.98, limit: 1 } },
      }),
    )
    const finding = findBottleneck(d, window)!
    expect(finding).toMatchObject({ nodeId: "postgres", pressure: "cpu" })
    expect(finding.title).toBe("“Postgres” ran out of CPU")
    expect(finding.detail).toContain("800 queries a second")
  })

  it("spots a service starved of database connections", () => {
    const d = template("url-shortener")
    const s = sample({ nodes: { api: { rps: 500, poolWaitsPs: 300, poolWaitMs: 40, poolInUse: 10, poolMax: 10 }, postgres: { kind: "database" } }, usage: { api: { cores: 0.2, limit: 0.5 } } })
    expect(findBottleneck(d, [s, s])).toMatchObject({ nodeId: "api", pressure: "connections" })
  })

  it("spots a queue that keeps growing", () => {
    const d = template("checkout")
    const window = [1000, 3000, 5000].map((backlog, i) =>
      sample({
        seq: i,
        nodes: { orders: { rps: 400, deps: { jobs: { callsPs: 400 } } }, jobs: { kind: "queue", backlog }, mailer: { kind: "worker", processedPs: 90 } },
        usage: { orders: { cores: 0.1, limit: 0.5 }, mailer: { cores: 0.2, limit: 0.5 } },
      }),
    )
    expect(findBottleneck(d, window)).toMatchObject({ nodeId: "jobs", pressure: "backlog" })
  })

  it("blames the dependency named in failed responses", () => {
    const d = template("checkout")
    const s = sample({ failedBy: { postgres: 120 }, errors: { timeout: 0, conn: 0, server: 120, client: 0, dropped: 0 } })
    expect(findBottleneck(d, [s])).toMatchObject({ nodeId: "postgres", pressure: "errors" })
  })

  it("calls out a slow outside service", () => {
    const d = template("checkout")
    const s = sample({ nodes: { payments: { kind: "external", latency: { count: 10, p50: 300, p95: 330, p99: 340, max: 350 } } } })
    expect(findBottleneck(d, [s])).toMatchObject({ nodeId: "payments", pressure: "slow-dependency" })
  })
})

describe("suggestions", () => {
  it("puts a cache in front of a read-heavy database, and the result still runs", () => {
    const d = template("url-shortener")
    const s = sample({ nodes: { postgres: { kind: "database", tps: 900 } }, usage: { postgres: { cores: 1, limit: 1 } } })
    const ideas = suggest(d, findBottleneck(d, [s]))
    expect(ideas[0]!.change).toEqual({ kind: "add-cache", databaseId: "postgres", serviceIds: ["api"] })
    const next = applyChange(d, ideas[0]!.change)
    expect(next.nodes.some((n) => n.kind === "cache")).toBe(true)
    expect(next.edges.some((e) => e.from === "api" && e.to === "redis")).toBe(true)
    expect(canRun(validate(next))).toBe(true)
    expect(d.nodes.some((n) => n.kind === "cache")).toBe(false)
  })

  it("adds copies to a CPU-bound service", () => {
    const d = template("url-shortener")
    const s = sample({ nodes: { api: { rps: 500 }, postgres: { kind: "database" } }, usage: { api: { cores: 0.5, limit: 0.5 } } })
    const ideas = suggest(d, findBottleneck(d, [s]))
    expect(ideas[0]).toMatchObject({ change: { kind: "set", nodeId: "api", key: "replicas" } })
    const value = (ideas[0]!.change as { value: number }).value
    expect(value).toBeGreaterThanOrEqual(2)
    expect(applyChange(d, ideas[0]!.change).nodes.find((n) => n.id === "api")!.settings.replicas).toBe(value)
  })

  it("adds workers when a queue falls behind", () => {
    const d = template("checkout")
    const ideas = suggest(d, { nodeId: "jobs", pressure: "backlog", load: 1, title: "", detail: "", also: [] })
    expect(ideas).toEqual([expect.objectContaining({ change: { kind: "set", nodeId: "mailer", key: "replicas", value: 2 } })])
  })

  it("has nothing to say without a finding", () => {
    expect(suggest(template("checkout"), null)).toEqual([])
  })
})
