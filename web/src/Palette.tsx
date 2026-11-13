import { Command, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList } from "@ui-sdk/react/command"
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from "@ui-sdk/react/dialog"
import { Camera, FileText, FolderOpen, Gauge, Home, Image, Moon, PenLine, Play, Plus, Redo2, Square, Sun, SunMoon, Undo2 } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { CATALOG, KINDS } from "../../shared/catalog.ts"
import { TEMPLATES } from "../../shared/templates.ts"
import { addBox, findBreakingPoint, newBlank, openSaved, openTemplate, run, stop } from "./actions.ts"
import { api, type DesignSummary } from "./api.ts"
import { KindIcon } from "./kinds.tsx"
import { useApp } from "./store.ts"

type Item = { value: string; label: string; icon: ReactNode; hint?: string; run: () => void; when?: boolean }

export function Palette({ onPhoto, onSketch, onDescribe }: { onPhoto: () => void; onSketch: () => void; onDescribe: () => void }) {
  const open = useApp((s) => s.paletteOpen)
  const setOpen = useApp((s) => s.setPalette)
  const design = useApp((s) => s.design)
  const session = useApp((s) => s.session)
  const theme = useApp((s) => s.theme)
  const [saved, setSaved] = useState<DesignSummary[]>([])

  useEffect(() => {
    if (open) api.designs().then(setSaved).catch(() => {})
  }, [open])

  const running = session && (session.phase === "ready" || session.phase === "starting")
  const app = useApp.getState()

  const groups: { label: string; items: Item[] }[] = [
    {
      label: "Run",
      items: [
        { value: "run", label: "Run in Docker", icon: <Play />, run: run, when: !!design && !running },
        { value: "ramp", label: "Find the breaking point", icon: <Gauge />, run: findBreakingPoint, when: session?.phase === "ready" && !session.ramp?.running },
        { value: "stop", label: "Stop containers", icon: <Square />, run: stop, when: !!running },
      ],
    },
    {
      label: "Design",
      items: [
        { value: "photo", label: "Read a photo", icon: <Camera />, run: onPhoto },
        { value: "sketch", label: "Sketch a system", icon: <PenLine />, run: onSketch },
        { value: "describe", label: "Describe a system in words", icon: <FileText />, run: onDescribe },
        { value: "blank", label: "Start from scratch", icon: <Plus />, run: newBlank },
        { value: "toggle-photo", label: "Show or hide the photo", icon: <Image />, run: app.togglePhoto, when: !!design?.photo },
        { value: "undo", label: "Undo", icon: <Undo2 />, hint: "Ctrl Z", run: app.undo, when: !!design },
        { value: "redo", label: "Redo", icon: <Redo2 />, hint: "Ctrl Shift Z", run: app.redo, when: !!design },
        { value: "home", label: "Back to start", icon: <Home />, run: app.close, when: !!design },
      ],
    },
    {
      label: "Add a box",
      items: KINDS.filter((k) => k !== "client").map((kind) => ({
        value: `add-${kind}`,
        label: `Add ${CATALOG[kind].title.toLowerCase()}`,
        icon: <KindIcon kind={kind} />,
        run: () => addBox(kind),
        when: !!design,
      })),
    },
    {
      label: "Examples",
      items: TEMPLATES.map((t) => ({ value: `t-${t.slug}`, label: t.name, icon: <FolderOpen />, hint: "example", run: () => openTemplate(t.slug) })),
    },
    {
      label: "Your designs",
      items: saved.slice(0, 12).map((d) => ({ value: `d-${d.id}`, label: d.name, icon: <FolderOpen />, run: () => openSaved(d.id) })),
    },
    {
      label: "Theme",
      items: [
        { value: "theme-system", label: "Theme: match the system", icon: <SunMoon />, hint: theme === "system" ? "on" : undefined, run: () => app.setTheme("system") },
        { value: "theme-light", label: "Theme: light", icon: <Sun />, hint: theme === "light" ? "on" : undefined, run: () => app.setTheme("light") },
        { value: "theme-dark", label: "Theme: dark", icon: <Moon />, hint: theme === "dark" ? "on" : undefined, run: () => app.setTheme("dark") },
      ],
    },
  ]
  const actions = new Map(groups.flatMap((g) => g.items).map((item) => [item.value, item.run]))

  return (
    <Dialog open={open} onOpenChange={(next) => setOpen(next)}>
      <DialogBackdrop />
      <DialogContent className="palette">
        <DialogTitle className="sr-only">Commands</DialogTitle>
        <Command
          loop
          onAction={(value) => {
            setOpen(false)
            actions.get(value)?.()
          }}
        >
          <CommandInput aria-label="Search commands" placeholder="Type a command or search…" />
          <CommandEmpty>{(state) => (state.empty ? `Nothing matches “${state.query}”.` : null)}</CommandEmpty>
          <CommandList>
            {groups.map((group) => {
              const items = group.items.filter((item) => item.when !== false)
              if (!items.length) return null
              return (
                <CommandGroup key={group.label}>
                  <CommandGroupLabel>{group.label}</CommandGroupLabel>
                  {items.map((item) => (
                    <CommandItem key={item.value} value={item.value} label={item.label}>
                      {item.icon}
                      {item.label}
                      {item.hint && <span className="hint">{item.hint}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
