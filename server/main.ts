import { existsSync } from "node:fs"
import { join } from "node:path"
import { App } from "./app.ts"
import { Docker } from "./docker.ts"
import { pickReader } from "./recognize.ts"
import { sweep } from "./session.ts"
import { Store } from "./store.ts"

const root = join(import.meta.dirname, "..")
const envFile = join(root, ".env.local")
if (existsSync(envFile)) process.loadEnvFile(envFile)

const port = Number(process.env.REDLINE_PORT ?? 4600)
const store = new Store(process.env.REDLINE_DATA ?? join(root, ".redline"))
const docker = new Docker()
const reader = pickReader()
const app = new App({ store, docker, reader, port })

try {
  await app.listen()
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  console.error(code === "EADDRINUSE" ? `Port ${port} is taken. Is Redline already running? Set REDLINE_PORT to use another.` : error)
  process.exit(1)
}

console.log(`\n  Redline is running at http://127.0.0.1:${app.port}\n`)
console.log(reader ? `  Reading drawings with ${reader.model} (via ${reader.name === "cli" ? "Claude Code" : "the API"})` : "  Reading drawings is off: sign in to Claude Code or set ANTHROPIC_API_KEY")
const info = await docker.info()
console.log(info.ok ? `  Docker ${info.version}: ${info.cpus} CPUs, ${info.memoryGb} GB` : `  ${info.error}`)
if (info.ok) {
  const removed = await sweep(docker)
  if (removed) console.log(`  Removed ${removed} run${removed === 1 ? "" : "s"} left over from last time`)
}
console.log("")

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  console.log("\n  Stopping containers...")
  await app.close().catch(() => {})
  store.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
// A crash would leave containers running, so an unexpected error is logged and Redline carries on.
process.on("uncaughtException", (error) => console.error("  Unexpected error:", error))
process.on("unhandledRejection", (error) => console.error("  Unexpected error:", error))
process.on("SIGTERM", shutdown)
