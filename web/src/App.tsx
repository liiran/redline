import { Button } from "@ui-sdk/react/button"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu"
import { ToastRegion } from "@ui-sdk/react/toast"
import { ReactFlowProvider, useReactFlow } from "@xyflow/react"
import { Image, ImageOff, LayoutGrid, Loader2, Maximize, Play, Plus, Redo2, Search, Square, Undo2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { CATALOG, KINDS, type Kind } from "../../shared/catalog.ts"
import { validate } from "../../shared/validate.ts"
import { addBox, openSaved, readPhoto, run, stop, tidy } from "./actions.ts"
import { api, listen } from "./api.ts"
import { Canvas, FIT } from "./Canvas.tsx"
import { Tip } from "./Controls.tsx"
import { DescribeDialog, SketchDialog } from "./Dialogs.tsx"
import { imageFrom } from "./image.ts"
import { KindIcon } from "./kinds.tsx"
import { Palette } from "./Palette.tsx"
import { Panel } from "./Panel.tsx"
import { Start } from "./Start.tsx"
import { useApp } from "./store.ts"

/** A gauge whose last stretch is red, with the needle in it: the redline on a rev counter. */
function Logo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M3.5 17a8.5 8.5 0 0 1 14.51-6.01" stroke="currentColor" />
      <path d="M18.01 10.99A8.5 8.5 0 0 1 20.5 17" stroke="var(--red)" />
      <path d="M12 17l5-3.6" stroke="var(--red)" />
      <circle cx="12" cy="17" r="1.6" fill="var(--red)" stroke="none" />
    </svg>
  )
}

function RunStatus() {
  const session = useApp((s) => s.session)
  if (!session || session.phase === "stopped") return null
  const text =
    session.phase === "ready"
      ? session.ramp?.running
        ? `Testing at ${session.ramp.current ?? 0} req/s`
        : `${session.containers} containers running`
      : session.phase === "failed"
        ? "Didn't start"
        : session.step
  const dot = session.phase === "ready" ? "live" : session.phase === "failed" ? "bad" : "busy"
  return (
    <span className="run-status hide-narrow">
      <span className={`dot ${dot}`} />
      {text}
    </span>
  )
}

function CanvasTools() {
  const flow = useReactFlow()
  const design = useApp((s) => s.design)
  const showPhoto = useApp((s) => s.showPhoto)
  const app = useApp.getState()
  const canUndo = useApp((s) => s.history.length > 0)
  const canRedo = useApp((s) => s.future.length > 0)
  if (!design) return null
  const hasClient = design.nodes.some((n) => n.kind === "client")
  return (
    <div className="canvas-tools">
      <Menu
        onAction={(value) => {
          const center = flow.screenToFlowPosition({ x: window.innerWidth * 0.4, y: window.innerHeight * 0.5 })
          addBox(value as Kind, center)
        }}
      >
        <MenuTrigger className="btn sm">
          <Plus aria-hidden /> Add box
        </MenuTrigger>
        <MenuContent className="menu">
          {KINDS.filter((k) => k !== "client" || !hasClient).map((kind) => (
            <MenuItem key={kind} value={kind} label={CATALOG[kind].title}>
              <KindIcon kind={kind} />
              {CATALOG[kind].title}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <Tip text="Undo (Ctrl+Z)">
        <button className="btn sm icon ghost" aria-label="Undo" onClick={app.undo} disabled={!canUndo}>
          <Undo2 aria-hidden />
        </button>
      </Tip>
      <Tip text="Redo (Ctrl+Shift+Z)">
        <button className="btn sm icon ghost" aria-label="Redo" onClick={app.redo} disabled={!canRedo}>
          <Redo2 aria-hidden />
        </button>
      </Tip>
      {design.photo && (
        <Tip text={showPhoto ? "Hide the photo" : "Show the photo"}>
          <button className="btn sm icon ghost" aria-label={showPhoto ? "Hide the photo" : "Show the photo"} onClick={app.togglePhoto}>
            {showPhoto ? <ImageOff aria-hidden /> : <Image aria-hidden />}
          </button>
        </Tip>
      )}
      <Tip text="Tidy up: line boxes up in the order requests flow">
        <button className="btn sm icon ghost" aria-label="Tidy up" onClick={() => {
          tidy()
          setTimeout(() => flow.fitView({ ...FIT, duration: 250 }), 30)
        }}>
          <LayoutGrid aria-hidden />
        </button>
      </Tip>
      <Tip text="Fit to screen">
        <button className="btn sm icon ghost" aria-label="Fit to screen" onClick={() => flow.fitView({ ...FIT, duration: 250 })}>
          <Maximize aria-hidden />
        </button>
      </Tip>
    </div>
  )
}

function Reading() {
  const reading = useApp((s) => s.reading)
  if (!reading) return null
  return (
    <div className="scan" role="status" aria-live="polite">
      <div className="scan-card">
        {reading.preview && <img src={reading.preview} alt="" />}
        {reading.preview && <div className="scan-line" />}
        <div className="scan-text">
          <Loader2 className="spin" aria-hidden style={{ width: 14, height: 14 }} />
          {reading.label}…
        </div>
      </div>
    </div>
  )
}

function Workspace() {
  const design = useApp((s) => s.design)!
  const designId = useApp((s) => s.designId)
  const status = useApp((s) => s.status)
  const issues = useMemo(() => validate(design, status?.docker.ok ? status.docker.cpus : undefined), [design, status])
  return (
    <div className="workspace">
      <div className="stage">
        <ReactFlowProvider key={designId ?? "new"}>
          <Canvas design={design} issues={issues} />
          <CanvasTools />
        </ReactFlowProvider>
        <Reading />
      </div>
      <Panel design={design} issues={issues} />
    </div>
  )
}

export function App() {
  const design = useApp((s) => s.design)
  const session = useApp((s) => s.session)
  const status = useApp((s) => s.status)
  const theme = useApp((s) => s.theme)
  const edit = useApp((s) => s.edit)
  const [sketch, setSketch] = useState(false)
  const [describe, setDescribe] = useState(false)
  const photoInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState("")

  useEffect(() => setName(design?.name ?? ""), [design?.name])

  useEffect(() => {
    document.documentElement.dataset.theme = theme === "system" ? "" : theme
    if (theme === "system") delete document.documentElement.dataset.theme
  }, [theme])

  useEffect(() => {
    const app = useApp.getState()
    const sync = async () => {
      try {
        app.setStatus(await api.status())
        const current = await api.session()
        if (current) {
          const { samples, ...view } = current
          useApp.getState().setSession(view, samples)
          if (!useApp.getState().design && view.phase !== "stopped") {
            if (view.designId) await openSaved(view.designId)
            else useApp.getState().open(view.design, null)
          }
        }
      } catch {}
    }
    void sync()
    return listen({
      open: sync,
      state: (view) => useApp.getState().setSession(view),
      sample: (sample) => useApp.getState().addSample(sample),
      test: () => {
        const id = useApp.getState().designId
        if (id) api.tests(id).then((tests) => useApp.getState().setTests(tests)).catch(() => {})
      },
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.closest("input, textarea, [contenteditable]") !== null)
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault()
        useApp.getState().setPalette(!useApp.getState().paletteOpen)
        return
      }
      if (typing) return
      if (e.key === "Escape" && !document.querySelector("[role=dialog], [role=menu]")) useApp.getState().select(null)
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) useApp.getState().redo()
        else useApp.getState().undo()
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault()
        useApp.getState().redo()
      }
    }
    const onPaste = (e: ClipboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea")) return
      const file = imageFrom(e.clipboardData?.items)
      if (file && useApp.getState().status?.ai) {
        e.preventDefault()
        void readPhoto(file)
      }
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("paste", onPaste)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("paste", onPaste)
    }
  }, [])

  useEffect(() => {
    if (status?.docker.ok !== false) return
    const timer = setInterval(() => api.status().then((next) => useApp.getState().setStatus(next)).catch(() => {}), 5000)
    return () => clearInterval(timer)
  }, [status?.docker.ok])

  const running = session && (session.phase === "ready" || session.phase === "starting")

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => useApp.getState().close()} aria-label="Redline home">
          <Logo />
          <span>Redline</span>
        </button>
        {design && (
          <>
            <span className="crumb">/</span>
            <input
              className="name-input"
              aria-label="Design name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name.trim() !== design.name && edit((d) => ({ ...d, name: name.trim() }))}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </>
        )}
        <span className="spacer" />
        <RunStatus />
        <Tip text="Commands (Ctrl+K)">
          <button className="btn ghost sm" aria-label="Commands" onClick={() => useApp.getState().setPalette(true)}>
            <Search aria-hidden />
            <span className="hide-narrow">
              <kbd>Ctrl K</kbd>
            </span>
          </button>
        </Tip>
        {design &&
          (running ? (
            <Button className="btn sm" onClick={stop}>
              <Square aria-hidden /> Stop
            </Button>
          ) : (
            <Button className="btn sm primary" onClick={run} disabled={status?.docker.ok === false}>
              <Play aria-hidden /> Run
            </Button>
          ))}
      </header>

      {design ? (
        <Workspace />
      ) : (
        <div style={{ position: "relative", minHeight: 0 }}>
          <Start onSketch={() => setSketch(true)} />
          <Reading />
        </div>
      )}

      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = imageFrom(e.target.files)
          e.target.value = ""
          if (file) void readPhoto(file)
        }}
      />
      <SketchDialog open={sketch} onOpenChange={setSketch} />
      <DescribeDialog open={describe} onOpenChange={setDescribe} />
      <Palette onPhoto={() => photoInput.current?.click()} onSketch={() => setSketch(true)} onDescribe={() => setDescribe(true)} />
      <ToastRegion side="bottom" align="end" />
    </div>
  )
}
