import { CATALOG } from "./catalog.ts"
import { nodeSettings, type Design, type DesignNode } from "./design.ts"
import type { NodeSample, Sample, Usage } from "./samples.ts"

export type Status = "idle" | "ok" | "busy" | "hot" | "down"
export type Pressure = "cpu" | "connections" | "backlog" | "none"

export type Health = {
  status: Status
  load: number
  pressure: Pressure
  lines: [string, string]
}

export const BUSY = 0.6
export const HOT = 0.85

export function compact(value: number) {
  if (!Number.isFinite(value)) return "0"
  const abs = Math.abs(value)
  if (abs >= 10_000) return `${Math.round(value / 1000)}k`
  if (abs >= 1_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
  if (abs >= 100) return String(Math.round(value))
  if (abs >= 10) return value.toFixed(0)
  if (abs >= 1) return value.toFixed(1).replace(/\.0$/, "")
  if (abs === 0) return "0"
  return value.toFixed(2)
}

export function ms(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} s`
  return `${compact(value)} ms`
}

export function percent(value: number) {
  return `${Math.round(value * 100)}%`
}

function statusOf(load: number): Status {
  if (load >= HOT) return "hot"
  if (load >= BUSY) return "busy"
  return "ok"
}

function cpuLoad(usage: Usage | undefined) {
  if (!usage || usage.limit <= 0) return 0
  return usage.cores / usage.limit
}

export function queueFlow(design: Design, sample: Sample, queueId: string) {
  let arriving = 0
  let leaving = 0
  for (const edge of design.edges) {
    if (edge.to === queueId) arriving += sample.nodes[edge.from]?.deps?.[queueId]?.callsPs ?? 0
    if (edge.from === queueId) {
      const worker = sample.nodes[edge.to]
      leaving += (worker?.processedPs ?? 0) + (worker?.failedPs ?? 0)
    }
  }
  return { arriving, leaving }
}

export function nodeHealth(design: Design, node: DesignNode, sample: Sample | undefined, previous?: Sample): Health {
  if (node.kind === "client") {
    if (!sample || sample.rate <= 0) return { status: "idle", load: 0, pressure: "none", lines: ["No traffic", "Set a rate to start"] }
    return {
      status: "ok",
      load: 0,
      pressure: "none",
      lines: [`${compact(sample.rate)} req/s sent`, `${compact(sample.ok)} answered · p95 ${ms(sample.latency.p95)}`],
    }
  }
  const data: NodeSample | undefined = sample?.nodes[node.id]
  const usage = sample?.usage?.[node.id]
  if (!sample || !data) return { status: "idle", load: 0, pressure: "none", lines: ["Not running", CATALOG[node.kind].runs] }
  if (data.up === 0) {
    return { status: "down", load: 1, pressure: "none", lines: [data.error === "can't be found" ? "Not found" : "Not answering", "Too busy to report, or stopped"] }
  }

  const settings = nodeSettings(node)
  const cpu = cpuLoad(usage)
  const cpuText = usage ? `CPU ${percent(cpu)}` : "CPU –"
  const copies = settings.replicas > 1 ? ` · ${data.up}/${settings.replicas} copies` : ""
  let load = cpu
  let pressure: Pressure = cpu >= BUSY ? "cpu" : "none"
  let lines: [string, string]

  switch (node.kind) {
    case "service":
    case "loadbalancer":
    case "cdn": {
      const rps = data.rps ?? 0
      const p95 = data.latency?.p95 ?? 0
      lines = [`${compact(rps)} req/s · p95 ${ms(p95)}`, `${cpuText}${copies}`]
      if (node.kind === "cdn") {
        const total = (data.hitsPs ?? 0) + (data.missesPs ?? 0)
        if (total > 0) lines[1] = `${cpuText} · ${percent((data.hitsPs ?? 0) / total)} hits`
      }
      const waits = data.poolWaitsPs ?? 0
      const max = data.poolMax ?? 0
      if (max > 0 && waits > 0 && (data.poolWaitMs ?? 0) >= 2) {
        const poolLoad = Math.min(1.5, (data.poolInUse ?? 0) / max + Math.min(0.5, (data.poolWaitMs ?? 0) / 50))
        if (poolLoad > load) {
          load = poolLoad
          pressure = "connections"
          lines[1] = `Waits ${ms(data.poolWaitMs ?? 0)} for a connection`
        }
      }
      break
    }
    case "worker": {
      lines = [`${compact(data.processedPs ?? 0)} jobs/s`, `${cpuText}${copies}`]
      break
    }
    case "external": {
      lines = [`${compact(data.rps ?? 0)} calls/s`, `answers in ${ms(data.latency?.p50 ?? settings.latencyMs)}`]
      load = 0
      pressure = "none"
      break
    }
    case "database": {
      lines = [`${compact(data.tps ?? 0)} queries/s`, `${cpuText} · ${compact(data.active ?? 0)} busy conns`]
      break
    }
    case "cache": {
      const total = (data.hitsPs ?? 0) + (data.missesPs ?? 0)
      lines = [`${compact(data.opsPs ?? 0)} ops/s`, total > 0 ? `${cpuText} · ${percent((data.hitsPs ?? 0) / total)} hits` : cpuText]
      break
    }
    case "queue": {
      const backlog = data.backlog ?? 0
      const before = previous?.nodes[node.id]?.backlog ?? backlog
      const flow = queueFlow(design, sample, node.id)
      lines = [`${compact(backlog)} waiting`, `${compact(flow.arriving)} in · ${compact(flow.leaving)} out per s`]
      if (backlog > 200 && backlog > before && flow.arriving > flow.leaving * 1.05) {
        const backlogLoad = Math.min(1.5, 0.85 + backlog / 20_000)
        if (backlogLoad > load) {
          load = backlogLoad
          pressure = "backlog"
        }
      }
      break
    }
    default:
      lines = [cpuText, ""]
  }

  const idle = (data.rps ?? 0) === 0 && (data.tps ?? 0) === 0 && (data.opsPs ?? 0) < 2 && (data.processedPs ?? 0) === 0 && cpu < 0.05
  return { status: idle && pressure === "none" ? "idle" : statusOf(load), load, pressure, lines }
}

export type Finding = {
  nodeId: string
  pressure: Pressure | "errors" | "slow-dependency"
  load: number
  title: string
  detail: string
  also: string[]
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0
}

export function findBottleneck(design: Design, window: Sample[]): Finding | null {
  if (window.length === 0) return null
  const byNode = new Map<string, { load: number[]; pressure: Pressure[] }>()
  window.forEach((sample, i) => {
    for (const node of design.nodes) {
      if (node.kind === "client" || node.kind === "external") continue
      const health = nodeHealth(design, node, sample, window[i - 1])
      const entry = byNode.get(node.id) ?? { load: [], pressure: [] }
      entry.load.push(health.status === "down" ? 1 : health.load)
      entry.pressure.push(health.pressure)
      byNode.set(node.id, entry)
    }
  })

  const ranked = [...byNode.entries()]
    .map(([nodeId, entry]) => {
      const counts = new Map<Pressure, number>()
      for (const p of entry.pressure) counts.set(p, (counts.get(p) ?? 0) + 1)
      const pressure = [...counts.entries()].filter(([p]) => p !== "none").sort((a, b) => b[1] - a[1])[0]?.[0] ?? "cpu"
      return { nodeId, load: average(entry.load), pressure }
    })
    .sort((a, b) => b.load - a.load)

  const last = window[window.length - 1]!
  const byId = new Map(design.nodes.map((node) => [node.id, node]))
  const label = (id: string) => `“${byId.get(id)?.label ?? id}”`
  const top = ranked[0]

  if (top && top.load >= HOT) {
    const node = byId.get(top.nodeId)!
    const settings = nodeSettings(node)
    const also = ranked.slice(1).filter((item) => item.load >= HOT).map((item) => item.nodeId)
    const usage = last.usage?.[node.id]
    const data = last.nodes[node.id]
    let detail: string
    if (top.pressure === "connections") {
      detail = `Each copy of ${label(node.id)} keeps ${settings.pool} database connections, and every one was busy, so requests queued for a free one (${ms(data?.poolWaitMs ?? 0)} on average).`
    } else if (top.pressure === "backlog") {
      const flow = queueFlow(design, last, node.id)
      detail = `Jobs arrive at ${compact(flow.arriving)}/s but workers finish ${compact(flow.leaving)}/s, so ${compact(data?.backlog ?? 0)} are waiting and the pile keeps growing.`
    } else {
      const cores = usage ? `${compact(usage.cores)} of its ${compact(usage.limit)} CPU cores` : "all of its CPU"
      detail = `${label(node.id)} used ${cores}${settings.replicas > 1 ? ` across ${settings.replicas} copies` : ""}. Requests waited in line for CPU, so every answer got slower.`
      if (node.kind === "database") detail += ` It was running ${compact(data?.tps ?? 0)} queries a second.`
      if (node.kind === "service" && settings.workMs > 0) detail += ` Each request costs about ${compact(settings.workMs)} ms of CPU in your code alone.`
    }
    const what = top.pressure === "connections" ? "ran out of database connections" : top.pressure === "backlog" ? "fell behind" : "ran out of CPU"
    return { nodeId: node.id, pressure: top.pressure, load: top.load, title: `${label(node.id)} ${what}`, detail, also }
  }

  const failures = new Map<string, number>()
  for (const sample of window) for (const [dep, n] of Object.entries(sample.failedBy ?? {})) failures.set(dep, (failures.get(dep) ?? 0) + n)
  const worst = [...failures.entries()].sort((a, b) => b[1] - a[1])[0]
  if (worst && byId.has(worst[0])) {
    return {
      nodeId: worst[0],
      pressure: "errors",
      load: 1,
      title: `${label(worst[0])} started failing`,
      detail: `${compact(worst[1])} requests failed because ${label(worst[0])} returned errors or didn't answer in time.`,
      also: [],
    }
  }

  const slow = design.nodes
    .filter((node) => node.kind === "external")
    .map((node) => ({ node, p50: average(window.map((s) => s.nodes[node.id]?.latency?.p50 ?? 0)) }))
    .sort((a, b) => b.p50 - a.p50)[0]
  if (slow && slow.p50 > design.workload.sloP95Ms * 0.5) {
    return {
      nodeId: slow.node.id,
      pressure: "slow-dependency",
      load: 1,
      title: `${label(slow.node.id)} is slow`,
      detail: `Every request waits about ${ms(slow.p50)} for ${label(slow.node.id)}, which leaves little room under your ${ms(design.workload.sloP95Ms)} target.`,
      also: [],
    }
  }

  if (top && top.load >= BUSY) {
    return {
      nodeId: top.nodeId,
      pressure: top.pressure,
      load: top.load,
      title: `${label(top.nodeId)} is the busiest box`,
      detail: `Nothing was completely full, but ${label(top.nodeId)} was the closest, at ${percent(top.load)} of what it can take.`,
      also: [],
    }
  }
  return null
}
