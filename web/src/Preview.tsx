import type { Design } from "../../shared/design.ts"
import { NODE_HEIGHT, NODE_WIDTH } from "../../shared/normalize.ts"
import { arrowBetween } from "../../shared/route.ts"

/** A small drawing of a design's boxes and arrows, for cards. */
export function Preview({ design }: { design: Design }) {
  if (design.nodes.length === 0) return <svg className="preview" aria-hidden />
  const xs = design.nodes.map((n) => n.x)
  const ys = design.nodes.map((n) => n.y)
  const pad = 30
  const x0 = Math.min(...xs) - pad
  const y0 = Math.min(...ys) - pad
  const w = Math.max(...xs) + NODE_WIDTH + pad - x0
  const h = Math.max(...ys) + NODE_HEIGHT + pad - y0
  const rects = new Map(design.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: NODE_WIDTH, h: NODE_HEIGHT }]))
  return (
    <svg className="preview" viewBox={`${x0} ${y0} ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {design.edges.map((edge) => {
        const a = rects.get(edge.from)
        const b = rects.get(edge.to)
        if (!a || !b) return null
        const others = [...rects.entries()].filter(([id]) => id !== edge.from && id !== edge.to).map(([, r]) => r)
        const arrow = arrowBetween(a, b, others)
        const d = arrow?.path ?? `M ${a.x + a.w / 2} ${a.y + a.h / 2} L ${b.x + b.w / 2} ${b.y + b.h / 2}`
        return <path key={edge.id} d={d} className="preview-edge" />
      })}
      {design.nodes.map((n) => (
        <rect key={n.id} x={n.x} y={n.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx={14} className="preview-box" data-kind={n.kind} />
      ))}
    </svg>
  )
}
