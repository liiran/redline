import { ArrowUp, ImageUp, PenLine, Plus } from "lucide-react"
import { useRef, useState } from "react"
import { TEMPLATES } from "../../shared/templates.ts"
import { newBlank, openTemplate, readPhoto, readText } from "./actions.ts"
import { imageFrom } from "./image.ts"
import { SampleCanvas } from "./Canvas.tsx"
import { Preview } from "./Preview.tsx"
import { useApp } from "./store.ts"

const IDEAS = ["A chat app with push alerts", "Ticket sales with a queue"]

export function Start({ onSketch }: { onSketch: () => void }) {
  const status = useApp((s) => s.status)
  const busy = useApp((s) => !!s.reading)
  const [over, setOver] = useState(false)
  const [text, setText] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const ai = !!status?.ai

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
        <div className="headline">
          <div>
            <h1 className="hero">
              <span className="hero-1">Find where your</span> <span className="hero-2">system <em>breaks</em>.</span>
            </h1>
            <p className="lede">Describe it, sketch it or upload a photo. Every box runs as a real container, so every number is measured.</p>
          </div>
          <figure className="sample-window" aria-label="A sample design under load">
            <SampleCanvas />
          </figure>
        </div>

        <div className="start-main">

          {status && !status.docker.ok && (
            <div className="notice bad" style={{ marginBottom: 16 }}>
              <span>{status.docker.error}</span>
            </div>
          )}

          <div className="start-actions">
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
        </div>

        <section className="start-examples">
          <h2 className="start-label">Start from an example</h2>
          <div className="examples">
            {TEMPLATES.map((t) => (
              <button key={t.slug} className="card" onClick={() => openTemplate(t.slug)}>
                <Preview design={t.design} />
                <span className="card-text">
                  <strong>{t.name}</strong>
                  <span>{t.summary}</span>
                </span>
              </button>
            ))}
            <button className="card blank" onClick={newBlank}>
              <span className="blank-icon">
                <Plus aria-hidden />
              </span>
              <span className="card-text">
                <strong>Blank canvas</strong>
                <span>Build it yourself.</span>
              </span>
            </button>
          </div>
        </section>
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
