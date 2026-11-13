import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { IMAGES } from "../shared/compile.ts"
import { stream, type Docker } from "./docker.ts"

export const RUNTIME_DIR = join(import.meta.dirname, "..", "runtime")

/** The runtime image is named after a hash of its source, so editing the Go code rebuilds it. */
export function runtimeTag(dir = RUNTIME_DIR) {
  const hash = createHash("sha256")
  const files = readdirSync(dir)
    .filter((name) => (name.endsWith(".go") && !name.endsWith("_test.go")) || ["go.mod", "go.sum", "Dockerfile"].includes(name))
    .sort()
  for (const name of files) {
    hash.update(name)
    hash.update(readFileSync(join(dir, name)))
  }
  return `redline-runtime:${hash.digest("hex").slice(0, 12)}`
}

export type Progress = (line: string) => void

export async function ensureImages(docker: Docker, progress: Progress, signal?: AbortSignal) {
  const tag = runtimeTag()
  if (!(await docker.hasImage(tag))) {
    progress("Building Redline's runtime image (first run only, about a minute)")
    const code = await stream("docker", ["build", "-t", tag, RUNTIME_DIR], (line) => progress(line), { signal })
    if (code !== 0) throw new Error("Building the runtime image failed. Run `docker build runtime` to see why.")
  }
  for (const image of Object.values(IMAGES)) {
    if (await docker.hasImage(image)) continue
    progress(`Downloading ${image}`)
    const code = await stream("docker", ["pull", image], (line) => progress(line), { signal })
    if (code !== 0) throw new Error(`Downloading ${image} failed. Check your internet connection.`)
  }
  return tag
}
