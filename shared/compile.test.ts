import { describe, expect, it } from "vitest"
import { compile, IMAGES, projectName, type AgentConfig } from "./compile.ts"
import { template } from "./templates.ts"

const image = "redline-runtime:test"

function services(slug: string) {
  return compile(template(slug), { runId: "abc123", runtimeImage: image })
}

describe("compile", () => {
  it("runs real Postgres and Redis, and Redline's runtime for the rest", () => {
    const { compose } = services("cached-feed")
    const s = compose.services as Record<string, Record<string, unknown>>
    expect(Object.keys(s).sort()).toEqual(["api", "lb", "postgres", "probe", "redis"])
    expect(s.postgres!.image).toBe(IMAGES.postgres)
    expect(s.redis!.image).toBe(IMAGES.redis)
    expect(s.api!.image).toBe(image)
    expect(s.api!.deploy).toEqual({ replicas: 2 })
    expect(s.api!.cpus).toBe("0.5")
    expect(s.postgres!.cpus).toBe("1")
  })

  it("publishes only the probe, and only on loopback", () => {
    const { compose } = services("microservices")
    for (const [name, service] of Object.entries(compose.services as Record<string, Record<string, unknown>>)) {
      if (name === "probe") expect(service.ports).toEqual(["127.0.0.1::7000"])
      else expect(service.ports).toBeUndefined()
      expect(service.volumes).toBeUndefined()
      expect(service.privileged).toBeUndefined()
      expect((service.labels as Record<string, string>)["redline.managed"]).toBe("true")
    }
  })

  it("starts each box after what it depends on", () => {
    const { compose } = services("microservices")
    const s = compose.services as Record<string, { depends_on?: Record<string, unknown> }>
    expect(Object.keys(s.catalog!.depends_on!).sort()).toEqual(["postgres", "pricing", "redis"])
    expect(Object.keys(s.gateway!.depends_on!)).toEqual(["catalog"])
    expect(Object.keys(s.probe!.depends_on!).sort()).toEqual(["catalog", "cdn", "gateway", "postgres", "pricing", "redis"])
  })

  it("wires workers to their queue with a group of their own", () => {
    const { agents, probe } = services("checkout")
    const orders = agents.find((a) => a.id === "orders") as AgentConfig
    expect(orders.databases.map((d) => d.id)).toEqual(["postgres"])
    expect(orders.queues).toEqual([{ id: "jobs", addr: "jobs:6379", stream: "jobs" }])
    expect(orders.calls).toEqual([{ id: "payments", url: "http://payments:8080" }])
    const mailer = agents.find((a) => a.id === "mailer")!
    expect(mailer.mode).toBe("worker")
    expect(mailer.consume).toEqual([{ id: "jobs", addr: "jobs:6379", stream: "jobs", group: "mailer" }])
    expect(probe.nodes.find((n) => n.id === "jobs")).toMatchObject({ type: "redis", stream: "jobs", groups: ["mailer"] })
    expect(probe.targets).toEqual(["orders"])
  })

  it("gives the load balancer and CDN their upstreams", () => {
    const { agents } = services("microservices")
    expect(agents.find((a) => a.id === "cdn")).toMatchObject({ mode: "cdn", upstreams: ["gateway"], ttlSec: 30 })
    expect(agents.find((a) => a.id === "gateway")).toMatchObject({ mode: "lb", upstreams: ["catalog"] })
    expect(agents.find((a) => a.id === "catalog")!.caches).toEqual([{ id: "redis", addr: "redis:6379", ttlSec: 60 }])
  })

  it("puts the config in the environment as JSON the runtime can read", () => {
    const { compose, agents } = services("url-shortener")
    const api = (compose.services as Record<string, { environment: Record<string, string> }>).api!
    expect(JSON.parse(api.environment.REDLINE_CONFIG!)).toEqual(agents[0])
  })

  it("names projects safely", () => {
    expect(projectName("A1-b2_C3")).toBe("redline-a1b2c3")
  })
})
