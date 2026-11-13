import { execFile, spawn } from "node:child_process"
import http from "node:http"
import { createInterface } from "node:readline"

export type Endpoint = { socketPath: string } | { host: string; port: number }

export function parseDockerHost(host: string): Endpoint {
  if (host.startsWith("npipe://")) {
    const pipe = host.slice("npipe://".length).replace(/^\/+/, "").replace(/\//g, "\\")
    return { socketPath: `\\\\${pipe.replace(/^\\+/, "")}` }
  }
  if (host.startsWith("unix://")) return { socketPath: host.slice("unix://".length) }
  if (host.startsWith("tcp://")) {
    const url = new URL(host.replace("tcp://", "http://"))
    return { host: url.hostname, port: Number(url.port || 2375) }
  }
  throw new Error(`Redline can't use the Docker address ${host}`)
}

export function run(command: string, args: string[], options: { timeoutMs?: number; cwd?: string } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      command,
      args,
      { timeout: options.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: options.cwd },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && !stdout ? error.message : "") })
      },
    )
  })
}

export function stream(command: string, args: string[], onLine: (line: string) => void, options: { cwd?: string; signal?: AbortSignal } = {}) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, signal: options.signal })
    child.on("error", reject)
    const lines = (input: NodeJS.ReadableStream) => createInterface({ input }).on("line", (line) => line.trim() && onLine(line))
    lines(child.stdout)
    lines(child.stderr)
    child.on("close", (code) => resolve(code ?? 1))
  })
}

export class Docker {
  #endpoint: Endpoint | null = null

  async endpoint(): Promise<Endpoint> {
    if (this.#endpoint) return this.#endpoint
    let host = process.env.DOCKER_HOST
    if (!host) {
      const result = await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
      if (result.code !== 0) throw new Error("Docker isn't installed, or the docker command isn't on PATH.")
      host = result.stdout.trim()
    }
    this.#endpoint = parseDockerHost(host)
    return this.#endpoint
  }

  async request<T>(method: string, path: string, timeoutMs = 10_000): Promise<{ status: number; body: T }> {
    const endpoint = await this.endpoint()
    return new Promise((resolve, reject) => {
      const req = http.request({ ...endpoint, method, path, timeout: timeoutMs, headers: { Host: "docker" } }, (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => {
          let body: unknown = data
          try {
            body = data ? JSON.parse(data) : null
          } catch {}
          resolve({ status: res.statusCode ?? 0, body: body as T })
        })
      })
      req.on("timeout", () => req.destroy(new Error("Docker didn't answer in time.")))
      req.on("error", reject)
      req.end()
    })
  }

  async info() {
    try {
      const { status, body } = await this.request<{ NCPU: number; MemTotal: number; ServerVersion: string; OperatingSystem: string }>("GET", "/info", 5_000)
      if (status !== 200) return { ok: false as const, error: "Docker answered, but not as expected." }
      return { ok: true as const, cpus: body.NCPU, memoryGb: Math.round((body.MemTotal / 2 ** 30) * 10) / 10, version: body.ServerVersion, os: body.OperatingSystem }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false as const,
        error: /ENOENT|ECONNREFUSED|pipe|socket/i.test(message) ? "Docker isn't running. Start Docker Desktop, then try again." : message,
      }
    }
  }

  async hasImage(name: string) {
    const { status } = await this.request("GET", `/images/${encodeURIComponent(name)}/json`)
    return status === 200
  }

  async containers(label: string) {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }))
    const { body } = await this.request<{ Id: string; Labels: Record<string, string>; State: string }[]>("GET", `/containers/json?all=true&filters=${filters}`)
    return Array.isArray(body) ? body : []
  }

  /** Streams CPU and memory for one container, about once a second, until stop() is called. */
  async stats(id: string, onStat: (cores: number, memoryMb: number) => void) {
    const endpoint = await this.endpoint()
    const req = http.request({ ...endpoint, method: "GET", path: `/containers/${id}/stats?stream=true`, headers: { Host: "docker" } }, (res) => {
      res.on("error", () => {})
      const lines = createInterface({ input: res })
      lines.on("error", () => {})
      lines.on("line", (line) => {
        try {
          const s = JSON.parse(line)
          const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage
          const systemDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage
          const online = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1
          const cores = systemDelta > 0 && cpuDelta >= 0 ? (cpuDelta / systemDelta) * online : 0
          const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0
          const memoryMb = Math.max(0, (s.memory_stats?.usage ?? 0) - cache) / 2 ** 20
          if (s.precpu_stats.system_cpu_usage) onStat(cores, memoryMb)
        } catch {}
      })
    })
    req.on("error", () => {})
    req.end()
    return () => req.destroy()
  }
}

export function compose(project: string, file: string, args: string[]) {
  return ["compose", "-p", project, "-f", file, ...args]
}
