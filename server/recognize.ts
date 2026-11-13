import Anthropic from "@anthropic-ai/sdk"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { KINDS } from "../shared/catalog.ts"
import type { Design } from "../shared/design.ts"
import { fromSketch, layout, sketchSchema, type Sketch } from "../shared/normalize.ts"

export const DEFAULT_MODEL = "claude-opus-5-5"

export type Image = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; width: number; height: number }

export type Reading = { sketch: Sketch; model: string; costUsd: number | null }

export type Reader = {
  name: "cli" | "api"
  model: string
  read(input: { image?: Image; text?: string }, signal?: AbortSignal): Promise<Reading>
}

// Written out by hand: structured outputs reject numeric and length limits, so the schema
// carries none, and sketchSchema checks the answer afterwards.
export const WIRE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["nodes", "edges"],
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "label", "kind", "box", "replicas"],
        properties: {
          ref: { type: "string" },
          label: { type: "string" },
          kind: { type: "string", enum: [...KINDS, "unknown"] },
          box: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "w", "h"],
            properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
          },
          replicas: { anyOf: [{ type: "integer" }, { type: "null" }] },
        },
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to"],
        properties: { from: { type: "string" }, to: { type: "string" } },
      },
    },
  },
} as const

export const SYSTEM = `You turn drawings of software systems (whiteboards, paper, napkins, screenshots of diagram tools) into boxes and arrows, or do the same from a written description.

Nodes: every box, cylinder, cloud, stick figure or labelled shape that stands for a part of the system. Text that only labels an arrow is not a node. Ignore titles, notes, legends and anything crossed out.
- ref: a short id you make up (n1, n2, ...), unique.
- label: the text written in or beside the shape, as written; fix obvious misspellings. With no text, name it in one or two words.
- kind, the closest of:
  client: users, browsers, mobile apps, people, "internet"
  cdn: CDN, CloudFront, edge cache
  loadbalancer: load balancer, API gateway, reverse proxy, nginx, ingress
  service: any app server, API, backend, microservice, lambda or function
  worker: background worker, consumer, job processor, cron
  queue: queue, Kafka, SQS, RabbitMQ, pub/sub, event stream
  cache: Redis, Memcached, any cache
  database: any database or data store, including cylinders
  external: a third-party service the team doesn't run: Stripe, a payments or email or SMS provider, S3 or object storage
  unknown: you can't tell
- box: the shape's bounding box in pixels of the image (x and y of the top-left corner, then width and height). For a written description, use 0 for all four.
- replicas: how many copies, if the drawing or text says so (stacked boxes, "x3", "3 instances"); otherwise null.

Edges: one per arrow or connecting line, from the box at its tail to the box at its head. A line with no arrowhead runs from the side nearer the users to the side further away. A line with heads at both ends counts once, in the direction requests flow, from caller to callee.

If there is no system diagram at all, return empty lists.`

function prompt(input: { image?: Image; text?: string }) {
  if (input.image) return `This image is ${input.image.width} × ${input.image.height} pixels. List its boxes and arrows.`
  return `Describe this system as boxes and arrows:\n\n${input.text}`
}

type WireNode = { ref: string; label: string; kind: string; box: { x: number; y: number; w: number; h: number }; replicas: number | null }

export function fromWire(value: unknown): Sketch {
  const wire = value as { nodes?: WireNode[]; edges?: { from: string; to: string }[] }
  return sketchSchema.parse({
    nodes: (wire.nodes ?? []).slice(0, 40).map((node) => ({
      ref: String(node.ref).slice(0, 60),
      label: String(node.label ?? "").slice(0, 60),
      kind: node.kind,
      box: [node.box?.x ?? 0, node.box?.y ?? 0, node.box?.w ?? 0, node.box?.h ?? 0],
      replicas: node.replicas == null ? null : Math.max(1, Math.min(50, Math.round(node.replicas))),
    })),
    edges: (wire.edges ?? []).slice(0, 120),
  })
}

export function toDesign(sketch: Sketch, input: { image?: Image; text?: string }, photoId?: string): Design {
  if (input.image && photoId) {
    return fromSketch(sketch, { id: photoId, width: input.image.width, height: input.image.height }, "Whiteboard sketch")
  }
  return layout(fromSketch(sketch, undefined, "Described system"))
}

/** On Windows, npm installs claude behind a .cmd wrapper that Node can't start without a shell. */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.REDLINE_CLAUDE_BIN) return env.REDLINE_CLAUDE_BIN
  const names = process.platform === "win32" ? ["claude.exe"] : ["claude"]
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name)
    const inner = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
    if (process.platform === "win32" && existsSync(join(dir, "claude.cmd")) && existsSync(inner)) return inner
  }
  return null
}

/**
 * Uses the signed-in Claude Code CLI, so no API key is needed. The photo is the only input and
 * the CLI runs with every tool off, no settings, no MCP servers and from an empty folder.
 */
export function cliReader(bin: string, model = process.env.REDLINE_MODEL ?? DEFAULT_MODEL): Reader {
  const workdir = join(tmpdir(), "redline-reader")
  mkdirSync(workdir, { recursive: true })
  return {
    name: "cli",
    model,
    read(input, signal) {
      return new Promise((resolve, reject) => {
        const args = [
          "-p",
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--verbose",
          "--model", model,
          "--system-prompt", SYSTEM,
          "--json-schema", JSON.stringify(WIRE_SCHEMA),
          "--tools", "",
          "--strict-mcp-config",
          "--no-session-persistence",
          "--setting-sources", "",
        ]
        const child = spawn(bin, args, {
          cwd: workdir,
          windowsHide: true,
          env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
          signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
        })
        let out = ""
        let err = ""
        child.stdout.on("data", (chunk) => (out += chunk))
        child.stderr.on("data", (chunk) => (err += chunk))
        child.on("error", (error) =>
          reject(new Error(error.name === "AbortError" ? "Reading the drawing took too long." : `Claude Code couldn't start: ${error.message}`)),
        )
        child.on("close", () => {
          const lines = out.split("\n").filter((line) => line.trim().startsWith("{"))
          const result = lines.map((line) => JSON.parse(line)).find((line) => line.type === "result")
          if (!result) return reject(new Error(err.trim().split("\n").at(-1) || "Claude Code gave no answer. Is it signed in?"))
          if (result.is_error || result.subtype !== "success") return reject(new Error(String(result.result || "Claude couldn't read the drawing.")))
          try {
            resolve({ sketch: fromWire(result.structured_output ?? JSON.parse(result.result)), model, costUsd: result.total_cost_usd ?? null })
          } catch {
            reject(new Error("Claude's answer didn't fit the expected shape."))
          }
        })
        const content: unknown[] = []
        if (input.image) content.push({ type: "image", source: { type: "base64", media_type: input.image.mediaType, data: input.image.data } })
        content.push({ type: "text", text: prompt(input) })
        child.stdin.on("error", () => {})
        child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n")
      })
    },
  }
}

export function apiReader(client = new Anthropic(), model = process.env.REDLINE_MODEL ?? DEFAULT_MODEL): Reader {
  return {
    name: "api",
    model,
    async read(input, signal) {
      const content: Anthropic.Beta.BetaContentBlockParam[] = []
      if (input.image) content.push({ type: "image", source: { type: "base64", media_type: input.image.mediaType, data: input.image.data } })
      content.push({ type: "text", text: prompt(input) })
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: 16_000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: SYSTEM,
          output_config: { format: { type: "json_schema", schema: WIRE_SCHEMA as unknown as Record<string, unknown> } },
          messages: [{ role: "user", content }],
        },
        { signal, timeout: 120_000 },
      )
      if (response.stop_reason === "refusal") throw new Error("Claude declined to read this image.")
      if (response.stop_reason === "max_tokens") throw new Error("The drawing has more than Redline can read at once.")
      const text = response.content.find((block) => block.type === "text")
      if (!text || text.type !== "text") throw new Error("Claude gave no answer.")
      return { sketch: fromWire(JSON.parse(text.text)), model: response.model, costUsd: null }
    },
  }
}

export function pickReader(env: NodeJS.ProcessEnv = process.env): Reader | null {
  const choice = env.REDLINE_AI ?? "auto"
  if (choice === "off") return null
  if (choice === "api") return env.ANTHROPIC_API_KEY ? apiReader() : null
  const bin = findClaude(env)
  if (choice === "cli") return bin ? cliReader(bin) : null
  if (bin) return cliReader(bin)
  return env.ANTHROPIC_API_KEY ? apiReader() : null
}
