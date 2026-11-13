import { useEffect, useRef, useState } from "react"
import { compact, ms } from "../../shared/analyze.ts"

type Point = { t: number; a: number; b?: number; bad?: number }

function niceMax(value: number) {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) if (step * magnitude >= value) return step * magnitude
  return 10 * magnitude
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(300)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(120, Math.round(entry!.contentRect.width))))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** A small line chart: one solid series, an optional dashed one, red ticks for errors and an optional limit. */
export function Chart({
  points,
  label,
  unit,
  limit,
  limitLabel,
  height = 96,
  span = 90,
}: {
  points: Point[]
  label: string
  unit: "rps" | "ms"
  limit?: number
  limitLabel?: string
  height?: number
  span?: number
}) {
  const [ref, width] = useWidth()
  const pad = { l: 34, r: 4, t: 6, b: 4 }
  const w = width - pad.l - pad.r
  const h = height - pad.t - pad.b
  const end = points.at(-1)?.t ?? 0
  const start = end - span
  const visible = points.filter((p) => p.t >= start)
  const top = niceMax(Math.max(1, ...visible.map((p) => Math.max(p.a, p.b ?? 0)), limit ? limit * 1.15 : 0))
  const x = (t: number) => pad.l + ((t - start) / span) * w
  const y = (v: number) => pad.t + h - (Math.min(v, top) / top) * h
  const line = (pick: (p: Point) => number | undefined) =>
    visible
      .filter((p) => pick(p) !== undefined)
      .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(pick(p)!).toFixed(1)}`)
      .join(" ")
  const fmt = (v: number) => (unit === "ms" ? ms(v) : compact(v))
  const a = line((p) => p.a)
  const area = visible.length > 1 ? `${a} L${x(visible.at(-1)!.t).toFixed(1)},${pad.t + h} L${x(visible[0]!.t).toFixed(1)},${pad.t + h} Z` : ""

  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="grid" x1={pad.l} x2={pad.l + w} y1={y(top * f)} y2={y(top * f)} />
            <text className="axis" x={pad.l - 6} y={y(top * f) + 3} textAnchor="end">
              {fmt(top * f)}
            </text>
          </g>
        ))}
        {area && <path className="s1-fill" d={area} />}
        {visible.some((p) => p.b !== undefined) && <path className="s2" d={line((p) => p.b)} />}
        <path className="s1" d={a} />
        {visible
          .filter((p) => (p.bad ?? 0) > 0)
          .map((p) => (
            <rect key={p.t} className="err" x={x(p.t) - 1} y={y(Math.min(top, p.bad!))} width={2} height={pad.t + h - y(Math.min(top, p.bad!))} />
          ))}
        {limit !== undefined && limit <= top && (
          <g>
            <line className="limit" x1={pad.l} x2={pad.l + w} y1={y(limit)} y2={y(limit)} />
            {limitLabel && (
              <text className="limit-text" x={pad.l + w} y={y(limit) - 4} textAnchor="end">
                {limitLabel}
              </text>
            )}
          </g>
        )}
      </svg>
    </div>
  )
}
