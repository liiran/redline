// Development: the server on 4600 and Vite on 4610 with hot reload. Open http://127.0.0.1:4610.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const children = [
  spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--watch-path=server", "--watch-path=shared", "server/main.ts"], {
    cwd: root,
    stdio: "inherit",
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { cwd: root, stdio: "inherit" }),
]

function stop() {
  for (const child of children) child.kill("SIGTERM")
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
for (const child of children) child.on("exit", (code) => code && stop())
