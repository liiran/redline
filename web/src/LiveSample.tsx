import { useEffect, useMemo, useState } from "react"
import type { Design } from "../../shared/design.ts"
import { NODE_HEIGHT, NODE_WIDTH } from "../../shared/normalize.ts"
import { arrowBetween } from "../../shared/route.ts"
import { template } from "../../shared/templates.ts"

const UNIT: Record<string, string> = { database: "queries/s", cache: "ops/s", worker: "jobs/s", queue: "jobs/s" }

function reducedMotion() {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

/**
 * A sample design with pretend traffic moving through it, for the start page: dashed arrows that
 * flow, dots that ride along them, rates that wobble, and one box glowing red because it ran out of
 * CPU. It's animation only; nothing runs.
 */
export function LiveSample({ slug = "cached-feed", hot = "api", rate = 1400 }: { slug?: string; hot?: string; rate?: number }) {
  const design: Design = useMemo(() => template(slug), [slug])
  const [tick, setTick] = useState(0)
  const still = useMemo(reducedMotion, [])

  useEffect(() => {
    if (still) return
    const timer = setInterval(() => setTick((n) => n + 1), 800)
    return () => clearInterval(timer)
  }, [still])

  const rects = new Map(design.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: NODE_WIDTH, h: NODE_HEIGHT }]))
  const paths = design.edges.map((e) => {
    const others = [...rects.entries()].filter(([id]) => id !== e.from && id !== e.to).map(([, r]) => r)
    return arrowBetween(rects.get(e.from)!, rects.get(e.to)!, others)?.path ?? ""
  })
  const pad = 36
  const x0 = Math.min(...design.nodes.map((n) => n.x)) - pad
  const y0 = Math.min(...design.nodes.map((n) => n.y)) - pad
  const w = Math.max(...design.nodes.map((n) => n.x)) + NODE_WIDTH + pad - x0
  const h = Math.max(...design.nodes.map((n) => n.y)) + NODE_HEIGHT + pad - y0

  // A steady, believable number per box that moves a little on each tick.
  const wobble = (base: number, seed: number) => Math.round(base * (0.96 + 0.08 * Math.abs(Math.sin(tick * 1.7 + seed))))
  const sub = (kind: string, id: string, i: number) => {
    if (id === hot) return "CPU 100% · p95 1.1 s"
    if (kind === "client") return `${wobble(rate, i).toLocaleString("en")} req/s sent`
    return `${wobble(Math.round(rate * (0.38 + 0.11 * i)), i).toLocaleString("en")} ${UNIT[kind] ?? "req/s"}`
  }

  return (
    <svg className="live-sample" viewBox={`${x0} ${y0} ${w} ${h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="A sample design under load: its API box has run out of CPU">
      {paths.map((d, i) => (
        <path key={i} id={`sample-path-${i}`} d={d} className="live-flow" />
      ))}
      {!still &&
        paths.map((_, i) =>
          [0, 1, 2].map((k) => (
            <circle key={`${i}-${k}`} r={4.5} className="live-dot">
              <animateMotion dur={`${2.2 + (i % 3) * 0.3}s`} begin={`-${(k * 0.75 + i * 0.17).toFixed(2)}s`} repeatCount="indefinite">
                <mpath href={`#sample-path-${i}`} />
              </animateMotion>
            </circle>
          )),
        )}
      {design.nodes.map((n, i) => (
        <g key={n.id} className="live-node" data-hot={n.id === hot ? "" : undefined}>
          <rect x={n.x} y={n.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx={12} />
          <text x={n.x + 18} y={n.y + 28} className="live-label">
            {n.label}
          </text>
          <text x={n.x + 18} y={n.y + 50} className="live-sub">
            {sub(n.kind, n.id, i)}
          </text>
        </g>
      ))}
    </svg>
  )
}
