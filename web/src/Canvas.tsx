import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useInternalNode,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type FinalConnectionState,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react"
import { toast } from "@ui-sdk/react/toast"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { compact, nodeHealth, type Health } from "../../shared/analyze.ts"
import { CATALOG, KINDS, edgeRole } from "../../shared/catalog.ts"
import { edgeId, nodeSettings, type Design, type DesignNode } from "../../shared/design.ts"
import { NODE_HEIGHT, NODE_WIDTH } from "../../shared/normalize.ts"
import { arrowBetween, type Point, type Rect } from "../../shared/route.ts"
import type { Sample } from "../../shared/samples.ts"
import type { Issue } from "../../shared/validate.ts"
import { addConnected, removeSelection } from "./actions.ts"
import { photoUrl } from "./api.ts"
import { KindIcon } from "./kinds.tsx"
import { useApp } from "./store.ts"

/** How the canvas fits a design on screen: snug, and never zoomed in past life size. */
export const FIT = { padding: 0.08, maxZoom: 1.1 }

type BoxData = { node: DesignNode; health: Health | null; issue: boolean; live: boolean; dim: boolean }
type PhotoData = { url: string }
type FlowData = { rate: number; live: boolean; dim: boolean; focus: boolean; route: { path: string; label: Point } | null }

const BoxNode = memo(function BoxNode({ data }: NodeProps<Node<BoxData>>) {
  const { node, health, issue, live, dim } = data
  const replicas = nodeSettings(node).replicas
  const status = live && health ? health.status : "idle"
  const info = CATALOG[node.kind]
  const idle = info.tag.toLowerCase() === node.label.toLowerCase() || info.title.toLowerCase() === node.label.toLowerCase() ? info.short : info.tag
  const lines = live && health ? health.lines : [idle, null]
  return (
    <>
      {replicas > 1 && <div className="box-copies" />}
      {replicas > 2 && <div className="box-copies" />}
      <div className="box" data-status={status} data-issue={issue && !live ? "" : undefined} data-kind={node.kind} data-dim={dim ? "" : undefined}>
        <Handle type="target" position={Position.Left} />
        <span className="box-icon">
          <KindIcon kind={node.kind} />
        </span>
        <span className="box-text">
          <div className="box-label" title={node.label}>
            {node.label}
          </div>
          <div className="box-sub">{lines[0]}</div>
          {lines[1] && <div className="box-sub">{lines[1]}</div>}
        </span>
        {replicas > 1 && <span className="box-badge" aria-label={`${replicas} copies`}>×{replicas}</span>}
        <Handle type="source" position={Position.Right} />
      </div>
    </>
  )
})

function PhotoNode({ data }: NodeProps<Node<PhotoData>>) {
  return (
    <div className="photo-node" style={{ width: "100%", height: "100%" }}>
      <img src={data.url} alt="" draggable={false} />
    </div>
  )
}

function rect(node: InternalNode) {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured.width ?? NODE_WIDTH,
    h: node.measured.height ?? NODE_HEIGHT,
  }
}

const GAP = 3

/** Arrows leave the side of a box that faces the other one: right to left when it sits further right. */
function ends(from: InternalNode, to: InternalNode) {
  const a = rect(from)
  const b = rect(to)
  if (b.x >= a.x + a.w + 16) {
    return { sx: a.x + a.w + GAP, sy: a.y + a.h / 2, sp: Position.Right, tx: b.x - GAP, ty: b.y + b.h / 2, tp: Position.Left }
  }
  if (a.x >= b.x + b.w + 16) {
    return { sx: a.x - GAP, sy: a.y + a.h / 2, sp: Position.Left, tx: b.x + b.w + GAP, ty: b.y + b.h / 2, tp: Position.Right }
  }
  if (b.y >= a.y) {
    return { sx: a.x + a.w / 2, sy: a.y + a.h + GAP, sp: Position.Bottom, tx: b.x + b.w / 2, ty: b.y - GAP, tp: Position.Top }
  }
  return { sx: a.x + a.w / 2, sy: a.y - GAP, sp: Position.Top, tx: b.x + b.w / 2, ty: b.y + b.h + GAP, tp: Position.Bottom }
}

function FlowEdge({ id, source, target, data, selected, markerEnd }: EdgeProps<Edge<FlowData>>) {
  const from = useInternalNode(source)
  const to = useInternalNode(target)
  if (!from || !to) return null
  let path: string
  let mx: number
  let my: number
  if (data?.route) {
    path = data.route.path
    mx = data.route.label.x
    my = data.route.label.y
  } else {
    const e = ends(from, to)
    ;[path, mx, my] = getBezierPath({
      sourceX: e.sx,
      sourceY: e.sy,
      sourcePosition: e.sp,
      targetX: e.tx,
      targetY: e.ty,
      targetPosition: e.tp,
      curvature: 0.35,
    })
  }
  const rate = data?.rate ?? 0
  const flowing = !!data?.live && rate > 0
  const width = flowing ? Math.min(4, 1.25 + Math.log10(1 + rate) * 0.8) : 1.25
  const strong = selected || data?.focus
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={14}
        style={{
          strokeWidth: strong ? width + 0.75 : width,
          stroke: strong ? "var(--ink)" : flowing ? "var(--muted)" : "var(--faint)",
          strokeDasharray: flowing ? "6 5" : undefined,
          opacity: data?.dim ? 0.18 : 1,
          transition: "opacity 0.15s",
          animation: flowing ? `flow ${Math.max(0.25, 1.6 - Math.log10(1 + rate) * 0.35)}s linear infinite` : undefined,
        }}
      />
      {flowing && !data?.dim && (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ transform: `translate(-50%, -50%) translate(${mx}px, ${my}px)` }}>
            {compact(rate)}/s
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const nodeTypes = { box: BoxNode, photo: PhotoNode }
const edgeTypes = { flow: FlowEdge }

function edgeRate(design: Design, from: DesignNode, to: DesignNode, sample: Sample | undefined) {
  if (!sample) return 0
  if (from.kind === "client") {
    const targets = design.edges.filter((e) => e.from === from.id).length || 1
    return sample.rate / targets
  }
  if (from.kind === "queue") return (sample.nodes[to.id]?.processedPs ?? 0) + (sample.nodes[to.id]?.failedPs ?? 0)
  const deps = sample.nodes[from.id]?.deps
  if (!deps) return 0
  return deps[to.id]?.callsPs ?? (from.kind === "loadbalancer" || from.kind === "cdn" ? (deps.upstream?.callsPs ?? 0) : 0)
}

export function Canvas({ design, issues }: { design: Design; issues: Issue[] }) {
  const selected = useApp((s) => s.selected)
  const showPhoto = useApp((s) => s.showPhoto)
  const session = useApp((s) => s.session)
  const samples = useApp((s) => s.samples)
  const edit = useApp((s) => s.edit)
  const select = useApp((s) => s.select)
  const flow = useReactFlow()

  const designId = useApp((s) => s.designId)
  const live = session?.phase === "ready" && session.designId === designId
  const sample = live ? samples.at(-1) : undefined
  const previous = live ? samples.at(-2) : undefined
  const runningIds = useMemo(() => new Set(session?.design.nodes.map((n) => n.id) ?? []), [session])

  const flagged = useMemo(() => new Set(issues.filter((i) => i.level === "error" && i.nodeId).map((i) => i.nodeId!)), [issues])
  const [hovered, setHovered] = useState<string | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  // React Flow hides a box until it knows its size. Boxes are rebuilt on every change, so their
  // measured sizes are kept here and handed back, or each rebuild would blink them out for a frame.
  const sizes = useRef(new Map<string, { width: number; height: number }>())
  const [sizeTick, setSizeTick] = useState(0)

  // Hovering or selecting a box fades everything it isn't connected to.
  const focus = hovered ?? (design.nodes.some((n) => n.id === selected) ? selected : null)
  const near = useMemo(() => {
    if (!focus) return null
    const ids = new Set([focus])
    for (const edge of design.edges) {
      if (edge.from === focus) ids.add(edge.to)
      if (edge.to === focus) ids.add(edge.from)
    }
    return ids
  }, [focus, design.edges])

  const nodes = useMemo(() => {
    const out: Node[] = []
    if (design.photo && showPhoto) {
      out.push({
        id: "__photo",
        type: "photo",
        position: { x: 0, y: 0 },
        data: { url: photoUrl(design.photo.id) },
        draggable: false,
        selectable: false,
        focusable: false,
        style: { width: design.photo.width, height: design.photo.height, opacity: live ? 0.35 : 0.6 },
      })
    }
    for (const node of design.nodes) {
      const running = live && runningIds.has(node.id)
      out.push({
        id: node.id,
        type: "box",
        position: { x: node.x, y: node.y },
        measured: sizes.current.get(node.id),
        selected: node.id === selected,
        data: {
          node,
          health: running ? nodeHealth(design, node, sample, previous) : null,
          issue: flagged.has(node.id),
          live: running,
          dim: !!near && !near.has(node.id),
        } satisfies BoxData,
      })
    }
    return out
  }, [design, showPhoto, live, runningIds, selected, sample, previous, flagged, near])

  // Arrows that run left to right go around the boxes between their ends.
  const routes = useMemo(() => {
    const rects = new Map<string, Rect>()
    for (const node of design.nodes) {
      const size = sizes.current.get(node.id)
      const copies = Math.min(2, nodeSettings(node).replicas - 1) * 4
      rects.set(node.id, { x: node.x, y: node.y, w: (size?.width ?? NODE_WIDTH) + copies, h: (size?.height ?? NODE_HEIGHT) + copies })
    }
    const out = new Map<string, { path: string; label: Point } | null>()
    for (const edge of design.edges) {
      const a = rects.get(edge.from)
      const b = rects.get(edge.to)
      if (!a || !b) continue
      const others = [...rects.entries()].filter(([id]) => id !== edge.from && id !== edge.to).map(([, rect]) => rect)
      out.set(edge.id, arrowBetween(a, b, others))
    }
    return out
  }, [design.nodes, design.edges, sizeTick])

  const edges = useMemo(() => {
    const byId = new Map(design.nodes.map((node) => [node.id, node]))
    return design.edges.map((edge): Edge => {
      const from = byId.get(edge.from)
      const to = byId.get(edge.to)
      const ok = !!from && !!to && edgeRole(from.kind, to.kind) !== null
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "flow",
        selected: edge.id === selected,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, markerUnits: "userSpaceOnUse", color: ok ? "var(--faint)" : "var(--red)" },
        data: {
          rate: from && to && live ? edgeRate(design, from, to, sample) : 0,
          live,
          dim: !!focus && edge.from !== focus && edge.to !== focus,
          focus: !!focus && (edge.from === focus || edge.to === focus),
          route: routes.get(edge.id) ?? null,
        } satisfies FlowData,
        style: ok ? undefined : { stroke: "var(--red)" },
      }
    })
  }, [design, live, sample, selected, focus, routes])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const moves = new Map<string, { x: number; y: number }>()
      const removed: string[] = []
      let resized = false
      for (const change of changes) {
        if (change.type === "dimensions" && change.dimensions) {
          const before = sizes.current.get(change.id)
          sizes.current.set(change.id, change.dimensions)
          if (!before || Math.abs(before.width - change.dimensions.width) > 1 || Math.abs(before.height - change.dimensions.height) > 1) resized = true
        }
        if (change.type === "position" && change.position && change.id !== "__photo") moves.set(change.id, change.position)
        if (change.type === "select" && change.selected) select(change.id)
        if (change.type === "remove") removed.push(change.id)
      }
      if (moves.size) {
        edit(
          (d) => ({
            ...d,
            nodes: d.nodes.map((node) => {
              const at = moves.get(node.id)
              return at ? { ...node, x: Math.round(at.x), y: Math.round(at.y) } : node
            }),
          }),
          { coalesce: `move:${[...moves.keys()].join(",")}` },
        )
      }
      if (removed.length) removeSelection(removed)
      if (resized) setSizeTick((n) => n + 1)
    },
    [edit, select],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed: string[] = []
      for (const change of changes) {
        if (change.type === "select" && change.selected) select(change.id)
        if (change.type === "remove") removed.push(change.id)
      }
      if (removed.length) removeSelection([], removed)
    },
    [select],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      const d = useApp.getState().design
      if (!d || connection.source === connection.target) return
      const from = d.nodes.find((n) => n.id === connection.source)
      const to = d.nodes.find((n) => n.id === connection.target)
      if (!from || !to) return
      let [a, b] = [from, to]
      if (edgeRole(a.kind, b.kind) === null) {
        if (edgeRole(b.kind, a.kind) === null) {
          toast.error(`A ${CATALOG[a.kind].title.toLowerCase()} can't send requests to a ${CATALOG[b.kind].title.toLowerCase()}.`)
          return
        }
        ;[a, b] = [b, a]
        toast(`Drawn as ${a.label} → ${b.label}`, { description: "That's the way requests flow between these two." })
      }
      const id = edgeId(a.id, b.id)
      if (d.edges.some((e) => e.id === id)) return
      edit((design) => ({ ...design, edges: [...design.edges, { id, from: a.id, to: b.id }] }))
    },
    [edit],
  )

  // Letting go of a new arrow over empty canvas offers the boxes that could sit at its end.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.toNode || !state.fromNode) return
      const point = "changedTouches" in event ? event.changedTouches[0]! : event
      setDrop({
        from: state.fromNode.id,
        before: state.fromHandle?.type === "target",
        screen: { x: point.clientX, y: point.clientY },
        at: flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }),
      })
    },
    [flow],
  )

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onNodeMouseEnter={(_, node) => node.type === "box" && setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onNodeDragStart={() => setHovered(null)}
        onPaneClick={() => {
          select(null)
          setDrop(null)
        }}
        fitView
        fitViewOptions={FIT}
        minZoom={0.2}
        maxZoom={2}
        deleteKeyCode={["Backspace", "Delete"]}
        multiSelectionKeyCode={["Shift"]}
        proOptions={{ hideAttribution: true }}
        onInit={() => flow.fitView(FIT)}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
      </ReactFlow>
      {drop && <DropMenu drop={drop} design={design} onClose={() => setDrop(null)} />}
    </>
  )
}

type Drop = { from: string; before: boolean; screen: { x: number; y: number }; at: { x: number; y: number } }

function DropMenu({ drop, design, onClose }: { drop: Drop; design: Design; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const anchor = design.nodes.find((n) => n.id === drop.from)
  useEffect(() => {
    ref.current?.querySelector("button")?.focus()
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as globalThis.Node) && onClose()
    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onDown, true)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onDown, true)
    }
  }, [onClose])
  if (!anchor) return null
  const kinds = KINDS.filter((kind) => (drop.before ? edgeRole(kind, anchor.kind) : edgeRole(anchor.kind, kind)) !== null).filter(
    (kind) => kind !== "client" || !design.nodes.some((n) => n.kind === "client"),
  )
  const left = Math.min(drop.screen.x, window.innerWidth - 220)
  const top = Math.min(drop.screen.y, window.innerHeight - 40 - kinds.length * 34)
  return (
    <div ref={ref} className="drop-menu" role="menu" aria-label={drop.before ? `Add a box that sends to ${anchor.label}` : `Add a box after ${anchor.label}`} style={{ left, top }}>
      <p className="drop-menu-title">{drop.before ? `Sends to “${anchor.label}”` : `After “${anchor.label}”`}</p>
      {kinds.length === 0 && <p className="drop-menu-empty">Nothing can connect here.</p>}
      {kinds.map((kind) => (
        <button
          key={kind}
          role="menuitem"
          onClick={() => {
            addConnected(anchor.id, kind, { before: drop.before, at: drop.at })
            onClose()
          }}
        >
          <KindIcon kind={kind} />
          <span>{CATALOG[kind].title}</span>
          <small>{CATALOG[kind].short}</small>
        </button>
      ))}
    </div>
  )
}
