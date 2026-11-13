import type { Design } from "../../shared/design.ts"
import type { Sample } from "../../shared/samples.ts"
import type { Template } from "../../shared/templates.ts"
import type { RampResult, Step } from "../../shared/results.ts"

export type { RampResult, Step }

export type Phase = "starting" | "ready" | "stopping" | "stopped" | "failed"

export type RampState = {
  testId: string
  running: boolean
  steps: Step[]
  current: number | null
  startedAt: number
  result: RampResult | null
}

export type SessionView = {
  id: string
  designId: string | null
  design: Design
  phase: Phase
  step: string
  log: string[]
  error: string | null
  startedAt: number
  readyMs: number | null
  containers: number
  rate: number
  ramp: RampState | null
}

export type Status = {
  docker: { ok: true; cpus: number; memoryGb: number; version: string } | { ok: false; error: string }
  ai: { via: "cli" | "api"; model: string } | null
  session: SessionView | null
}

export type DesignSummary = { id: string; name: string; updatedAt: number; boxes: number; photo: string | null }

export type TestRow = {
  id: string
  designId: string | null
  name: string
  design: Design
  startedAt: number
  finishedAt: number
  result: RampResult
}

export type Reading = { design: Design; ms: number; model: string; costUsd: number | null; boxes: number; arrows: number }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const write = method !== "GET"
  const res = await fetch(path, {
    method,
    headers: write ? { "Content-Type": "application/json" } : undefined,
    body: write ? JSON.stringify(body ?? {}) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`)
  return data as T
}

export const api = {
  status: () => call<Status>("GET", "/api/status"),
  templates: () => call<Template[]>("GET", "/api/templates"),
  designs: () => call<DesignSummary[]>("GET", "/api/designs"),
  design: (id: string) => call<{ id: string; design: Design }>("GET", `/api/designs/${id}`),
  saveDesign: (design: Design, id?: string | null) => call<{ id: string }>("POST", "/api/designs", { design, id: id ?? undefined }),
  deleteDesign: (id: string) => call<{ ok: true }>("DELETE", `/api/designs/${id}`),
  readImage: (image: { data: string; mediaType: string; width: number; height: number }) => call<Reading>("POST", "/api/read", { image }),
  readText: (text: string) => call<Reading>("POST", "/api/read", { text }),
  session: () => call<(SessionView & { samples: Sample[] }) | null>("GET", "/api/session"),
  start: (design: Design, designId: string | null) => call<SessionView>("POST", "/api/session", { design, designId }),
  stop: () => call<SessionView | null>("DELETE", "/api/session"),
  rate: (rps: number) => call<SessionView>("POST", "/api/session/rate", { rps }),
  ramp: () => call<SessionView>("POST", "/api/session/ramp", {}),
  stopRamp: () => call<SessionView>("POST", "/api/session/ramp/stop", {}),
  tests: (designId?: string | null) => call<TestRow[]>("GET", `/api/tests${designId ? `?designId=${designId}` : ""}`),
}

export function photoUrl(id: string) {
  return `/api/photos/${id}`
}

export function listen(handlers: { state: (view: SessionView) => void; sample: (sample: Sample) => void; test: () => void; open: () => void }) {
  let source: EventSource | null = null
  let closed = false
  let retry = 0
  const connect = () => {
    source = new EventSource("/api/events")
    source.addEventListener("hello", () => {
      retry = 0
      handlers.open()
    })
    source.addEventListener("state", (event) => handlers.state(JSON.parse((event as MessageEvent).data)))
    source.addEventListener("sample", (event) => handlers.sample(JSON.parse((event as MessageEvent).data)))
    source.addEventListener("test", () => handlers.test())
    source.onerror = () => {
      source?.close()
      if (!closed) setTimeout(connect, Math.min(5000, 500 * 2 ** retry++))
    }
  }
  connect()
  return () => {
    closed = true
    source?.close()
  }
}
