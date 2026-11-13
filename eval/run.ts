// Measures how well Redline reads drawings. Renders the synthetic sketches from cases.ts, sends each
// one to the same reader the app uses, and scores the design that comes back against the answer.
//
//   node eval/run.ts                 all cases (uses your Claude Code sign-in, about $0.01 each)
//   node eval/run.ts --limit 6       the first six
//   node eval/run.ts --render-only   only write the pictures to eval/out, no model calls
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright-core"
import type { Design } from "../shared/design.ts"
import { nodeSettings } from "../shared/design.ts"
import { canRun, validate } from "../shared/validate.ts"
import { pickReader, toDesign, type Image } from "../server/recognize.ts"
import { makeCase, type Case } from "./cases.ts"

const args = process.argv.slice(2)
const limit = Number(args[args.indexOf("--limit") + 1]) || 48
const from = Number(args[args.indexOf("--from") + 1]) || 0
const renderOnly = args.includes("--render-only")
const out = join(import.meta.dirname, "out")
mkdirSync(out, { recursive: true })

const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(
  (path) => path && existsSync(path),
)
if (!chrome) throw new Error("Chrome wasn't found. Set CHROME_PATH.")

const cases = Array.from({ length: limit }, (_, i) => makeCase(from + i))
const browser = await chromium.launch({ executablePath: chrome })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const images = new Map<string, Buffer>()
for (const c of cases) {
  await page.setContent(`<!doctype html><body style="margin:0">${c.svg}</body>`)
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: c.width, height: c.height }, ...(c.hard ? { type: "jpeg" as const, quality: 70 } : {}) })
  writeFileSync(join(out, `${c.id}.${c.hard ? "jpg" : "png"}`), png)
  images.set(c.id, png)
}
await browser.close()
console.log(`Rendered ${cases.length} sketches to ${out}`)
if (renderOnly) process.exit(0)

const reader = pickReader()
if (!reader) throw new Error("No reader: sign in to Claude Code or set ANTHROPIC_API_KEY.")
console.log(`Reading with ${reader.model} via ${reader.name}\n`)

function iou(a: number[], b: number[]) {
  const [ax, ay, aw, ah] = a as [number, number, number, number]
  const [bx, by, bw, bh] = b as [number, number, number, number]
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx))
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
  const inter = ix * iy
  const union = aw * ah + bw * bh - inter
  return union > 0 ? inter / union : 0
}

type Score = {
  id: string
  notes: string[]
  ms: number
  costUsd: number
  truthNodes: number
  found: number
  extra: number
  kindsRight: number
  truthEdges: number
  edgesRight: number
  edgesExtra: number
  replicasRight: boolean | null
  meanIou: number
  exact: boolean
  runnable: boolean
  error?: string
}

function score(c: Case, design: Design): Omit<Score, "ms" | "costUsd" | "id" | "notes"> {
  const predicted = design.nodes.filter((n) => n.box)
  const taken = new Set<string>()
  const match = new Map<string, string>()
  const ious: number[] = []
  const pairs = c.nodes
    .flatMap((t) => predicted.map((p) => ({ t, p, v: iou(t.box, p.box!) })))
    .sort((a, b) => b.v - a.v)
  for (const { t, p, v } of pairs) {
    if (v < 0.2 || match.has(t.key) || taken.has(p.id)) continue
    match.set(t.key, p.id)
    taken.add(p.id)
    ious.push(v)
  }
  for (const t of c.nodes) {
    if (match.has(t.key)) continue
    const p = predicted.find((n) => !taken.has(n.id) && n.label.toLowerCase().replace(/ x3$/, "") === t.label.toLowerCase())
    if (p) {
      match.set(t.key, p.id)
      taken.add(p.id)
    }
  }
  const byId = new Map(design.nodes.map((n) => [n.id, n]))
  const kindsRight = c.nodes.filter((t) => match.has(t.key) && byId.get(match.get(t.key)!)!.kind === t.kind).length
  const extra = design.nodes.filter((n) => !taken.has(n.id) && !(n.kind === "client" && !n.box)).length
  const truth = new Set(c.edges.map(([a, b]) => `${match.get(a) ?? `?${a}`}->${match.get(b) ?? `?${b}`}`))
  const got = new Set(design.edges.map((e) => `${e.from}->${e.to}`))
  const edgesRight = [...truth].filter((e) => got.has(e)).length
  const stacked = c.nodes.find((t) => t.replicas > 1)
  const replicasRight = stacked ? (match.has(stacked.key) ? nodeSettings(byId.get(match.get(stacked.key)!)!).replicas === stacked.replicas : false) : null
  const exact = match.size === c.nodes.length && kindsRight === c.nodes.length && extra === 0 && edgesRight === truth.size && got.size === truth.size
  return {
    truthNodes: c.nodes.length,
    found: match.size,
    extra,
    kindsRight,
    truthEdges: truth.size,
    edgesRight,
    edgesExtra: got.size - edgesRight,
    replicasRight,
    meanIou: ious.length ? ious.reduce((a, b) => a + b, 0) / ious.length : 0,
    exact,
    runnable: canRun(validate(design)),
  }
}

const scores: Score[] = []
const queue = [...cases]
async function worker() {
  for (let c = queue.shift(); c; c = queue.shift()) {
    const image: Image = { data: images.get(c.id)!.toString("base64"), mediaType: c.hard ? "image/jpeg" : "image/png", width: c.width, height: c.height }
    const started = Date.now()
    try {
      const reading = await reader!.read({ image })
      const design = toDesign(reading.sketch, { image }, "0000000000000000")
      const s = { id: c.id, notes: c.notes, ms: Date.now() - started, costUsd: reading.costUsd ?? 0, ...score(c, design) }
      scores.push(s)
      writeFileSync(join(out, `${c.id}.json`), JSON.stringify({ truth: { nodes: c.nodes, edges: c.edges }, sketch: reading.sketch, design, score: s }, null, 2))
      console.log(
        `${c.id}  ${s.exact ? "exact " : "      "} nodes ${s.found}/${s.truthNodes}${s.extra ? ` +${s.extra}` : ""}  kinds ${s.kindsRight}/${s.truthNodes}  arrows ${s.edgesRight}/${s.truthEdges}${s.edgesExtra ? ` +${s.edgesExtra}` : ""}  ${(s.ms / 1000).toFixed(1)} s  (${c.notes.join(", ")})`,
      )
    } catch (error) {
      const s: Score = { id: c.id, notes: c.notes, ms: Date.now() - started, costUsd: 0, truthNodes: c.nodes.length, found: 0, extra: 0, kindsRight: 0, truthEdges: c.edges.length, edgesRight: 0, edgesExtra: 0, replicasRight: null, meanIou: 0, exact: false, runnable: false, error: String(error) }
      scores.push(s)
      console.log(`${c.id}  failed: ${s.error}`)
    }
  }
}
await Promise.all([worker(), worker(), worker()])
scores.sort((a, b) => a.id.localeCompare(b.id))

const sum = (f: (s: Score) => number) => scores.reduce((a, s) => a + f(s), 0)
const pct = (a: number, b: number) => `${b ? ((a / b) * 100).toFixed(1) : "0"}%`
const times = scores.map((s) => s.ms).sort((a, b) => a - b)
const stacked = scores.filter((s) => s.replicasRight !== null)
const lines = [
  `# How well Redline reads drawings`,
  ``,
  `${scores.length} synthetic hand-drawn sketches (eval/cases.ts), read by ${reader.model} via ${reader.name === "cli" ? "Claude Code" : "the API"} on ${new Date().toISOString().slice(0, 10)}.`,
  ``,
  `| Measure | Result |`,
  `| --- | --- |`,
  `| Sketches read exactly right (every box, kind and arrow) | ${scores.filter((s) => s.exact).length} of ${scores.length} (${pct(scores.filter((s) => s.exact).length, scores.length)}) |`,
  `| Designs that can run as read | ${pct(scores.filter((s) => s.runnable).length, scores.length)} |`,
  `| Boxes found | ${pct(sum((s) => s.found), sum((s) => s.truthNodes))} |`,
  `| Boxes made up | ${sum((s) => s.extra)} |`,
  `| Kinds right | ${pct(sum((s) => s.kindsRight), sum((s) => s.truthNodes))} |`,
  `| Arrows right | ${pct(sum((s) => s.edgesRight), sum((s) => s.truthEdges))} |`,
  `| Arrows made up | ${sum((s) => s.edgesExtra)} |`,
  `| Stacked copies counted right | ${stacked.filter((s) => s.replicasRight).length} of ${stacked.length} |`,
  `| Box position overlap (mean IoU) | ${(sum((s) => s.meanIou) / scores.length).toFixed(2)} |`,
  `| Time per sketch (median, p90) | ${(times[Math.floor(times.length / 2)]! / 1000).toFixed(1)} s, ${(times[Math.floor(times.length * 0.9)]! / 1000).toFixed(1)} s |`,
  `| Cost (all sketches) | $${sum((s) => s.costUsd).toFixed(2)} |`,
  ``,
  `## Misses`,
  ``,
  ...scores
    .filter((s) => !s.exact)
    .map((s) => `- ${s.id} (${s.notes.join(", ")}): ${s.error ?? `boxes ${s.found}/${s.truthNodes}${s.extra ? ` +${s.extra} extra` : ""}, kinds ${s.kindsRight}/${s.truthNodes}, arrows ${s.edgesRight}/${s.truthEdges}${s.edgesExtra ? ` +${s.edgesExtra} extra` : ""}${s.replicasRight === false ? ", copies wrong" : ""}`}`),
]
writeFileSync(join(import.meta.dirname, "results.md"), lines.join("\n") + "\n")
console.log(`\n${lines.slice(4, 17).join("\n")}\n\nWrote eval/results.md`)
