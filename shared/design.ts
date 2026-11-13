import { z } from "zod"
import { KINDS, settingsFor, type Kind, type Settings } from "./catalog.ts"

export const MAX_NODES = 24
export const ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/
export const RESERVED_IDS = new Set(["probe", "redline"])

const settingsSchema = z
  .object({
    cpus: z.number(),
    memoryMb: z.number(),
    replicas: z.number().int(),
    workMs: z.number(),
    pool: z.number().int(),
    ttlSec: z.number().int(),
    latencyMs: z.number(),
  })
  .partial()

export const nodeSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  kind: z.enum(KINDS),
  label: z.string().trim().min(1).max(40),
  x: z.number().finite(),
  y: z.number().finite(),
  settings: settingsSchema.default({}),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
})

export const edgeSchema = z.object({
  id: z.string().min(1).max(64),
  from: z.string(),
  to: z.string(),
})

export const workloadSchema = z.object({
  readRatio: z.number().min(0).max(1),
  keys: z.number().int().min(100).max(1_000_000),
  payloadBytes: z.number().int().min(16).max(65_536),
  sloP95Ms: z.number().int().min(10).max(10_000),
  timeoutMs: z.number().int().min(100).max(30_000),
})

export const designSchema = z.object({
  name: z.string().trim().min(1).max(80),
  nodes: z.array(nodeSchema).max(MAX_NODES),
  edges: z.array(edgeSchema).max(MAX_NODES * 4),
  workload: workloadSchema,
  photo: z
    .object({ id: z.string().regex(/^[a-f0-9]{16}$/), width: z.number().positive(), height: z.number().positive() })
    .optional(),
})

export type DesignNode = z.infer<typeof nodeSchema>
export type DesignEdge = z.infer<typeof edgeSchema>
export type Workload = z.infer<typeof workloadSchema>
export type Design = z.infer<typeof designSchema>

export const DEFAULT_WORKLOAD: Workload = {
  readRatio: 0.9,
  keys: 100_000,
  payloadBytes: 512,
  sloP95Ms: 250,
  timeoutMs: 2_000,
}

export function nodeSettings(node: Pick<DesignNode, "kind" | "settings">): Settings {
  return settingsFor(node.kind, node.settings)
}

export function slug(text: string) {
  const cleaned = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const trimmed = cleaned.replace(/^[^a-z]+/, "").slice(0, 20).replace(/-+$/, "")
  return trimmed || "box"
}

export function uniqueId(wanted: string, taken: Set<string>) {
  const root = slug(wanted)
  let id = RESERVED_IDS.has(root) ? `${root}-1` : root
  let n = 2
  while (taken.has(id) || RESERVED_IDS.has(id)) {
    id = `${root}-${n++}`
  }
  taken.add(id)
  return id
}

export function edgeId(from: string, to: string) {
  return `${from}->${to}`
}

export function kindCounts(design: Design) {
  const counts = new Map<Kind, number>()
  for (const node of design.nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1)
  return counts
}
