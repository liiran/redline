import { toast } from "@ui-sdk/react/toast"
import { compact } from "../../shared/analyze.ts"
import { CATALOG, edgeRole, type Kind } from "../../shared/catalog.ts"
import { edgeId, uniqueId, type Design, type DesignNode } from "../../shared/design.ts"
import { NODE_HEIGHT, NODE_WIDTH, layout } from "../../shared/normalize.ts"
import { applyChange, describeChange, type Change } from "../../shared/suggest.ts"
import { template } from "../../shared/templates.ts"
import { canRun, validate } from "../../shared/validate.ts"
import { api } from "./api.ts"
import { prepareImage, type Prepared } from "./image.ts"
import { ensureSaved, useApp } from "./store.ts"

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function connectedNote(added = 0) {
  return added ? ` Added ${added === 1 ? "1 arrow" : `${added} arrows`} so no box is left unconnected.` : ""
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
      description: `Read in ${(result.ms / 1000).toFixed(1)} s${result.costUsd ? ` for $${result.costUsd.toFixed(3)}` : ""}.${connectedNote(result.added)} Check them, then press Run.`,
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
    app.open(result.design, null)
    if (result.added) toast(`${connectedNote(result.added).trim()}`, { description: "Every box needs traffic to reach it, so Redline joined it to the likeliest neighbour." })
    return true
  } catch (error) {
    toast.error("Couldn't turn that into a design", { description: message(error) })
    return false
  } finally {
    useApp.getState().setReading(null)
  }
}

export function openTemplate(slug: string) {
  useApp.getState().open(template(slug), null, { unsaved: true })
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
  useApp.getState().open(design, null, { unsaved: true })
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
    await ensureSaved()
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

function overlaps(design: Design, x: number, y: number) {
  return design.nodes.some((n) => Math.abs(n.x - x) < NODE_WIDTH + 24 && Math.abs(n.y - y) < NODE_HEIGHT + 18)
}

/** The nearest empty spot in the column beside a box, trying straight across first, then below and above. */
function besideOf(design: Design, anchor: DesignNode, before: boolean) {
  const x = before ? anchor.x - NODE_WIDTH - 96 : anchor.x + NODE_WIDTH + 96
  for (let i = 0; i < 24; i++) {
    const step = Math.ceil(i / 2) * (i % 2 ? 1 : -1)
    const y = anchor.y + step * (NODE_HEIGHT + 26)
    if (!overlaps(design, x, y)) return { x, y }
  }
  return { x, y: anchor.y }
}

function newNode(design: Design, kind: Kind, position: { x: number; y: number }): DesignNode {
  const taken = new Set(design.nodes.map((node) => node.id))
  const label = kind === "client" ? "Users" : CATALOG[kind].title
  return { id: uniqueId(label, taken), kind, label, x: Math.round(position.x), y: Math.round(position.y), settings: {} }
}

/** Adds a box joined to `anchorId`: after it, or before it when `before` is set. */
export function addConnected(anchorId: string, kind: Kind, options: { before?: boolean; at?: { x: number; y: number } } = {}) {
  const app = useApp.getState()
  const design = app.design
  const anchor = design?.nodes.find((n) => n.id === anchorId)
  if (!design || !anchor) return
  const before = !!options.before
  const position = options.at ? { x: options.at.x - NODE_WIDTH / 2, y: options.at.y - NODE_HEIGHT / 2 } : besideOf(design, anchor, before)
  const node = newNode(design, kind, position)
  const [from, to] = before ? [node, anchor] : [anchor, node]
  const ok = edgeRole(from.kind, to.kind) !== null
  app.edit((d) => ({
    ...d,
    nodes: [...d.nodes, node],
    edges: ok ? [...d.edges, { id: edgeId(from.id, to.id), from: from.id, to: to.id }] : d.edges,
  }))
  app.select(node.id, { fresh: true })
}

/** Adds a box from the toolbar: joined to the selected box when they can connect, otherwise in open space. */
export function addBox(kind: Kind, center?: { x: number; y: number }) {
  const app = useApp.getState()
  const design = app.design
  if (!design) return
  const anchor = design.nodes.find((n) => n.id === app.selected)
  if (anchor) {
    if (edgeRole(anchor.kind, kind)) return addConnected(anchor.id, kind)
    if (edgeRole(kind, anchor.kind)) return addConnected(anchor.id, kind, { before: true })
  }
  let at = center ? { x: center.x - NODE_WIDTH / 2, y: center.y - NODE_HEIGHT / 2 } : { x: 0, y: 0 }
  for (let i = 0; i < 30 && overlaps(design, at.x, at.y); i++) at = { x: at.x, y: at.y + NODE_HEIGHT + 26 }
  const node = newNode(design, kind, at)
  app.edit((d) => ({ ...d, nodes: [...d.nodes, node] }))
  app.select(node.id, { fresh: true })
}

/** Draws an arrow between two boxes, in whichever direction requests can flow. */
export function connect(a: string, b: string) {
  const app = useApp.getState()
  const design = app.design
  const one = design?.nodes.find((n) => n.id === a)
  const two = design?.nodes.find((n) => n.id === b)
  if (!design || !one || !two || one.id === two.id) return
  const [from, to] = edgeRole(one.kind, two.kind) ? [one, two] : edgeRole(two.kind, one.kind) ? [two, one] : [null, null]
  if (!from || !to) {
    toast.error(`A ${CATALOG[one.kind].title.toLowerCase()} and a ${CATALOG[two.kind].title.toLowerCase()} can't connect.`)
    return
  }
  const id = edgeId(from.id, to.id)
  if (design.edges.some((e) => e.id === id)) return
  app.edit((d) => ({ ...d, edges: [...d.edges, { id, from: from.id, to: to.id }] }))
}

export function tidy() {
  const app = useApp.getState()
  if (!app.design) return
  app.edit((design) => layout(design))
  if (app.design.photo && app.showPhoto) app.togglePhoto()
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
