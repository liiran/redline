export type Rect = { x: number; y: number; w: number; h: number }
export type Point = { x: number; y: number }

/** How far an arrow keeps from boxes it passes. */
const CLEARANCE = 14
const GAP = 3

type Column = { x0: number; x1: number; blocked: [number, number][] }

/** The boxes between two x positions, grown by the clearance and grouped into columns that overlap. */
function columnsBetween(x0: number, x1: number, boxes: Rect[]): Column[] {
  const hit = boxes
    .map((b) => ({ x0: b.x - CLEARANCE, x1: b.x + b.w + CLEARANCE, y0: b.y - CLEARANCE, y1: b.y + b.h + CLEARANCE }))
    .filter((b) => b.x1 > x0 && b.x0 < x1)
    .sort((a, b) => a.x0 - b.x0)
  const columns: Column[] = []
  for (const r of hit) {
    const last = columns.at(-1)
    if (last && r.x0 <= last.x1) {
      last.x1 = Math.max(last.x1, r.x1)
      last.blocked.push([r.y0, r.y1])
    } else {
      columns.push({ x0: r.x0, x1: r.x1, blocked: [[r.y0, r.y1]] })
    }
  }
  for (const column of columns) {
    column.x0 = Math.max(column.x0, x0)
    column.x1 = Math.min(column.x1, x1)
    const merged: [number, number][] = []
    for (const [a, b] of column.blocked.sort((p, q) => p[0] - q[0])) {
      const last = merged.at(-1)
      if (last && a <= last[1]) last[1] = Math.max(last[1], b)
      else merged.push([a, b])
    }
    column.blocked = merged
  }
  return columns
}

/** The free height nearest to `want` in a column. */
function freeY(column: Column, want: number) {
  const block = column.blocked.find(([a, b]) => want > a && want < b)
  if (!block) return want
  return want - block[0] <= block[1] - want ? block[0] : block[1]
}

/**
 * The points an arrow passes through on its way right from `from` to `to`. It crosses each column of
 * boxes in its way level, through the gap nearest a straight line to its end, and bends only in the
 * open space between columns, so it never runs through a box.
 */
export function route(from: Point, to: Point, obstacles: Rect[]): Point[] {
  if (!obstacles.some((box) => crosses([from, to], box, CLEARANCE / 2))) return [from, to]
  const points = [from]
  let previous = from
  for (const column of columnsBetween(from.x, to.x, obstacles)) {
    const middle = (column.x0 + column.x1) / 2
    const want = previous.y + ((to.y - previous.y) * (middle - previous.x)) / Math.max(1, to.x - previous.x)
    const y = Math.round(freeY(column, want) * 10) / 10
    points.push({ x: column.x0, y }, { x: column.x1, y })
    previous = { x: column.x1, y }
  }
  points.push(to)
  // Drop level runs that just continue the one before, so a clear path stays one smooth curve.
  return points.filter((p, i) => i === 0 || i === points.length - 1 || !(p.y === points[i - 1]!.y && p.y === points[i + 1]!.y))
}

function controls(p: Point, q: Point) {
  const bend = Math.abs(q.x - p.x) / 2
  return p.y === q.y ? [p, q] : [{ x: p.x + bend, y: p.y }, { x: q.x - bend, y: q.y }]
}

/** Draws points as a line that leaves and enters each point level, with smooth bends between. */
export function smoothPath(points: Point[]) {
  let d = `M ${points[0]!.x} ${points[0]!.y}`
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!
    const q = points[i]!
    if (p.y === q.y) {
      d += ` L ${q.x} ${q.y}`
      continue
    }
    const [c1, c2] = controls(p, q)
    d += ` C ${c1!.x} ${c1!.y} ${c2!.x} ${c2!.y} ${q.x} ${q.y}`
  }
  return d
}

/** Where to put a label: halfway along the middle stretch. */
export function midpoint(points: Point[]): Point {
  const i = Math.floor((points.length - 1) / 2)
  const a = points[i]!
  const b = points[i + 1] ?? a
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * The arrow from one box to another that sits further right: out of the right side, in at the left,
 * around anything in between. Null when the boxes don't sit that way round.
 */
export function arrowBetween(source: Rect, target: Rect, others: Rect[]) {
  const from = { x: source.x + source.w + GAP, y: source.y + source.h / 2 }
  const to = { x: target.x - GAP, y: target.y + target.h / 2 }
  if (to.x - from.x < 16) return null
  const points = route(from, to, others)
  return { points, path: smoothPath(points), label: midpoint(points) }
}

/** Whether the drawn line through `points` comes within `margin` of a box. */
export function crosses(points: Point[], box: Rect, margin = 0) {
  return sample(points).some((p) => p.x > box.x - margin && p.x < box.x + box.w + margin && p.y > box.y - margin && p.y < box.y + box.h + margin)
}

/** Samples a path made by smoothPath. */
export function sample(points: Point[], steps = 24): Point[] {
  const out: Point[] = []
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!
    const q = points[i]!
    const [c1, c2] = controls(p, q) as [Point, Point]
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const u = 1 - t
      out.push({
        x: u * u * u * p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * q.x,
        y: u * u * u * p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * q.y,
      })
    }
  }
  return out
}
