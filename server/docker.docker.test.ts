// Runs real containers. Needs Docker running; takes a few minutes the first time (images).
// npm run test:docker
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { findBottleneck } from "../shared/analyze.ts"
import { nodeSettings, type Design } from "../shared/design.ts"
import type { Sample } from "../shared/samples.ts"
import { applyChange } from "../shared/suggest.ts"
import { template } from "../shared/templates.ts"
import { Docker } from "./docker.ts"
import { DockerRuntime } from "./docker-runtime.ts"
import { Session } from "./session.ts"
import { Store } from "./store.ts"

const docker = new Docker()
let store: Store
let dir: string

beforeAll(async () => {
  const info = await docker.info()
  if (!info.ok) throw new Error(`Docker is needed for these tests: ${info.error}`)
  dir = mkdtempSync(join(tmpdir(), "redline-docker-"))
  store = new Store(dir)
})

afterAll(async () => {
  store?.close()
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

async function running(design: Design) {
  const session = new Session({ store, runtime: (id) => new DockerRuntime(docker, design, id, dir) }, design, null)
  await session.start()
  if (session.phase !== "ready") throw new Error(`didn't start: ${session.error}\n${session.log.slice(-15).join("\n")}`)
  return session
}

async function hold(session: Session, rps: number, seconds: number) {
  await session.setRate(rps)
  await session.next(2)
  const window = await session.next(seconds)
  await session.setRate(0)
  return window
}

function mean(values: number[]) {
  return values.reduce((a, b) => a + b, 0) / values.length
}

async function leftovers(runId: string) {
  return (await docker.containers(`redline.run=${runId}`)).length
}

describe("real containers", () => {
  it("runs the checkout system end to end: writes reach Postgres, jobs reach the worker", async () => {
    const session = await running(template("checkout"))
    try {
      expect(session.readyMs).toBeLessThan(180_000)
      const window = await hold(session, 50, 4)
      expect(mean(window.map((s) => s.ok))).toBeGreaterThan(45)
      const last = window.at(-1)!
      expect(last.errors.server + last.errors.timeout).toBe(0)
      expect(last.nodes.orders!.deps!.postgres!.callsPs).toBeGreaterThan(0)
      expect(last.nodes.orders!.deps!.payments!.avgMs).toBeGreaterThan(100)
      expect(mean(window.map((s) => s.nodes.mailer!.processedPs ?? 0))).toBeGreaterThan(20)
      expect(last.nodes.postgres!.tps).toBeGreaterThan(0)
      expect(last.usage!.orders!.limit).toBe(0.5)
      expect(last.latency.p50).toBeGreaterThan(140)
    } finally {
      await session.stop()
    }
    expect(await leftovers(session.id)).toBe(0)
  })

  it("serves repeat reads from the cache and spreads load over every copy", async () => {
    const session = await running(template("cached-feed"))
    try {
      const window = await hold(session, 200, 5)
      const last = window.at(-1)!
      const redis = last.nodes.redis!
      expect(redis.hitsPs! / (redis.hitsPs! + redis.missesPs!)).toBeGreaterThan(0.3)
      expect(last.nodes.api!.up).toBe(2)
      expect(last.usage!.api!.containers).toBe(2)
      expect(last.nodes.lb!.rps).toBeGreaterThan(150)
    } finally {
      await session.stop()
    }
  })

  it("finds the real bottleneck, and the suggested fix raises capacity", async () => {
    const design = template("url-shortener")
    const before = await running(design)
    let first: Sample[] = []
    try {
      first = await hold(before, 900, 4)
    } finally {
      await before.stop()
    }
    const finding = findBottleneck(design, first)
    expect(finding).toMatchObject({ nodeId: "api", pressure: "cpu" })
    const okBefore = mean(first.map((s) => s.ok))
    expect(okBefore).toBeLessThan(700)

    const fixed = applyChange(design, { kind: "set", nodeId: "api", key: "replicas", value: 3 })
    expect(nodeSettings(fixed.nodes.find((n) => n.id === "api")!).replicas).toBe(3)
    const after = await running(fixed)
    try {
      const second = await hold(after, 900, 4)
      expect(mean(second.map((s) => s.ok))).toBeGreaterThan(okBefore * 1.5)
    } finally {
      await after.stop()
    }
  })
})
