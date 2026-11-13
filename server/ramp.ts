import { findBottleneck, compact, ms, percent } from "../shared/analyze.ts"
import type { Design } from "../shared/design.ts"
import { errorCount, type Sample } from "../shared/samples.ts"
import { suggest } from "../shared/suggest.ts"
import type { RampResult, Step } from "../shared/results.ts"

export type { RampResult, Step }

export const LADDER = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12_000, 16_000, 20_000]

export type Driver = {
  setRate(rps: number): Promise<void>
  next(count: number, signal?: AbortSignal): Promise<Sample[]>
}

export type RampOptions = {
  settle?: number
  hold?: number
  refine?: number
  signal?: AbortSignal
  onStep?: (step: Step | { rate: number; pending: true }) => void
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0
}

export function judge(rate: number, window: Sample[], sloP95Ms: number): Step {
  const answered = mean(window.map((s) => s.ok))
  const counted = window.filter((s) => s.latency.count > 0)
  const p95 = counted.length ? mean(counted.map((s) => s.latency.p95)) : 0
  const errors = window.reduce((sum, s) => sum + errorCount(s), 0)
  const ok = window.reduce((sum, s) => sum + s.ok, 0)
  const errorRate = errors + ok === 0 ? 0 : errors / (errors + ok)
  const reasons: string[] = []
  if (errorRate > 0.01) reasons.push(`${percent(errorRate)} of requests failed`)
  if (p95 > sloP95Ms) reasons.push(`p95 was ${ms(p95)}, over your ${ms(sloP95Ms)} target`)
  if (answered < rate * 0.95 && reasons.length === 0) reasons.push(`only ${compact(answered)} of ${compact(rate)} req/s were answered`)
  return {
    rate,
    answered: Math.round(answered),
    p95: Math.round(p95 * 10) / 10,
    errorRate,
    pass: reasons.length === 0,
    reason: reasons.length ? reasons.join(", ") : `held ${compact(rate)} req/s at p95 ${ms(p95)}`,
  }
}

function between(low: number, high: number) {
  const mid = (low + high) / 2
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(mid)) - 1)
  return Math.round(mid / magnitude) * magnitude
}

export async function ramp(design: Design, driver: Driver, options: RampOptions = {}): Promise<RampResult> {
  const settle = options.settle ?? 2
  const hold = options.hold ?? 4
  const refine = options.refine ?? 2
  const steps: Step[] = []
  let lastPass: Step | null = null
  let fail: { step: Step; window: Sample[] } | null = null
  let lastWindow: Sample[] = []
  let probeLimited = false
  let cancelled = false

  const measure = async (rate: number) => {
    options.onStep?.({ rate, pending: true })
    await driver.setRate(rate)
    await driver.next(settle, options.signal)
    const window = await driver.next(hold, options.signal)
    if (window.some((s) => s.errors.dropped > 0)) probeLimited = true
    const step = judge(rate, window, design.workload.sloP95Ms)
    steps.push(step)
    options.onStep?.(step)
    return { step, window }
  }

  try {
    for (const rate of LADDER) {
      const { step, window } = await measure(rate)
      lastWindow = window
      if (step.pass) {
        lastPass = step
        continue
      }
      fail = { step, window }
      break
    }
    for (let i = 0; i < refine && fail && lastPass; i++) {
      const rate = between(lastPass.rate, fail.step.rate)
      if (rate <= lastPass.rate || rate >= fail.step.rate) break
      await driver.setRate(0)
      await driver.next(3, options.signal)
      const { step, window } = await measure(rate)
      if (step.pass) lastPass = step
      else fail = { step, window }
    }
  } catch (error) {
    if (!options.signal?.aborted) throw error
    cancelled = true
  } finally {
    await driver.setRate(0).catch(() => {})
  }

  const finding = findBottleneck(design, fail?.window ?? lastWindow)
  return {
    capacity: lastPass?.rate ?? null,
    failedAt: fail?.step.rate ?? null,
    steps,
    finding,
    suggestions: suggest(design, finding),
    probeLimited,
    cancelled,
  }
}
