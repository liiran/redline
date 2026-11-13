import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

// Go isn't needed on this machine: the runtime's tests run in the same image that builds it.
const runtime = resolve(fileURLToPath(new URL("../runtime", import.meta.url)))
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${runtime}:/src`,
    "-v",
    "redline-gocache:/root/.cache/go-build",
    "-v",
    "redline-gomod:/go/pkg/mod",
    "-w",
    "/src",
    "golang:1.26-alpine",
    "sh",
    "-c",
    "go vet ./... && go test -count=1 ./...",
  ],
  { stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
)
process.exit(result.status ?? 1)
