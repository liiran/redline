import { ArrowUp, ImageUp, PenLine, Plus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { TEMPLATES } from "../../shared/templates.ts"
import { newBlank, openSaved, openTemplate, readPhoto, readText } from "./actions.ts"
import { api, type DesignSummary } from "./api.ts"
import { imageFrom } from "./image.ts"
import { Preview } from "./Preview.tsx"
import { useApp } from "./store.ts"

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return new Date(t).toLocaleDateString()
}

const IDEAS = ["A chat app with push alerts", "Photo sharing with a CDN", "Ticket sales with a queue"]

export function Start({ onSketch }: { onSketch: () => void }) {
  const status = useApp((s) => s.status)
  const busy = useApp((s) => !!s.reading)
  const [over, setOver] = useState(false)
  const [text, setText] = useState("")
  const [recent, setRecent] = useState<DesignSummary[]>([])
  const input = useRef<HTMLInputElement>(null)
  const ai = !!status?.ai

  useEffect(() => {
    api.designs().then(setRecent).catch(() => {})
  }, [])

  const submit = async () => {
    if (text.trim().length < 3 || !ai || busy) return
    if (await readText(text.trim())) setText("")
  }

  return (
    <div
      className="start"
      data-over={over ? "" : undefined}
      onDragOver={(e) => {
        if (!ai || ![...e.dataTransfer.types].includes("Files")) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const file = imageFrom(e.dataTransfer.files)
        if (file) void readPhoto(file)
      }}
    >
      <div className="start-inner">
        <h1 className="hero">
          Draw a system. Watch it <em>break</em>.
        </h1>
        <p className="lede">Describe or sketch a backend. Redline runs it in real containers and finds what breaks first.</p>

        {status && !status.docker.ok && (
          <div className="notice bad" style={{ marginBottom: 16 }}>
            <span>{status.docker.error}</span>
          </div>
        )}

        <form
          className="prompt"
          data-disabled={!ai ? "" : undefined}
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <textarea
            aria-label="Describe your system"
            value={text}
            rows={3}
            maxLength={4000}
            disabled={!ai}
            placeholder="Describe a system, like “a game backend with a shop, leaderboards and matchmaking”"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div className="prompt-foot">
            <div className="ideas">
              {IDEAS.map((idea) => (
                <button key={idea} type="button" className="idea" disabled={!ai} onClick={() => setText(idea)}>
                  {idea}
                </button>
              ))}
            </div>
            <button className="btn primary icon send" type="submit" aria-label="Draw it" disabled={!ai || busy || text.trim().length < 3}>
              <ArrowUp aria-hidden />
            </button>
          </div>
        </form>

        <div className="ways">
          <button className="way" onClick={onSketch} disabled={!ai}>
            <span className="way-icon">
              <PenLine aria-hidden />
            </span>
            <span>
              <strong>Sketch it</strong>
              <small>Draw boxes and arrows by hand</small>
            </span>
          </button>
          <button className="way" onClick={() => input.current?.click()} disabled={!ai}>
            <span className="way-icon">
              <ImageUp aria-hidden />
            </span>
            <span>
              <strong>Upload a photo</strong>
              <small>Pick, drop or paste a picture</small>
            </span>
          </button>
        </div>
        {status && !ai && <p className="field-hint">Reading drawings and descriptions needs Claude Code signed in, or an ANTHROPIC_API_KEY. The examples work without either.</p>}
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

        <h2 className="start-label">Examples</h2>
        <div className="examples">
          {TEMPLATES.map((t) => (
            <button key={t.slug} className="card" onClick={() => openTemplate(t.slug)} title={t.summary}>
              <Preview design={t.design} />
              <strong>{t.name}</strong>
              <span>{t.summary}</span>
            </button>
          ))}
          <button className="card blank" onClick={newBlank}>
            <span className="blank-icon">
              <Plus aria-hidden />
            </span>
            <strong>Blank canvas</strong>
            <span>Build it yourself.</span>
          </button>
        </div>

        {recent.length > 0 && (
          <>
            <h2 className="start-label">Your designs</h2>
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
      {over && (
        <div className="drop-overlay" aria-hidden>
          <ImageUp />
          Drop the photo to read it
        </div>
      )}
    </div>
  )
}
