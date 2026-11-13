import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
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
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react"
import { toast } from "@ui-sdk/react/toast"
import { memo, useCallback, useMemo } from "react"
import { compact, nodeHealth, type Health } from "../../shared/analyze.ts"
import { CATALOG, edgeRole } from "../../shared/catalog.ts"
import { edgeId, nodeSettings, type Design, type DesignNode } from "../../shared/design.ts"
import { NODE_HEIGHT, NODE_WIDTH } from "../../shared/normalize.ts"
import type { Sample } from "../../shared/samples.ts"
import type { Issue } from "../../shared/validate.ts"
import { removeSelection } from "./actions.ts"
import { photoUrl } from "./api.ts"
import { KindIcon } from "./kinds.tsx"
import { useApp } from "./store.ts"

type BoxData = { node: DesignNode; health: Health | null; issue: boolean; live: boolean }
type PhotoData = { url: string }
type FlowData = { rate: number; live: boolean }

const BoxNode = memo(function BoxNode({ data }: NodeProps<Node<BoxData>>) {
  const { node, health, issue, live } = data
  const replicas = nodeSettings(node).replicas
  const status = live && health ? health.status : "idle"
  const info = CATALOG[node.kind]
  const idle = info.title.toLowerCase() === node.label.toLowerCase() || node.kind === "client" ? info.short : `${info.title} · ${info.short}`
  const lines = live && health ? health.lines : [idle, null]
  return (
    <>
      {replicas > 1 && <div className="box-copies" />}
      {replicas > 2 && <div className="box-copies" />}
      <div className="box" data-status={status} data-issue={issue && !live ? "" : undefined} data-kind={node.kind}>
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

function borderPoint(node: InternalNode, toward: { x: number; y: number }) {
  const w = node.measured.width ?? NODE_WIDTH
  const h = node.measured.height ?? NODE_HEIGHT
  const cx = node.internals.positionAbsolute.x + w / 2
  const cy = node.internals.positionAbsolute.y + h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const scale = Math.min(Math.abs((w / 2 + 6) / (dx || 1e-9)), Math.abs((h / 2 + 6) / (dy || 1e-9)))
  return { x: cx + dx * scale, y: cy + dy * scale }
}

function center(node: InternalNode) {
  return {
    x: node.internals.positionAbsolute.x + (node.measured.width ?? NODE_WIDTH) / 2,
    y: node.internals.positionAbsolute.y + (node.measured.height ?? NODE_HEIGHT) / 2,
  }
}

function FlowEdge({ id, source, target, data, selected, markerEnd }: EdgeProps<Edge<FlowData>>) {
  const from = useInternalNode(source)
  const to = useInternalNode(target)
  if (!from || !to) return null
  const a = borderPoint(from, center(to))
  const b = borderPoint(to, center(from))
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const path = `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  const rate = data?.rate ?? 0
  const flowing = !!data?.live && rate > 0
  const width = flowing ? Math.min(4, 1.25 + Math.log10(1 + rate) * 0.8) : 1.25
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          strokeWidth: selected ? width + 0.75 : width,
          stroke: selected ? "var(--ink)" : flowing ? "var(--muted)" : "var(--faint)",
          strokeDasharray: flowing ? "6 5" : undefined,
          animation: flowing ? `flow ${Math.max(0.25, 1.6 - Math.log10(1 + rate) * 0.35)}s linear infinite` : undefined,
        }}
      />
      {flowing && (
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
        selected: node.id === selected,
        data: { node, health: running ? nodeHealth(design, node, sample, previous) : null, issue: flagged.has(node.id), live: running } satisfies BoxData,
      })
    }
    return out
  }, [design, showPhoto, live, runningIds, selected, sample, previous, flagged])

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
        data: { rate: from && to && live ? edgeRate(design, from, to, sample) : 0, live } satisfies FlowData,
        style: ok ? undefined : { stroke: "var(--red)" },
      }
    })
  }, [design, live, sample, selected])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const moves = new Map<string, { x: number; y: number }>()
      const removed: string[] = []
      for (const change of changes) {
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

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onPaneClick={() => select(null)}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
      minZoom={0.2}
      maxZoom={2}
      deleteKeyCode={["Backspace", "Delete"]}
      multiSelectionKeyCode={["Shift"]}
      proOptions={{ hideAttribution: true }}
      onInit={() => flow.fitView({ padding: 0.25, maxZoom: 1.2 })}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
    </ReactFlow>
  )
}
