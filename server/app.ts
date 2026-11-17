import { existsSync, readFileSync, statSync } from "node:fs"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join, normalize, sep } from "node:path"
import { z } from "zod"
import { designSchema, type Design } from "../shared/design.ts"
import { TEMPLATES } from "../shared/templates.ts"
import { canRun, validate } from "../shared/validate.ts"
import type { Docker } from "./docker.ts"
import type { Image, Reader } from "./recognize.ts"
import { toDesign } from "./recognize.ts"
import { DockerRuntime } from "./docker-runtime.ts"
import { Session, type Runtime } from "./session.ts"
import type { Store } from "./store.ts"

export const DIST = join(import.meta.dirname, "..", "dist")

const imageSchema = z.object({
  data: z.string().min(16).max(8_000_000).regex(/^[A-Za-z0-9+/=]+$/),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
})

const readSchema = z.union([z.object({ image: imageSchema }), z.object({ text: z.string().trim().min(3).max(4000) })])

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
}

/** The first bytes every file of each type starts with. A photo that doesn't match is refused, not stored. */
const SIGNATURES: Record<Image["mediaType"], (bytes: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type AppOptions = {
  store: Store
  docker: Docker
  reader: Reader | null
  port: number
  dist?: string
  runtime?: (design: Design, runId: string) => Runtime
  ramp?: { settle?: number; hold?: number }
}

export class App {
  readonly server: http.Server
  session: Session | null = null
  #clients = new Set<ServerResponse>()
  #options: AppOptions
  #hostCpus: number | undefined
  /** Runs being stopped, one after another, so a new run only starts once the old ones are gone. */
  #teardown: Promise<void> = Promise.resolve()

  constructor(options: AppOptions) {
    this.#options = options
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500
        if (status === 500) console.error(error)
        const message = error instanceof z.ZodError ? "That request didn't have the expected shape." : error instanceof Error ? error.message : "Something went wrong."
        if (!res.headersSent) this.#json(res, status, { error: message })
        else res.end()
      })
    })
  }

  listen() {
    return new Promise<void>((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(this.#options.port, "127.0.0.1", () => resolve())
    })
  }

  get port() {
    const address = this.server.address()
    return typeof address === "object" && address ? address.port : this.#options.port
  }

  async close() {
    await this.#teardown
    await this.session?.stop()
    for (const client of this.#clients) client.end()
    this.#clients.clear()
    await new Promise((resolve) => this.server.close(resolve))
  }

  #json(res: ServerResponse, status: number, body: unknown) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    })
    res.end(text)
  }

  #broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.#clients) {
      if (client.writableEnded || client.destroyed) this.#clients.delete(client)
      else client.write(payload)
    }
  }

  /**
   * Only this machine's browser, on Redline's own page, may change anything. A web page on
   * another site can't send JSON here without a preflight, and the Host check stops DNS rebinding.
   */
  #guard(req: IncomingMessage) {
    const port = this.port
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`]
    if (!allowed.includes(req.headers.host ?? "")) throw new HttpError(403, "Redline only answers on 127.0.0.1.")
    if (req.method === "GET" || req.method === "HEAD") return
    const origin = req.headers.origin
    if (origin && !allowed.some((host) => origin === `http://${host}`)) throw new HttpError(403, "Requests from other sites are refused.")
    const site = req.headers["sec-fetch-site"]
    if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "Requests from other sites are refused.")
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Send JSON.")
  }

  async #body(req: IncomingMessage, limit: number) {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new HttpError(413, "That's too big.")
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString("utf8")
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw new HttpError(400, "That isn't valid JSON.")
    }
  }

  async #hostCpusOnce() {
    if (this.#hostCpus === undefined) {
      const info = await this.#options.docker.info()
      if (info.ok) this.#hostCpus = info.cpus
    }
    return this.#hostCpus
  }

  /** Only the current run reaches the page, so a run being replaced can't overwrite what it shows. */
  #attach(session: Session) {
    session.on("state", (view) => this.session === session && this.#broadcast("state", view))
    session.on("sample", (sample) => this.session === session && this.#broadcast("sample", sample))
    session.on("test", (id) => this.#broadcast("test", { id }))
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    this.#guard(req)
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname
    const { store, docker, reader } = this.#options
    const route = `${req.method} ${path}`

    if (!path.startsWith("/api/")) return this.#static(path, res)

    if (route === "GET /api/status") {
      const info = await docker.info()
      if (info.ok) this.#hostCpus = info.cpus
      return this.#json(res, 200, {
        docker: info,
        ai: reader ? { via: reader.name, model: reader.model } : null,
        session: this.session?.view() ?? null,
      })
    }

    if (route === "GET /api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      })
      res.write(`event: hello\ndata: {}\n\n`)
      this.#clients.add(res)
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000)
      req.on("close", () => {
        clearInterval(ping)
        this.#clients.delete(res)
      })
      return
    }

    if (route === "GET /api/templates") return this.#json(res, 200, TEMPLATES)

    if (route === "GET /api/designs") return this.#json(res, 200, store.listDesigns())

    if (route === "POST /api/designs") {
      const body = await this.#body(req, 1_000_000)
      const design = designSchema.parse(body.design)
      const id = typeof body.id === "string" && /^[a-f0-9]{16}$/.test(body.id) ? body.id : undefined
      return this.#json(res, 200, { id: store.saveDesign(design, id) })
    }

    let match = path.match(/^\/api\/designs\/([a-f0-9]{16})$/)
    if (match) {
      if (req.method === "GET") {
        const row = store.getDesign(match[1]!)
        if (!row) throw new HttpError(404, "That design is gone.")
        return this.#json(res, 200, row)
      }
      if (req.method === "DELETE") {
        store.deleteDesign(match[1]!)
        return this.#json(res, 200, { ok: true })
      }
    }

    match = path.match(/^\/api\/photos\/([a-f0-9]{16})$/)
    if (match && req.method === "GET") {
      const photo = store.readPhoto(match[1]!)
      if (!photo) throw new HttpError(404, "That photo is gone.")
      res.writeHead(200, {
        "Content-Type": photo.type,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      })
      return res.end(photo.bytes)
    }

    if (route === "POST /api/read") {
      if (!reader) throw new HttpError(503, "Reading drawings needs Claude Code signed in, or an ANTHROPIC_API_KEY.")
      const input = readSchema.parse(await this.#body(req, 12_000_000)) as { image?: Image; text?: string }
      const bytes = input.image ? Buffer.from(input.image.data, "base64") : null
      if (input.image && !SIGNATURES[input.image.mediaType](bytes!)) throw new HttpError(400, `That file isn't a ${input.image.mediaType.slice(6).toUpperCase()} image.`)
      const started = Date.now()
      const reading = await reader.read(input).catch((error) => {
        throw new HttpError(502, error instanceof Error ? error.message : String(error))
      })
      const photoId = input.image ? store.savePhoto(bytes!, input.image.mediaType) : undefined
      const { design, added } = toDesign(reading.sketch, input, photoId)
      return this.#json(res, 200, {
        design,
        ms: Date.now() - started,
        model: reading.model,
        costUsd: reading.costUsd,
        boxes: design.nodes.length,
        arrows: design.edges.length - added,
        added,
      })
    }

    if (route === "GET /api/session") {
      if (!this.session) return this.#json(res, 200, null)
      return this.#json(res, 200, { ...this.session.view(), samples: this.session.samples.slice(-300) })
    }

    if (route === "POST /api/session") {
      const body = await this.#body(req, 1_000_000)
      const design = designSchema.parse(body.design)
      const issues = validate(design, await this.#hostCpusOnce())
      if (!canRun(issues)) throw new HttpError(400, issues.find((issue) => issue.level === "error")!.message)
      const designId = typeof body.designId === "string" && /^[a-f0-9]{16}$/.test(body.designId) ? body.designId : null
      const runtime = this.#options.runtime ?? ((d: Design, runId: string) => new DockerRuntime(docker, d, runId, store.dir))
      const session = new Session({ store, runtime: (runId) => runtime(design, runId), ramp: this.#options.ramp }, design, designId)
      // Taken over at once, so two Run clicks at the same moment can't both start containers: the
      // newest wins, and every run before it is stopped first, in order.
      const previous = this.session
      this.session = session
      this.#attach(session)
      const teardown = (this.#teardown = this.#teardown.then(() => previous?.stop()).catch(() => {}))
      await teardown
      if (this.session === session) void session.start()
      return this.#json(res, 200, (this.session ?? session).view())
    }

    if (route === "DELETE /api/session") {
      await this.session?.stop()
      return this.#json(res, 200, this.session?.view() ?? null)
    }

    if (route === "POST /api/session/rate") {
      if (!this.session) throw new HttpError(409, "Nothing is running.")
      const { rps } = z.object({ rps: z.number().min(0).max(20_000) }).parse(await this.#body(req, 1000))
      await this.session.setRate(rps).catch((error) => {
        throw new HttpError(409, error.message)
      })
      return this.#json(res, 200, this.session.view())
    }

    if (route === "POST /api/session/ramp") {
      if (!this.session) throw new HttpError(409, "Nothing is running.")
      try {
        this.session.startRamp()
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : String(error))
      }
      return this.#json(res, 200, this.session.view())
    }

    if (route === "POST /api/session/ramp/stop") {
      this.session?.stopRamp()
      return this.#json(res, 200, this.session?.view() ?? null)
    }

    if (route === "GET /api/tests") {
      const designId = url.searchParams.get("designId") ?? undefined
      return this.#json(res, 200, store.listTests(designId && /^[a-f0-9]{16}$/.test(designId) ? designId : undefined))
    }

    match = path.match(/^\/api\/tests\/([a-f0-9]{16})$/)
    if (match && req.method === "GET") {
      const test = store.getTest(match[1]!)
      if (!test) throw new HttpError(404, "That test is gone.")
      return this.#json(res, 200, test)
    }

    throw new HttpError(404, "Not found.")
  }

  #static(path: string, res: ServerResponse) {
    const dist = this.#options.dist ?? DIST
    if (!existsSync(join(dist, "index.html"))) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
      return res.end("The page isn't built yet. Run `npm run build`, or use `npm start`, which builds it first.")
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      throw new HttpError(400, "That address isn't valid.")
    }
    let file = normalize(join(dist, decoded))
    if (!file.startsWith(dist + sep) && file !== dist) file = join(dist, "index.html")
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html")
    const type = TYPES[extname(file)] ?? "application/octet-stream"
    const immutable = file.includes(`${sep}assets${sep}`)
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...(type.startsWith("text/html")
        ? {
            "Content-Security-Policy":
              "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
          }
        : {}),
    })
    res.end(readFileSync(file))
  }
}
