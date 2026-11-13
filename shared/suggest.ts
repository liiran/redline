import { POSTGRES_MAX_CONNECTIONS, SETTING_INFO, formatSetting, nextChoice, settingText, type SettingKey } from "./catalog.ts"
import { edgeId, nodeSettings, uniqueId, type Design, type DesignNode } from "./design.ts"
import type { Finding } from "./analyze.ts"

export type Change =
  | { kind: "set"; nodeId: string; key: SettingKey; value: number }
  | { kind: "add-cache"; databaseId: string; serviceIds: string[] }

export type Suggestion = { id: string; title: string; detail: string; change: Change }

function label(node: DesignNode) {
  return `“${node.label}”`
}

/** The next size up: the next standard choice where there are choices, otherwise `factor` times as much. */
function more(value: number, key: SettingKey, factor: number) {
  const info = SETTING_INFO[key]
  if (info.choices) return nextChoice(key, value, 1) ?? value
  const next = Math.min(info.max, Math.max(value + info.step, value * factor))
  return Math.round(next / info.step) * info.step
}

export function suggest(design: Design, finding: Finding | null): Suggestion[] {
  if (!finding) return []
  const byId = new Map(design.nodes.map((node) => [node.id, node]))
  const node = byId.get(finding.nodeId)
  if (!node) return []
  const settings = nodeSettings(node)
  const out: Suggestion[] = []
  const set = (key: SettingKey, value: number, title: string, detail: string) => {
    if (value !== settings[key]) out.push({ id: `${node.id}-${key}`, title, detail, change: { kind: "set", nodeId: node.id, key, value } })
  }

  const readers = (databaseId: string) =>
    design.edges.filter((edge) => edge.to === databaseId && byId.get(edge.from)?.kind === "service").map((edge) => edge.from)
  const cached = (serviceId: string) => design.edges.some((edge) => edge.from === serviceId && byId.get(edge.to)?.kind === "cache")

  if (finding.pressure === "backlog" && node.kind === "queue") {
    for (const edge of design.edges.filter((e) => e.from === node.id)) {
      const worker = byId.get(edge.to)
      if (!worker) continue
      const copies = nodeSettings(worker).replicas
      if (copies < 8) {
        const next = Math.min(8, copies * 2)
        out.push({
          id: `${worker.id}-replicas`,
          title: `Run ${next} replicas of ${label(worker)}`,
          detail: `More workers take jobs off ${label(node)} in parallel.`,
          change: { kind: "set", nodeId: worker.id, key: "replicas", value: next },
        })
      }
    }
    return out
  }

  switch (node.kind) {
    case "service":
    case "worker": {
      if (finding.pressure === "connections") {
        const databases = design.edges.filter((edge) => edge.from === node.id && byId.get(edge.to)?.kind === "database")
        // Never past what Postgres accepts across every replica.
        const pool = Math.min(more(settings.pool, "pool", 2.5), Math.floor(POSTGRES_MAX_CONNECTIONS / settings.replicas))
        set("pool", pool, `Give ${label(node)} more database connections`, `Raise it from ${settings.pool} to ${pool} per replica, if the database has CPU to spare.`)
        if (design.workload.readRatio >= 0.5 && databases.length && !cached(node.id)) {
          const db = byId.get(databases[0]!.to)!
          out.unshift({
            id: `${db.id}-cache`,
            title: `Put a cache in front of ${label(db)}`,
            detail: `${Math.round(design.workload.readRatio * 100)}% of requests are reads. A cache answers repeat reads without taking a connection.`,
            change: { kind: "add-cache", databaseId: db.id, serviceIds: readers(db.id).filter((id) => !cached(id)) },
          })
        }
        break
      }
      const copies = Math.min(8, Math.max(settings.replicas + 1, Math.ceil(settings.replicas * Math.max(1.5, finding.load * 1.6))))
      if (settings.replicas < 8) {
        out.push({
          id: `${node.id}-replicas`,
          title: `Run ${copies} replicas of ${label(node)}`,
          detail: `Each replica brings its own ${formatSetting("cpus", settings.cpus)}. Traffic is spread across all of them.`,
          change: { kind: "set", nodeId: node.id, key: "replicas", value: copies },
        })
      }
      set("cpus", more(settings.cpus, "cpus", 2), `Give ${label(node)} more CPU`, `Raise it from ${formatSetting("cpus", settings.cpus)} to ${formatSetting("cpus", more(settings.cpus, "cpus", 2))} per replica.`)
      const lighter = nextChoice("workMs", settings.workMs, -1)
      if (node.kind === "service" && lighter !== null && settings.workMs >= 5) {
        set("workMs", lighter, `Make ${label(node)}'s code cheaper`, `If each request used ${formatSetting("workMs", lighter)} of CPU instead of ${formatSetting("workMs", settings.workMs)}, the same CPU would serve ${Math.round(settings.workMs / lighter)} times as many.`)
      }
      break
    }
    case "database": {
      const uncached = readers(node.id).filter((id) => !cached(id))
      if (design.workload.readRatio >= 0.5 && uncached.length) {
        out.push({
          id: `${node.id}-cache`,
          title: `Put a cache in front of ${label(node)}`,
          detail: `${Math.round(design.workload.readRatio * 100)}% of requests are reads. Popular items would be answered from memory instead of by ${label(node)}.`,
          change: { kind: "add-cache", databaseId: node.id, serviceIds: uncached },
        })
      }
      set("cpus", more(settings.cpus, "cpus", 2), `Give ${label(node)} more CPU`, `Raise it from ${formatSetting("cpus", settings.cpus)} to ${formatSetting("cpus", more(settings.cpus, "cpus", 2))}. A bigger machine is the simplest fix, until it's the most expensive.`)
      break
    }
    case "cache":
    case "loadbalancer":
    case "cdn":
    case "queue":
      set("cpus", more(settings.cpus, "cpus", 2), `Give ${label(node)} more CPU`, `Raise it from ${formatSetting("cpus", settings.cpus)} to ${formatSetting("cpus", more(settings.cpus, "cpus", 2))}.`)
      break
  }
  return out
}

export function applyChange(design: Design, change: Change): Design {
  const next = structuredClone(design)
  if (change.kind === "set") {
    const node = next.nodes.find((item) => item.id === change.nodeId)
    if (node) node.settings = { ...node.settings, [change.key]: change.value }
    return next
  }
  const db = next.nodes.find((item) => item.id === change.databaseId)
  if (!db) return next
  const taken = new Set(next.nodes.map((item) => item.id))
  const id = uniqueId("redis", taken)
  const services = next.nodes.filter((item) => change.serviceIds.includes(item.id))
  const fromX = services.length ? services.reduce((sum, item) => sum + item.x, 0) / services.length : db.x - 260
  next.nodes.push({ id, kind: "cache", label: "Redis", x: Math.round((fromX + db.x) / 2), y: db.y - 130, settings: {} })
  for (const service of services) {
    if (!next.edges.some((edge) => edge.from === service.id && edge.to === id)) next.edges.push({ id: edgeId(service.id, id), from: service.id, to: id })
  }
  return next
}

export function describeChange(design: Design, change: Change) {
  const node = design.nodes.find((item) => item.id === (change.kind === "set" ? change.nodeId : change.databaseId))
  if (!node) return "Change"
  if (change.kind === "add-cache") return `Added a cache in front of ${label(node)}`
  return `${label(node)}: ${settingText(node.kind, change.key).label.toLowerCase()} → ${formatSetting(change.key, change.value)}`
}
