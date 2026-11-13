import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/react/dialog"
import { Eraser, Pencil, Trash2, Undo2 } from "lucide-react"
import { getStroke } from "perfect-freehand"
import { useEffect, useRef, useState } from "react"
import { readPrepared, readText } from "./actions.ts"
import { fromCanvas } from "./image.ts"

const PAD = { width: 1200, height: 760 }

type Stroke = { points: [number, number, number][]; erase: boolean }

function pathOf(points: [number, number, number][], size: number) {
  const outline = getStroke(points, { size, thinning: 0.5, smoothing: 0.5, streamline: 0.4 })
  if (!outline.length) return null
  const path = new Path2D()
  path.moveTo(outline[0]![0]!, outline[0]![1]!)
  for (const [x, y] of outline.slice(1)) path.lineTo(x!, y!)
  path.closePath()
  return path
}

function draw(canvas: HTMLCanvasElement, strokes: Stroke[]) {
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "#fbfbf9"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (const stroke of strokes) {
    const path = pathOf(stroke.points, stroke.erase ? 28 : 5)
    if (!path) continue
    ctx.fillStyle = stroke.erase ? "#fbfbf9" : "#1d2b6b"
    ctx.fill(path)
  }
}

export function SketchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [erase, setErase] = useState(false)
  const drawing = useRef<Stroke | null>(null)

  useEffect(() => {
    if (canvas.current) draw(canvas.current, drawing.current ? [...strokes, drawing.current] : strokes)
  }, [strokes, open])

  const point = (e: React.PointerEvent<HTMLCanvasElement>): [number, number, number] => {
    const rect = e.currentTarget.getBoundingClientRect()
    return [((e.clientX - rect.left) / rect.width) * PAD.width, ((e.clientY - rect.top) / rect.height) * PAD.height, e.pressure || 0.5]
  }

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogBackdrop />
      <DialogContent className="sketch">
        <div className="dialog-head">
          <DialogTitle>Sketch your system</DialogTitle>
          <DialogDescription>Draw boxes, write what each one is (API, Postgres, Redis, queue…) and connect them with arrows.</DialogDescription>
        </div>
        <div className="dialog-body">
          <div className="pad-tools">
            <button className="btn sm" aria-pressed={!erase} onClick={() => setErase(false)} style={!erase ? { background: "var(--tint)" } : undefined}>
              <Pencil aria-hidden /> Pen
            </button>
            <button className="btn sm" aria-pressed={erase} onClick={() => setErase(true)} style={erase ? { background: "var(--tint)" } : undefined}>
              <Eraser aria-hidden /> Eraser
            </button>
            <span className="spacer" />
            <button className="btn sm ghost" onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length}>
              <Undo2 aria-hidden /> Undo
            </button>
            <button className="btn sm ghost" onClick={() => setStrokes([])} disabled={!strokes.length}>
              <Trash2 aria-hidden /> Clear
            </button>
          </div>
          <div className="pad">
            <canvas
              ref={canvas}
              width={PAD.width}
              height={PAD.height}
              aria-label="Drawing area"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                drawing.current = { points: [point(e)], erase }
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return
                drawing.current.points.push(point(e))
                draw(e.currentTarget, [...strokes, drawing.current])
              }}
              onPointerUp={() => {
                const stroke = drawing.current
                drawing.current = null
                if (stroke) setStrokes((s) => [...s, stroke])
              }}
            />
          </div>
        </div>
        <div className="dialog-foot">
          <DialogClose className="btn ghost">Cancel</DialogClose>
          <button
            className="btn primary"
            disabled={strokes.filter((s) => !s.erase).length < 3}
            onClick={() => {
              if (!canvas.current) return
              const prepared = fromCanvas(canvas.current, "image/png")
              onOpenChange(false)
              setStrokes([])
              void readPrepared(prepared)
            }}
          >
            Read my sketch
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const EXAMPLE = "Users hit a load balancer in front of three copies of an API. The API reads from Redis, falls back to Postgres, and puts a job on a queue that a worker processes."

export function DescribeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogBackdrop />
      <DialogContent>
        <div className="dialog-head">
          <DialogTitle>Describe your system</DialogTitle>
          <DialogDescription>Say which parts there are and what talks to what. Redline draws it for you.</DialogDescription>
        </div>
        <div className="dialog-body">
          <textarea
            className="text-input"
            value={text}
            placeholder={EXAMPLE}
            maxLength={4000}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.currentTarget.form ?? e.currentTarget.closest("[data-slot=dialog-content]"))?.querySelector<HTMLButtonElement>("[data-submit]")?.click()
            }}
          />
          <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setText(EXAMPLE)}>
            Use the example
          </button>
        </div>
        <div className="dialog-foot">
          <DialogClose className="btn ghost">Cancel</DialogClose>
          <button
            className="btn primary"
            data-submit
            disabled={text.trim().length < 3 || busy}
            onClick={async () => {
              setBusy(true)
              onOpenChange(false)
              const ok = await readText(text.trim())
              setBusy(false)
              if (ok) setText("")
            }}
          >
            Draw it
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
