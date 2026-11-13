// Runs the breaking-point test on real containers for a few designs, one after another, and
// writes what it found to bench/results.md. Needs Docker. About a minute per design.
//
//   node bench/capacity.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import { join } from "node:path"
import { compact } from "../shared/analyze.ts"
import type { Design } from "../shared/design.ts"
import type { RampResult } from "../shared/results.ts"
import { applyChange } from "../shared/suggest.ts"
import { template } from "../shared/templates.ts"
import { containerCount } from "../shared/validate.ts"
import { Docker } from "../server/docker.ts"
import { DockerRuntime } from "../server/docker-runtime.ts"
import { Session } from "../server/session.ts"
import { Store } from "../server/store.ts"

const docker = new Docker()
const info = await docker.info()
if (!info.ok) throw new Error(info.error)
const dir = mkdtempSync(join(tmpdir(), "redline-bench-"))
const store = new Store(dir)

const shortener = template("url-shortener")
const threeCopies = applyChange(shortener, { kind: "set", nodeId: "api", key: "replicas", value: 3 })
const withCache = applyChange(threeCopies, { kind: "add-cache", databaseId: "postgres", serviceIds: ["api"] })

const designs: [string, Design][] = [
  ["URL shortener: 1 API copy, Postgres", shortener],
  ["… with 3 API copies", threeCopies],
  ["… with 3 API copies and a Redis cache", withCache],
  ["Cached feed: load balancer, 2 API copies, Redis, Postgres", template("cached-feed")],
  ["Checkout: payments API, Postgres, queue and worker", template("checkout")],
]

type Row = { name: string; containers: number; readyMs: number; result: RampResult }
const rows: Row[] = []

for (const [name, design] of designs) {
  process.stdout.write(`${name}: starting… `)
  const session = new Session({ store, runtime: (id) => new DockerRuntime(docker, design, id, dir) }, design, null)
  await session.start()
  if (session.phase !== "ready") {
    console.log(`failed: ${session.error}`)
    continue
  }
  process.stdout.write(`ready in ${(session.readyMs! / 1000).toFixed(1)} s, testing… `)
  const done = new Promise<RampResult>((resolve) => {
    session.on("state", (view) => view.ramp && !view.ramp.running && view.ramp.result && resolve(view.ramp.result))
  })
  session.startRamp()
  const result = await done
  await session.stop()
  rows.push({ name, containers: containerCount(design), readyMs: session.readyMs!, result })
  console.log(`holds ${result.capacity ?? 0} req/s, ${result.finding?.title ?? "no bottleneck named"}`)
}

store.close()
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

const lines = [
  `# Breaking points measured on real containers`,
  ``,
  `Docker ${info.version} with ${info.cpus} CPUs and ${info.memoryGb} GB (host: ${cpus()[0]?.model.trim() ?? "unknown"}), ${new Date().toISOString().slice(0, 10)}.`,
  `Each step holds a rate for 4 seconds after 2 to settle; a step passes when p95 is under the design's target (250 ms, or 500 ms for Checkout) and under 1% of requests fail.`,
  `Boxes use Redline's default sizes (0.5 CPU per service copy, 1 CPU for Postgres), so the numbers compare designs with each other, not with production hardware.`,
  ``,
  `| Design | Containers | Ready in | Holds | Breaks at | What broke |`,
  `| --- | --- | --- | --- | --- | --- |`,
  ...rows.map(
    (row) =>
      `| ${row.name} | ${row.containers} | ${(row.readyMs / 1000).toFixed(1)} s | ${row.result.capacity ? `${compact(row.result.capacity)} req/s` : "–"} | ${row.result.failedAt ? `${compact(row.result.failedAt)} req/s` : "didn't break"} | ${row.result.finding?.title.replace(/“|”/g, "") ?? "–"} |`,
  ),
]
writeFileSync(join(import.meta.dirname, "results.md"), lines.join("\n") + "\n")
console.log(`\nWrote bench/results.md`)
