import type { Kind } from "../shared/catalog.ts"

// Synthetic whiteboard sketches with known answers. Each case is drawn as an SVG with wobbly
// hand-drawn strokes and a handwriting font, then rendered to a PNG by run.ts.

export type TruthNode = { key: string; label: string; kind: Kind; replicas: number; box: [number, number, number, number] }
export type Case = {
  id: string
  hard: boolean
  width: number
  height: number
  nodes: TruthNode[]
  edges: [string, string][]
  svg: string
  notes: string[]
}

type Rng = () => number

function rng(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: Rng, items: readonly T[]) => items[Math.floor(r() * items.length)]!

const LABELS: Record<Kind, string[]> = {
  client: ["Users", "Clients", "Browser", "Mobile app", "Customers"],
  cdn: ["CDN", "CloudFront"],
  loadbalancer: ["LB", "Load Balancer", "nginx", "API Gateway", "ALB"],
  service: ["API", "Web server", "Backend", "App", "Orders", "Auth", "Feed svc", "Catalog"],
  worker: ["Worker", "Consumer", "Email worker", "Jobs"],
  queue: ["Kafka", "Queue", "SQS", "RabbitMQ"],
  cache: ["Redis", "Cache", "Memcached"],
  database: ["Postgres", "DB", "MySQL", "Database", "Mongo"],
  external: ["Stripe", "Payments API", "SendGrid"],
}

type Topology = { name: string; nodes: [string, Kind, number, number][]; edges: [string, string][] }

// [key, kind, column, row]; rows are relative and may be fractional.
const TOPOLOGIES: Topology[] = [
  { name: "three-tier", nodes: [["u", "client", 0, 0], ["a", "service", 1, 0], ["d", "database", 2, 0]], edges: [["u", "a"], ["a", "d"]] },
  {
    name: "cached",
    nodes: [["u", "client", 0, 0], ["l", "loadbalancer", 1, 0], ["a", "service", 2, 0], ["c", "cache", 3, -0.7], ["d", "database", 3, 0.7]],
    edges: [["u", "l"], ["l", "a"], ["a", "c"], ["a", "d"]],
  },
  {
    name: "queue",
    nodes: [["u", "client", 0, 0], ["a", "service", 1, 0], ["d", "database", 2, -0.8], ["q", "queue", 2, 0.8], ["w", "worker", 3, 0.8]],
    edges: [["u", "a"], ["a", "d"], ["a", "q"], ["q", "w"], ["w", "d"]],
  },
  {
    name: "edge",
    nodes: [["u", "client", 0, 0], ["n", "cdn", 1, 0], ["l", "loadbalancer", 2, 0], ["a", "service", 3, 0], ["d", "database", 4, 0.6], ["x", "external", 4, -0.6]],
    edges: [["u", "n"], ["n", "l"], ["l", "a"], ["a", "d"], ["a", "x"]],
  },
  {
    name: "microservices",
    nodes: [["u", "client", 0, 0], ["g", "loadbalancer", 1, 0], ["s", "service", 2, -0.8], ["t", "service", 2, 0.8], ["c", "cache", 3, 0.8], ["d", "database", 3, -0.8]],
    edges: [["u", "g"], ["g", "s"], ["g", "t"], ["s", "d"], ["t", "c"], ["s", "t"]],
  },
  {
    name: "payments",
    nodes: [["u", "client", 0, 0], ["a", "service", 1, 0], ["x", "external", 2, -0.9], ["d", "database", 2, 0], ["q", "queue", 2, 0.9], ["w", "worker", 3, 0.9]],
    edges: [["u", "a"], ["a", "x"], ["a", "d"], ["a", "q"], ["q", "w"]],
  },
]

const BIG: Topology = {
  name: "big",
  nodes: [
    ["u", "client", 0, 0],
    ["n", "cdn", 1, 0],
    ["l", "loadbalancer", 2, 0],
    ["a", "service", 3, 0],
    ["c", "cache", 4, -1.1],
    ["d", "database", 4, 0],
    ["q", "queue", 4, 1.1],
    ["w", "worker", 5, 1.1],
  ],
  edges: [["u", "n"], ["n", "l"], ["l", "a"], ["a", "c"], ["a", "d"], ["a", "q"], ["q", "w"], ["w", "d"]],
}

const TITLES = ["System design v2", "Feed service (draft)", "Q3 plan", "Checkout flow", "Arch review"]
const ARROW_WORDS = ["HTTP", "reads", "gRPC", "async", "SQL", "events"]
const NOTES = ["TODO: auth?", "ask Sam", "rate limit?", "v2 later"]

const INK = ["#1d3fa8", "#1a1a1a", "#14632f", "#8a1c1c", "#3b2a7a"]
const FONTS = ["Segoe Print", "Ink Free", "Comic Sans MS", "Bradley Hand", "Segoe Script"]

function jitter(r: Rng, amount: number) {
  return (r() - 0.5) * 2 * amount
}

function wobblyLine(r: Rng, x1: number, y1: number, x2: number, y2: number, amount = 3) {
  const mx = (x1 + x2) / 2 + jitter(r, amount * 2)
  const my = (y1 + y2) / 2 + jitter(r, amount * 2)
  return `M${(x1 + jitter(r, amount)).toFixed(1)} ${(y1 + jitter(r, amount)).toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${(x2 + jitter(r, amount)).toFixed(1)} ${(y2 + jitter(r, amount)).toFixed(1)}`
}

function rect(r: Rng, x: number, y: number, w: number, h: number) {
  const o = () => jitter(r, 4)
  return [
    wobblyLine(r, x + o(), y + o(), x + w + o(), y + o()),
    wobblyLine(r, x + w + o(), y + o(), x + w + o(), y + h + o()),
    wobblyLine(r, x + w + o(), y + h + o(), x + o(), y + h + o()),
    wobblyLine(r, x + o(), y + h + o(), x + o(), y + o()),
  ].join(" ")
}

function cylinder(r: Rng, x: number, y: number, w: number, h: number) {
  const ry = Math.min(14, h * 0.18)
  const cx = x + w / 2
  return [
    `M${x} ${y + ry} A${w / 2} ${ry} 0 1 1 ${x + w} ${y + ry} A${w / 2} ${ry} 0 1 1 ${x} ${y + ry}`,
    wobblyLine(r, x, y + ry, x + jitter(r, 2), y + h - ry, 2),
    wobblyLine(r, x + w, y + ry, x + w + jitter(r, 2), y + h - ry, 2),
    `M${x} ${y + h - ry} A${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry}`,
    `M${cx - 1} ${y + 2 * ry} l0 0`,
  ].join(" ")
}

function stickFigure(x: number, y: number, w: number, h: number) {
  const cx = x + w / 2
  const head = Math.min(14, h * 0.16)
  return [
    `M${cx + head} ${y + head} A${head} ${head} 0 1 1 ${cx + head - 0.1} ${y + head - 1}`,
    `M${cx} ${y + head * 2} L${cx} ${y + h * 0.6}`,
    `M${cx - w * 0.22} ${y + h * 0.38} L${cx + w * 0.22} ${y + h * 0.38}`,
    `M${cx} ${y + h * 0.6} L${cx - w * 0.18} ${y + h * 0.85} M${cx} ${y + h * 0.6} L${cx + w * 0.18} ${y + h * 0.85}`,
  ].join(" ")
}

function border(box: [number, number, number, number], toward: { x: number; y: number }, pad: number) {
  const [x, y, w, h] = box
  const cx = x + w / 2
  const cy = y + h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  const s = Math.min(Math.abs((w / 2 + pad) / (dx || 1e-9)), Math.abs((h / 2 + pad) / (dy || 1e-9)))
  return { x: cx + dx * s, y: cy + dy * s }
}

function head(r: Rng, from: { x: number; y: number }, to: { x: number; y: number }) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const len = 16 + jitter(r, 3)
  const spread = 0.45 + jitter(r, 0.08)
  const a = { x: to.x - len * Math.cos(angle - spread), y: to.y - len * Math.sin(angle - spread) }
  const b = { x: to.x - len * Math.cos(angle + spread), y: to.y - len * Math.sin(angle + spread) }
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${to.x.toFixed(1)} ${to.y.toFixed(1)} L${b.x.toFixed(1)} ${b.y.toFixed(1)}`
}

function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
}

function rotateBox(box: [number, number, number, number], degrees: number, cx: number, cy: number): [number, number, number, number] {
  const a = (degrees * Math.PI) / 180
  const [x, y, w, h] = box
  const corners = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ].map(([px, py]) => {
    const dx = px! - cx
    const dy = py! - cy
    return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)]
  })
  const xs = corners.map((c) => c[0]!)
  const ys = corners.map((c) => c[1]!)
  return [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs) - Math.min(...xs)), Math.round(Math.max(...ys) - Math.min(...ys))]
}

/** Cases 1 to 24 are clean drawings. From 25 on they're harder: a tilted camera, blur and glare,
 *  titles, sticky notes, crossed-out boxes, words on arrows and bigger systems. */
export function makeCase(index: number): Case {
  const hard = index >= 24
  const r = rng(1000 + index * 7919)
  const topo = hard && index % 3 === 0 ? BIG : TOPOLOGIES[index % TOPOLOGIES.length]!
  const width = 1400
  const height = 900
  const vertical = r() < 0.3
  const ink = pick(r, INK)
  const font = pick(r, FONTS)
  const style = r() < 0.15 ? "chalk" : r() < 0.35 ? "paper" : "whiteboard"
  const color = style === "chalk" ? "#f2f2ee" : ink
  const notes = [topo.name, vertical ? "top to bottom" : "left to right", style, font]
  if (hard) notes.unshift("hard")

  const cols = Math.max(...topo.nodes.map((n) => n[2])) + 1
  const used = new Set<string>()
  const nodes: TruthNode[] = topo.nodes.map(([key, kind, col, row]) => {
    let label = pick(r, LABELS[kind])
    while (used.has(label)) label = pick(r, LABELS[kind])
    used.add(label)
    const w = 150 + Math.round(jitter(r, 25)) + label.length * 4
    const h = kind === "client" && r() < 0.5 ? 130 : 95 + Math.round(jitter(r, 12))
    const along = ((col + 0.5) / cols) * (vertical ? height : width)
    const across = (vertical ? width : height) / 2 + row * (vertical ? 300 : 230)
    const cx = vertical ? across + jitter(r, 30) : along + jitter(r, 25)
    const cy = vertical ? along + jitter(r, 20) : across + jitter(r, 25)
    return { key, label, kind, replicas: 1, box: [Math.round(cx - w / 2), Math.round(cy - h / 2), w, h] }
  })

  const service = nodes.find((n) => n.kind === "service")
  if (service && r() < 0.35) {
    service.replicas = 3
    notes.push("stacked copies")
  }

  const paths: string[] = []
  const texts: string[] = []
  for (const node of nodes) {
    const [x, y, w, h] = node.box
    const stick = node.kind === "client" && h > 120
    if (stick) paths.push(stickFigure(x, y, w, h))
    else if (node.kind === "database" && r() < 0.75) paths.push(cylinder(r, x, y, w, h))
    else {
      if (node.replicas > 1) {
        paths.push(rect(r, x + 14, y - 14, w, h))
        paths.push(rect(r, x + 7, y - 7, w, h))
      }
      paths.push(rect(r, x, y, w, h))
    }
    const size = 26 + Math.round(jitter(r, 4))
    const tx = x + w / 2 + jitter(r, 8)
    const ty = stick ? y + h + size : y + h / 2 + size / 3
    const tilt = jitter(r, 4).toFixed(1)
    texts.push(`<text x="${tx.toFixed(0)}" y="${ty.toFixed(0)}" font-size="${size}" text-anchor="middle" transform="rotate(${tilt} ${tx.toFixed(0)} ${ty.toFixed(0)})">${escape(node.label)}${node.replicas > 1 && r() < 0.6 ? " x3" : ""}</text>`)
  }

  const byKey = new Map(nodes.map((n) => [n.key, n]))
  for (const [from, to] of topo.edges) {
    const a = byKey.get(from)!
    const b = byKey.get(to)!
    const ca = { x: a.box[0] + a.box[2] / 2, y: a.box[1] + a.box[3] / 2 }
    const cb = { x: b.box[0] + b.box[2] / 2, y: b.box[1] + b.box[3] / 2 }
    const start = border(a.box, cb, 10)
    const end = border(b.box, ca, 10)
    paths.push(wobblyLine(r, start.x, start.y, end.x, end.y, 4))
    const roll = r()
    if (roll < 0.12) notes.push(`no head ${a.label}-${b.label}`)
    else if (roll < 0.22) {
      paths.push(head(r, start, end), head(r, end, start))
      notes.push(`two heads ${a.label}-${b.label}`)
    } else paths.push(head(r, start, end))
  }

  const decoys: string[] = []
  if (hard) {
    const title = pick(r, TITLES)
    decoys.push(`<text x="60" y="70" font-size="34" stroke="none">${escape(title)}</text>`)
    paths.push(wobblyLine(r, 58, 82, 60 + title.length * 15, 84, 2))
    notes.push("title")
    for (const [from, to] of topo.edges.filter(() => r() < 0.35).slice(0, 2)) {
      const a = byKey.get(from)!
      const b = byKey.get(to)!
      const mx = (a.box[0] + a.box[2] / 2 + b.box[0] + b.box[2] / 2) / 2
      const my = (a.box[1] + a.box[3] / 2 + b.box[1] + b.box[3] / 2) / 2
      decoys.push(`<text x="${mx.toFixed(0)}" y="${(my - 12).toFixed(0)}" font-size="20" text-anchor="middle" stroke="none">${pick(r, ARROW_WORDS)}</text>`)
      notes.push("arrow words")
    }
    if (r() < 0.6) {
      const x = width - 260 + jitter(r, 20)
      const y = height - 170 + jitter(r, 20)
      decoys.push(`<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="170" height="110" fill="#f8e27a" transform="rotate(${jitter(r, 6).toFixed(1)} ${x.toFixed(0)} ${y.toFixed(0)})"/><text x="${(x + 18).toFixed(0)}" y="${(y + 62).toFixed(0)}" font-size="22" fill="#333">${pick(r, NOTES)}</text>`)
      notes.push("sticky note")
    }
    if (r() < 0.6) {
      const x = 80 + jitter(r, 30)
      const y = height - 200 + jitter(r, 20)
      paths.push(rect(r, x, y, 170, 90), wobblyLine(r, x - 10, y - 10, x + 180, y + 100, 3), wobblyLine(r, x + 180, y - 10, x - 10, y + 100, 3))
      decoys.push(`<text x="${(x + 85).toFixed(0)}" y="${(y + 55).toFixed(0)}" font-size="24" text-anchor="middle" stroke="none">Memcached</text>`)
      notes.push("crossed out")
    }
  }
  const tilt = hard ? (r() < 0.5 ? -1 : 1) * (3 + r() * 5) : 0
  if (tilt) {
    for (const node of nodes) node.box = rotateBox(node.box, tilt, width / 2, height / 2)
    notes.push(`tilted ${tilt.toFixed(0)} degrees`)
  }

  const background =
    style === "chalk"
      ? `<rect width="${width}" height="${height}" fill="#2f3a35"/>`
      : style === "paper"
        ? `<rect width="${width}" height="${height}" fill="#fbf6e6"/>${Array.from({ length: 22 }, (_, i) => `<line x1="0" x2="${width}" y1="${60 + i * 40}" y2="${60 + i * 40}" stroke="#b9cbe3" stroke-width="1.2"/>`).join("")}`
        : `<rect width="${width}" height="${height}" fill="#f6f6f3"/>${Array.from({ length: 4 }, () => `<ellipse cx="${(r() * width).toFixed(0)}" cy="${(r() * height).toFixed(0)}" rx="${(80 + r() * 160).toFixed(0)}" ry="${(30 + r() * 60).toFixed(0)}" fill="#e9e9e4" opacity="0.55"/>`).join("")}`

  const glare = hard
    ? `<defs><radialGradient id="g"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"/><feColorMatrix values="0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0.08 0"/></filter></defs><rect width="${width}" height="${height}" filter="url(#n)"/><ellipse cx="${(width * (0.3 + r() * 0.4)).toFixed(0)}" cy="${(height * 0.35).toFixed(0)}" rx="420" ry="260" fill="url(#g)"/>`
    : ""
  const drawing = `<g transform="rotate(${tilt.toFixed(2)} ${width / 2} ${height / 2})"><g fill="none" stroke="${color}" stroke-width="${style === "chalk" ? 4 : 3}" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join("")}</g><g fill="${color}" font-family="'${font}', 'Segoe Print', cursive">${texts.join("")}${decoys.join("")}</g></g>`
  const blur = hard ? ` style="filter: blur(${(0.5 + r() * 0.7).toFixed(2)}px) contrast(0.85)"` : ""
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"${blur}>${background}${drawing}${glare}</svg>`

  return { id: `case-${String(index + 1).padStart(2, "0")}`, hard, width, height, nodes, edges: topo.edges, svg, notes }
}
