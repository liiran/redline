import { create } from "zustand"
import type { Design } from "../../shared/design.ts"
import type { Sample } from "../../shared/samples.ts"
import { api, type SessionView, type Status, type TestRow } from "./api.ts"

export type Theme = "system" | "light" | "dark"

type State = {
  status: Status | null
  design: Design | null
  designId: string | null
  history: Design[]
  future: Design[]
  selected: string | null
  session: SessionView | null
  samples: Sample[]
  tests: TestRow[]
  reading: { busy: boolean; preview: string | null; label: string } | null
  showPhoto: boolean
  theme: Theme
  paletteOpen: boolean
}

type Actions = {
  setStatus(status: Status): void
  open(design: Design, designId: string | null): void
  close(): void
  edit(change: (design: Design) => Design, options?: { coalesce?: string }): void
  undo(): void
  redo(): void
  select(id: string | null): void
  setSession(view: SessionView | null, samples?: Sample[]): void
  addSample(sample: Sample): void
  setTests(tests: TestRow[]): void
  setReading(reading: State["reading"]): void
  togglePhoto(): void
  setTheme(theme: Theme): void
  setPalette(open: boolean): void
}

const KEEP = 600

function readTheme(): Theme {
  try {
    const value = localStorage.getItem("redline.theme")
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let lastCoalesce: { key: string; at: number } | null = null

export const useApp = create<State & Actions>((set, get) => ({
  status: null,
  design: null,
  designId: null,
  history: [],
  future: [],
  selected: null,
  session: null,
  samples: [],
  tests: [],
  reading: null,
  showPhoto: true,
  theme: readTheme(),
  paletteOpen: false,

  setStatus: (status) => set({ status }),

  open: (design, designId) => {
    const id = designId ?? newId()
    set({ design, designId: id, history: [], future: [], selected: null, tests: [] })
    if (designId) api.tests(id).then((tests) => get().designId === id && set({ tests })).catch(() => {})
    else api.saveDesign(design, id).catch(() => {})
  },

  close: () => set({ design: null, designId: null, history: [], future: [], selected: null, tests: [] }),

  edit: (change, options) => {
    const current = get().design
    if (!current) return
    const next = change(current)
    if (next === current) return
    const now = Date.now()
    const coalesce = options?.coalesce && lastCoalesce?.key === options.coalesce && now - lastCoalesce.at < 1200
    lastCoalesce = options?.coalesce ? { key: options.coalesce, at: now } : null
    set({
      design: next,
      history: coalesce ? get().history : [...get().history.slice(-79), current],
      future: [],
    })
    scheduleSave()
  },

  undo: () => {
    const { history, design, future } = get()
    const previous = history.at(-1)
    if (!previous || !design) return
    set({ design: previous, history: history.slice(0, -1), future: [design, ...future] })
    scheduleSave()
  },

  redo: () => {
    const { history, design, future } = get()
    const next = future[0]
    if (!next || !design) return
    set({ design: next, history: [...history, design], future: future.slice(1) })
    scheduleSave()
  },

  select: (selected) => set({ selected }),

  setSession: (session, samples) => set(samples ? { session, samples: samples.slice(-KEEP) } : { session }),

  addSample: (sample) => {
    const samples = get().samples
    if (samples.at(-1)?.seq === sample.seq) return
    const next = samples.length >= KEEP ? [...samples.slice(-(KEEP - 1)), sample] : [...samples, sample]
    set({ samples: next })
  },

  setTests: (tests) => set({ tests }),
  setReading: (reading) => set({ reading }),
  togglePhoto: () => set({ showPhoto: !get().showPhoto }),
  setTheme: (theme) => {
    try {
      localStorage.setItem("redline.theme", theme)
    } catch {}
    set({ theme })
  },
  setPalette: (paletteOpen) => set({ paletteOpen }),
}))

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const { design, designId } = useApp.getState()
    if (!design) return
    api.saveDesign(design, designId).catch(() => {})
  }, 500)
}

export function currentSample(state: Pick<State, "samples" | "session">) {
  if (!state.session || state.session.phase !== "ready") return undefined
  return state.samples.at(-1)
}
