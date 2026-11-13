import { mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { template } from "../shared/templates.ts"
import { App } from "./app.ts"
import { FakeDocker, FakeRuntime, fakeReader } from "./fake-runtime.ts"
import { Store } from "./store.ts"

let app: App
let store: Store
let dir: string
let base: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "redline-test-"))
  store = new Store(dir)
  const dist = mkdtempSync(join(tmpdir(), "redline-dist-"))
  const { writeFileSync } = await import("node:fs")
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Redline</title>")
  app = new App({
    store,
    docker: new FakeDocker(),
    reader: fakeReader(),
    port: 0,
    dist,
    runtime: (design) => new FakeRuntime(design, 20),
    ramp: { settle: 1, hold: 2 },
  })
  await app.listen()
  base = `http://127.0.0.1:${app.port}`
})

afterAll(async () => {
  await app.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function json(res: Response | Promise<Response>): Promise<any> {
  return (await res).json()
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
}

function raw(path: string, headers: Record<string, string>, method = "GET") {
  return new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: app.port, path, method, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on("error", reject)
    req.end()
  })
}

async function until<T>(check: () => Promise<T | undefined | null | false>, ms = 15_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error("timed out")
}

describe("guards", () => {
  it("answers only on its own host name", async () => {
    expect(await raw("/api/status", { Host: `127.0.0.1:${app.port}` })).toBe(200)
    expect(await raw("/api/status", { Host: `localhost:${app.port}` })).toBe(200)
    expect(await raw("/api/status", { Host: "attacker.example" })).toBe(403)
  })

  it("refuses changes from other sites and non-JSON bodies", async () => {
    expect((await post("/api/session", {}, { Origin: "https://evil.example" })).status).toBe(403)
    expect((await post("/api/session", {}, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403)
    const form = await fetch(base + "/api/session", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })
    expect(form.status).toBe(415)
  })

  it("explains a malformed request instead of crashing", async () => {
    const res = await post("/api/designs", { design: { name: "x" } })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toMatch(/expected shape/)
  })

  it("never serves files outside the page", async () => {
    const res = await fetch(base + "/..%2f..%2fserver/main.ts")
    expect(await res.text()).toContain("<title>Redline</title>")
  })
})

describe("designs and drawings", () => {
  it("saves, lists, loads and deletes a design", async () => {
    const id = "0123456789abcdef"
    expect((await post("/api/designs", { design: template("checkout"), id })).status).toBe(200)
    const list = await json(fetch(base + "/api/designs"))
    expect(list).toContainEqual(expect.objectContaining({ id, name: "Checkout", boxes: 6 }))
    expect((await json(fetch(`${base}/api/designs/${id}`))).design.nodes).toHaveLength(6)
    await fetch(`${base}/api/designs/${id}`, { method: "DELETE", headers: { "Content-Type": "application/json" } })
    expect((await fetch(`${base}/api/designs/${id}`)).status).toBe(404)
  })

  it("reads a photo into a design and keeps the photo", async () => {
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64")
    const res = await post("/api/read", { image: { data: pixel.toString("base64"), mediaType: "image/png", width: 1200, height: 800 } })
    expect(res.status).toBe(200)
    const reading = await json(res)
    expect(reading.design.nodes.map((n: { id: string }) => n.id)).toEqual(["users", "api", "redis", "postgres"])
    expect(reading.design.photo).toMatchObject({ width: 1200, height: 800 })
    const photo = await fetch(`${base}/api/photos/${reading.design.photo.id}`)
    expect(photo.headers.get("content-type")).toBe("image/png")
    expect(Buffer.from(await photo.arrayBuffer()).equals(pixel)).toBe(true)
  })

  it("turns a description into a laid-out design", async () => {
    const reading = await json(post("/api/read", { text: "users call an api backed by postgres and redis" }))
    expect(reading.design.photo).toBeUndefined()
    const x = (id: string) => reading.design.nodes.find((n: { id: string }) => n.id === id).x
    expect(x("users")).toBeLessThan(x("api"))
  })

  it("rejects an image that isn't base64", async () => {
    expect((await post("/api/read", { image: { data: "<script>alert(1)</script>", mediaType: "image/png", width: 100, height: 100 } })).status).toBe(400)
  })
})

describe("a run", () => {
  it("refuses a design that can't run, and says why", async () => {
    const design = template("url-shortener")
    design.nodes = design.nodes.filter((n) => n.kind !== "client")
    design.edges = design.edges.filter((e) => e.from !== "users")
    const res = await post("/api/session", { design })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toMatch(/Users box/)
  })

  it("starts, takes traffic, finds the breaking point and saves the test", async () => {
    const events: string[] = []
    const stream = await fetch(base + "/api/events")
    const reader = stream.body!.getReader()
    void (async () => {
      const decoder = new TextDecoder()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        events.push(decoder.decode(value))
      }
    })()

    const designId = "fedcba9876543210"
    const started = await json(post("/api/session", { design: template("url-shortener"), designId }))
    expect(started.phase).toBe("starting")
    await until(async () => (await json(fetch(base + "/api/session"))).phase === "ready")

    await post("/api/session/rate", { rps: 100 })
    const live = await until(async () => {
      const s = await json(fetch(base + "/api/session"))
      return s.samples.find((x: { rate: number }) => x.rate === 100)
    })
    expect(live.ok).toBe(100)
    expect(live.usage.api.limit).toBe(0.5)

    expect((await post("/api/session/ramp", {})).status).toBe(200)
    expect((await post("/api/session/ramp", {})).status).toBe(409)
    expect((await post("/api/session/rate", { rps: 10 })).status).toBe(409)
    const result = await until(async () => (await json(fetch(base + "/api/session"))).ramp?.result, 30_000)
    expect(result.capacity).toBeGreaterThan(200)
    expect(result.capacity).toBeLessThanOrEqual(400)
    expect(result.finding).toMatchObject({ nodeId: "api", pressure: "cpu" })

    const tests = await until(async () => {
      const list = await json(fetch(`${base}/api/tests?designId=${designId}`))
      return list.length ? list : null
    })
    expect(tests[0].result.capacity).toBe(result.capacity)
    const full = await json(fetch(`${base}/api/tests/${tests[0].id}`))
    expect(full.samples.length).toBeGreaterThan(5)

    const stopped = await json(fetch(base + "/api/session", { method: "DELETE", headers: { "Content-Type": "application/json" } }))
    expect(stopped.phase).toBe("stopped")
    await reader.cancel()
    const all = events.join("")
    expect(all).toContain("event: state")
    expect(all).toContain("event: sample")
    expect(all).toContain("event: test")
  })

  it("reports a box that won't start", async () => {
    const design = template("url-shortener")
    design.nodes[1]!.label = "fail to start"
    await post("/api/session", { design })
    const view = await until(async () => {
      const s = await json(fetch(base + "/api/session"))
      return s.phase === "failed" ? s : null
    })
    expect(view.error).toContain("didn't start")
  })
})
