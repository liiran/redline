import Anthropic from "@anthropic-ai/sdk"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { KINDS } from "../shared/catalog.ts"
import type { Design } from "../shared/design.ts"
import { connectAll, fromSketch, layout, sketchSchema, type Sketch } from "../shared/normalize.ts"

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
  required: ["name", "nodes", "edges"],
  properties: {
    name: { type: "string" },
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

export const SYSTEM = `You turn drawings of software systems (whiteboards, paper, napkins, screenshots of diagram tools) into boxes and arrows.

name: a short title for the whole system, 2 to 5 words, like "URL shortener" or "Photo sharing app". Use the drawing's own title if it has one.

Nodes: every box, cylinder, cloud, stick figure or labelled shape that stands for a part of the system. Text that only labels an arrow is not a node. Ignore titles, sticky notes, to-do notes, legends and anything crossed out.
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
- replicas: how many copies, when the drawing shows more than one. A written count ("x3", "3 instances") wins. Otherwise count every outline in a stack of overlapping copies, the front one included: a box with two outlines peeking out behind it is 3. One plain box is null.

Edges: one per arrow or connecting line, from the box at its tail to the box at its head. A line with no arrowhead runs from the side nearer the users to the side further away. A line with heads at both ends counts once, in the direction requests flow, from caller to callee.

If there is no system diagram at all, return empty lists.`

export const DESIGN_SYSTEM = `You are a senior backend engineer. Someone describes a system in their own words; you design a clear, realistic architecture for it as boxes and arrows. Redline will run every box as a real container and load-test it, so the design must be one it can run.

The kinds of box Redline runs:
  client: the users or apps sending requests. Exactly one.
  cdn: an edge cache for static files and repeat reads (images, skins, downloads).
  loadbalancer: a load balancer or API gateway that spreads requests over the services behind it.
  service: application code that handles requests.
  worker: background code that takes jobs from a queue.
  queue: a job queue or event stream (Kafka, SQS, Redis Streams).
  cache: Redis or Memcached.
  database: a database such as PostgreSQL.
  external: a third-party service the team doesn't run (payments, email, push notifications, object storage).

Each arrow is a request or a job, from the box that sends it to the box that handles it. Only these arrows work:
  client -> cdn, loadbalancer or service
  cdn -> loadbalancer or service (where it fetches what it doesn't have)
  loadbalancer -> service
  service -> service, loadbalancer, cache, database, queue or external
  worker -> cache, database, queue, external or service
  queue -> worker

Rules:
- Every box must be reachable from the client by following arrows. No box may float on its own: a CDN must point at what it caches, a queue at the worker that drains it, and every cache, database and external service must be used by some service or worker.
- Keep it readable: 6 to 13 boxes. Use one box per distinct job under load, not per screen or feature. Group related features into one service ("Shop" serves the store and skins; "Profile" serves settings and region). Split a cache or database only when the description gives a reason, like leaderboards needing their own Redis.
- Don't add what wasn't asked for and isn't needed for the system to work (analytics warehouses, admin panels, monitoring).
- Real-time traffic that isn't request and answer (game servers over UDP, video calls) can't be load-tested here. Model the parts around it that are, like matchmaking and saving results, and leave the rest out.
- No loops of service calls.
- label: 1 to 3 words, at most 20 characters, without the kind repeated or technology in brackets: "Matchmaking", "Shop", "Player DB", "Leaderboard cache".
- name: what the system is, 2 to 5 words, like "Battle royale backend". Never a sentence or the description itself.
- replicas: 2 for at most two of the busiest stateless services, otherwise null. Everything runs on one laptop.
- box: 0 for all four.
- ref: n1, n2, ...

If the description isn't a software system at all, return empty lists and an empty name.`

function prompt(input: { image?: Image; text?: string }) {
  if (input.image) return `This image is ${input.image.width} × ${input.image.height} pixels. List its boxes and arrows.`
  return `Design this system as boxes and arrows:\n\n${input.text}`
}

function systemFor(input: { image?: Image; text?: string }) {
  return input.image ? SYSTEM : DESIGN_SYSTEM
}

type WireNode = { ref: string; label: string; kind: string; box: { x: number; y: number; w: number; h: number }; replicas: number | null }

export function fromWire(value: unknown): Sketch {
  const wire = value as { name?: string; nodes?: WireNode[]; edges?: { from: string; to: string }[] }
  return sketchSchema.parse({
    name: typeof wire.name === "string" ? wire.name.slice(0, 200) : null,
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

/**
 * Turns a reading into a design. Boxes nothing would reach get connected (`added` lists those arrows,
 * so the page can say so). A photo keeps the boxes where they were drawn; a description is laid out.
 */
export function toDesign(sketch: Sketch, input: { image?: Image; text?: string }, photoId?: string): { design: Design; added: number } {
  const drawn = input.image && photoId
  const raw = drawn
    ? fromSketch(sketch, { id: photoId, width: input.image!.width, height: input.image!.height }, "Whiteboard sketch")
    : fromSketch(sketch, undefined, "New system")
  const { design, added } = connectAll(raw)
  return { design: drawn ? design : layout(design), added: added.length }
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
          "--system-prompt", systemFor(input),
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
          system: systemFor(input),
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
