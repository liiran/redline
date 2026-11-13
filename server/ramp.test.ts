import { describe, expect, it } from "vitest"
import { sample } from "../shared/fixtures.ts"
import type { Sample } from "../shared/samples.ts"
import { template } from "../shared/templates.ts"
import { judge, ramp, type Driver } from "./ramp.ts"

function fakeSystem(capacity: number): Driver & { rates: number[] } {
  let rate = 0
  let seq = 0
  const rates: number[] = []
  return {
    rates,
    async setRate(rps) {
      rate = rps
      rates.push(rps)
    },
    async next(count) {
      const out: Sample[] = []
      for (let i = 0; i < count; i++) {
        const over = rate > capacity
        out.push(
          sample({
            seq: ++seq,
            rate,
            ok: over ? capacity : rate,
            errors: { timeout: over ? rate - capacity : 0, conn: 0, server: 0, client: 0, dropped: 0 },
            latency: { count: rate, p50: over ? 900 : 4, p95: over ? 1900 : 9, p99: 20, max: 30 },
            nodes: { api: { rps: Math.min(rate, capacity) }, postgres: { kind: "database", tps: Math.min(rate, capacity) } },
            usage: { api: { cores: 0.1, limit: 0.5 }, postgres: { cores: Math.min(1, rate / capacity), limit: 1 } },
          }),
        )
      }
      return out
    },
  }
}

describe("judge", () => {
  it("passes a step that held its rate", () => {
    const window = [sample({ rate: 500, ok: 500 }), sample({ rate: 500, ok: 498 })]
    expect(judge(500, window, 250)).toMatchObject({ pass: true, answered: 499 })
  })

  it("fails on latency, errors or a shortfall, and says why", () => {
    const slow = judge(500, [sample({ ok: 500, latency: { count: 500, p50: 100, p95: 400, p99: 500, max: 600 } })], 250)
    expect(slow).toMatchObject({ pass: false })
    expect(slow.reason).toContain("over your 250 ms target")
    const failing = judge(500, [sample({ ok: 400, errors: { timeout: 100, conn: 0, server: 0, client: 0, dropped: 0 } })], 250)
    expect(failing.reason).toContain("20% of requests failed")
    expect(judge(500, [sample({ ok: 300 })], 250).reason).toContain("only 300 of 500")
  })
})

describe("ramp", () => {
  it("climbs until the system breaks, then narrows it down", async () => {
    const system = fakeSystem(830)
    const seen: number[] = []
    const result = await ramp(template("url-shortener"), system, { settle: 1, hold: 2, onStep: (s) => "pass" in s && seen.push(s.rate) })
    expect(seen.slice(0, 7)).toEqual([50, 100, 200, 300, 500, 750, 1000])
    expect(result.capacity).toBeGreaterThanOrEqual(750)
    expect(result.capacity).toBeLessThan(830)
    expect(result.failedAt).toBeGreaterThan(830)
    expect(result.finding).toMatchObject({ nodeId: "postgres", pressure: "cpu" })
    expect(result.suggestions[0]!.change.kind).toBe("add-cache")
    expect(system.rates.at(-1)).toBe(0)
  })

  it("reports a system that never broke", async () => {
    const result = await ramp(template("url-shortener"), fakeSystem(1e9), { settle: 0, hold: 1 })
    expect(result.failedAt).toBeNull()
    expect(result.capacity).toBe(20_000)
  })

  it("stops when cancelled and turns the traffic off", async () => {
    const system = fakeSystem(1e9)
    const controller = new AbortController()
    const driver: Driver = {
      setRate: system.setRate,
      async next(count, signal) {
        if (system.rates.length > 3) controller.abort()
        if (signal?.aborted) throw new Error("aborted")
        return system.next(count)
      },
    }
    const result = await ramp(template("url-shortener"), driver, { settle: 0, hold: 1, signal: controller.signal })
    expect(result.cancelled).toBe(true)
    expect(system.rates.at(-1)).toBe(0)
  })
})
