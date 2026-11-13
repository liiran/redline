import { toast } from "@ui-sdk/react/toast"
import { compact } from "../../shared/analyze.ts"
import { CATALOG, type Kind } from "../../shared/catalog.ts"
import { edgeId, uniqueId, type Design } from "../../shared/design.ts"
import { NODE_HEIGHT, NODE_WIDTH } from "../../shared/normalize.ts"
import { applyChange, describeChange, type Change } from "../../shared/suggest.ts"
import { template } from "../../shared/templates.ts"
import { canRun, validate } from "../../shared/validate.ts"
import { api } from "./api.ts"
import { prepareImage, type Prepared } from "./image.ts"
import { useApp } from "./store.ts"

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function readPhoto(file: Blob) {
  let prepared: Prepared
  try {
    prepared = await prepareImage(file)
  } catch (error) {
    toast.error(message(error))
    return
  }
  await readPrepared(prepared)
}

export async function readPrepared(prepared: Prepared) {
  const app = useApp.getState()
  app.setReading({ busy: true, preview: prepared.preview, label: "Reading boxes and arrows" })
  try {
    const result = await api.readImage(prepared)
    if (result.design.nodes.length === 0) {
      toast.error("No boxes found", { description: "Redline couldn't find a system diagram in that picture." })
      return
    }
    app.open(result.design, null)
    toast.success(`Found ${result.boxes} boxes and ${result.arrows} arrows`, {
      description: `Read in ${(result.ms / 1000).toFixed(1)} s${result.costUsd ? ` for $${result.costUsd.toFixed(3)}` : ""}. Check them, then press Run.`,
    })
  } catch (error) {
    toast.error("Couldn't read the drawing", { description: message(error) })
  } finally {
    useApp.getState().setReading(null)
  }
}

export async function readText(text: string) {
  const app = useApp.getState()
  app.setReading({ busy: true, preview: null, label: "Turning your description into boxes" })
  try {
    const result = await api.readText(text)
    if (result.design.nodes.length === 0) {
      toast.error("Nothing to draw", { description: "Describe the parts of the system and how they connect." })
      return false
    }
    app.open({ ...result.design, name: text.split(/[.\n]/)[0]!.slice(0, 60) || "Described system" }, null)
    return true
  } catch (error) {
    toast.error("Couldn't turn that into a design", { description: message(error) })
    return false
  } finally {
    useApp.getState().setReading(null)
  }
}

export function openTemplate(slug: string) {
  useApp.getState().open(template(slug), null)
}

export async function openSaved(id: string) {
  try {
    const row = await api.design(id)
    useApp.getState().open(row.design, row.id)
  } catch (error) {
    toast.error(message(error))
  }
}

export function newBlank() {
  const design: Design = template("url-shortener")
  design.name = "Untitled system"
  design.nodes = design.nodes.slice(0, 1)
  design.edges = []
  useApp.getState().open(design, null)
}

export async function run() {
  const { design, designId, status } = useApp.getState()
  if (!design) return
  const issues = validate(design, status?.docker.ok ? status.docker.cpus : undefined)
  if (!canRun(issues)) {
    toast.error("Fix the design first", { description: issues.find((issue) => issue.level === "error")!.message })
    return
  }
  try {
    const view = await api.start(design, designId)
    useApp.getState().setSession(view, [])
  } catch (error) {
    toast.error("Couldn't start", { description: message(error) })
  }
}

export async function stop() {
  try {
    const view = await api.stop()
    useApp.getState().setSession(view)
  } catch (error) {
    toast.error(message(error))
  }
}

export async function setRate(rps: number) {
  try {
    await api.rate(rps)
  } catch (error) {
    toast.error(message(error))
  }
}

export async function findBreakingPoint() {
  try {
    const view = await api.ramp()
    useApp.getState().setSession(view)
  } catch (error) {
    toast.error(message(error))
  }
}

export async function stopRamp() {
  try {
    await api.stopRamp()
  } catch (error) {
    toast.error(message(error))
  }
}

export function tryChange(change: Change) {
  const app = useApp.getState()
  if (!app.design) return
  const label = describeChange(app.design, change)
  app.edit((design) => applyChange(design, change))
  toast(label, { description: "Run again to see what it changes." })
}

export function addBox(kind: Kind, at?: { x: number; y: number }) {
  const app = useApp.getState()
  app.edit((design) => {
    const taken = new Set(design.nodes.map((node) => node.id))
    const label = CATALOG[kind].title
    const id = uniqueId(kind === "client" ? "users" : label, taken)
    const maxX = design.nodes.length ? Math.max(...design.nodes.map((node) => node.x)) : 0
    const position = at ?? { x: maxX + NODE_WIDTH + 80, y: 0 }
    app.select(id)
    return {
      ...design,
      nodes: [...design.nodes, { id, kind, label, x: Math.round(position.x - NODE_WIDTH / 2), y: Math.round(position.y - NODE_HEIGHT / 2), settings: {} }],
    }
  })
}

export function removeSelection(ids: string[], edgeIds: string[] = []) {
  const remove = new Set(ids)
  const removeEdges = new Set(edgeIds)
  useApp.getState().edit((design) => ({
    ...design,
    nodes: design.nodes.filter((node) => !remove.has(node.id)),
    edges: design.edges.filter((edge) => !remove.has(edge.from) && !remove.has(edge.to) && !removeEdges.has(edge.id)),
  }))
  useApp.getState().select(null)
}

export function flipEdge(id: string) {
  useApp.getState().edit((design) => ({
    ...design,
    edges: design.edges.map((edge) => (edge.id === id ? { id: edgeId(edge.to, edge.from), from: edge.to, to: edge.from } : edge)),
  }))
}

export function addClient() {
  const app = useApp.getState()
  const design = app.design
  if (!design) return
  const incoming = new Set(design.edges.map((edge) => edge.to))
  const entries = design.nodes.filter((node) => ["cdn", "loadbalancer", "service"].includes(node.kind) && !incoming.has(node.id))
  const minX = design.nodes.length ? Math.min(...design.nodes.map((node) => node.x)) : 0
  app.edit((d) => {
    const taken = new Set(d.nodes.map((node) => node.id))
    const id = uniqueId("users", taken)
    return {
      ...d,
      nodes: [{ id, kind: "client", label: "Users", x: minX - NODE_WIDTH - 80, y: entries[0]?.y ?? 0, settings: {} }, ...d.nodes],
      edges: [...entries.slice(0, 1).map((node) => ({ id: edgeId(id, node.id), from: id, to: node.id })), ...d.edges],
    }
  })
}

export function rateLabel(rps: number) {
  return `${compact(rps)} req/s`
}
