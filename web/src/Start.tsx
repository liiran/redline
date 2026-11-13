import { Camera, FileText, PenLine } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { TEMPLATES } from "../../shared/templates.ts"
import { openSaved, openTemplate, readPhoto } from "./actions.ts"
import { api, type DesignSummary } from "./api.ts"
import { imageFrom } from "./image.ts"
import { useApp } from "./store.ts"

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return new Date(t).toLocaleDateString()
}

export function Start({ onSketch, onDescribe }: { onSketch: () => void; onDescribe: () => void }) {
  const status = useApp((s) => s.status)
  const [over, setOver] = useState(false)
  const [recent, setRecent] = useState<DesignSummary[]>([])
  const input = useRef<HTMLInputElement>(null)
  const ai = status?.ai

  useEffect(() => {
    api.designs().then(setRecent).catch(() => {})
  }, [])

  return (
    <div className="start">
      <div className="start-inner">
        <h1 className="hero">
          Draw a system. Watch it <em>break</em>.
        </h1>
        <p className="lede">
          Snap a photo of a whiteboard sketch. Redline builds it from real containers in Docker, sends traffic until something gives, and tells you
          which box broke first and why.
        </p>

        {status && !status.docker.ok && (
          <div className="notice bad" style={{ marginBottom: 16 }}>
            <span>{status.docker.error}</span>
          </div>
        )}

        <div
          className="drop"
          data-over={over ? "" : undefined}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            const file = imageFrom(e.dataTransfer.files)
            if (file) void readPhoto(file)
          }}
        >
          <span className="drop-icon">
            <Camera aria-hidden />
          </span>
          <div>
            <strong>Drop a photo of your diagram</strong>
            <span className="muted">or paste it with Ctrl+V. Whiteboards, paper and napkins all work.</span>
          </div>
          <div className="row" style={{ justifyContent: "center" }}>
            <button className="btn primary" onClick={() => input.current?.click()} disabled={!ai}>
              <Camera aria-hidden /> Choose a photo
            </button>
            <button className="btn" onClick={onSketch} disabled={!ai}>
              <PenLine aria-hidden /> Sketch it here
            </button>
            <button className="btn" onClick={onDescribe} disabled={!ai}>
              <FileText aria-hidden /> Describe it
            </button>
          </div>
          {status && !ai && <span className="field-hint">Reading drawings needs Claude Code signed in, or an ANTHROPIC_API_KEY. Examples work without either.</span>}
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = imageFrom(e.target.files)
              e.target.value = ""
              if (file) void readPhoto(file)
            }}
          />
        </div>

        <p className="eyebrow" style={{ marginTop: 28 }}>
          Or start from an example
        </p>
        <div className="examples">
          {TEMPLATES.map((t) => (
            <button key={t.slug} className="card" onClick={() => openTemplate(t.slug)}>
              <strong>{t.name}</strong>
              <span>{t.summary}</span>
            </button>
          ))}
        </div>

        {recent.length > 0 && (
          <>
            <p className="eyebrow" style={{ marginTop: 28 }}>
              Your designs
            </p>
            <div className="recent">
              {recent.slice(0, 6).map((d) => (
                <button key={d.id} className="recent-row" onClick={() => openSaved(d.id)}>
                  <span className="name">{d.name}</span>
                  <span className="muted num">{d.boxes} boxes</span>
                  <span className="muted">{ago(d.updatedAt)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
