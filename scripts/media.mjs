// Records the README demo and pictures from a real run.
//
// The demo: type a description, let Claude draw it, open a box, run it in Docker, find the breaking
// point, apply the suggested fix, run again and see the number go up. Chrome's frames are captured as
// they're drawn, and while the script is only waiting (for Claude, containers or the step-up test) each
// frame is given a fraction of its real time, so those stretches play fast and the rest at normal
// speed. ffmpeg turns the frames into docs/img/demo.mp4 and docs/img/demo.gif. Pictures of the start
// page, the editor and the live view, light and dark, are taken along the way.
//
// Needs Docker, plus Claude Code signed in or an ANTHROPIC_API_KEY (without one, the demo starts from
// an example). About eight minutes and a few cents of Claude usage.
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import ffmpeg from "ffmpeg-static"
import { chromium } from "playwright-core"

const root = fileURLToPath(new URL("..", import.meta.url))
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(
  (p) => p && existsSync(p),
)
const port = 4689
const base = `http://127.0.0.1:${port}`
const data = mkdtempSync(join(tmpdir(), "redline-media-"))
const work = mkdtempSync(join(tmpdir(), "redline-video-"))
const out = join(root, "docs", "img")
mkdirSync(out, { recursive: true })

const DEMO = "Users hit a load balancer in front of an API. The API reads from Redis and falls back to Postgres."
const SIZE = { width: 1280, height: 800 }
const FPS = 30

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/main.ts"], {
  cwd: root,
  env: { ...process.env, REDLINE_PORT: String(port), REDLINE_DATA: data },
  stdio: ["ignore", "pipe", "inherit"],
})
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("running at") && resolve()))
const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
const stopSession = () => fetch(`${base}/api/session`, { method: "DELETE", headers: { "Content-Type": "application/json" } })

// A drawn pointer, since captured frames show no mouse. It follows the mouse and dips on a click.
const CURSOR = `
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div")
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.3-3.4-6.8L4 20Z" fill="#141414" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none", transition: "transform .08s", willChange: "transform" })
    document.body.append(c)
    let x = -40, y = -40, s = 1
    const draw = () => (c.style.transform = "translate(" + (x - 3) + "px," + (y - 2) + "px) scale(" + s + ")")
    addEventListener("mousemove", (e) => { x = e.clientX; y = e.clientY; draw() }, true)
    addEventListener("mousedown", () => { s = 0.82; draw() }, true)
    addEventListener("mouseup", () => { s = 1; draw() }, true)
    draw()
  })`

const browser = await chromium.launch({ executablePath: chrome })
const shot = async (page, name) => {
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(out, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

// While only waiting, frames play `speed` times faster than they happened.
let speed = 1
async function waiting(fast, fn) {
  speed = fast
  await fn()
  speed = 1
}

const frames = []
const framesDir = join(work, "frames")
mkdirSync(framesDir)

/** Captures what Chrome draws, keeping at most FPS frames per second of the finished video. */
async function capture(page) {
  const cdp = await page.context().newCDPSession(page)
  let last = -Infinity
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {})
    const t = metadata.timestamp
    if (t - last < speed / FPS) return
    last = t
    const file = join(framesDir, `${String(frames.length).padStart(6, "0")}.jpg`)
    frames.push({ file, t, speed })
    writeFileSync(file, Buffer.from(data, "base64"))
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: SIZE.width, maxHeight: SIZE.height, everyNthFrame: 1 })
  return () => cdp.send("Page.stopScreencast").catch(() => {})
}

/** Joins the frames into a video: each lasts its real time, divided by the speed it was taken at. */
function render() {
  const list = []
  let seconds = 0
  frames.forEach((f, i) => {
    const next = frames[i + 1]
    const duration = next ? Math.min(2, (next.t - f.t) / f.speed) : 2
    seconds += duration
    list.push(`file '${f.file.replaceAll("\\", "/")}'`, `duration ${duration.toFixed(4)}`)
  })
  list.push(`file '${frames.at(-1).file.replaceAll("\\", "/")}'`)
  const listFile = join(work, "frames.txt")
  writeFileSync(listFile, list.join("\n"))
  const video = join(out, "demo.mp4")
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", `fps=${FPS},format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", video])
  // The GIF for the README, which GitHub plays inline: one palette for the whole clip, and only the changed part of each frame.
  execFileSync(ffmpeg, [
    "-y", "-loglevel", "error", "-i", video,
    "-filter_complex", "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
    join(out, "demo.gif"),
  ])
  return { seconds, real: frames.at(-1).t - frames[0].t }
}

try {
  const context = await browser.newContext({ viewport: SIZE, colorScheme: "light" })
  await context.addInitScript(CURSOR)
  const page = await context.newPage()
  const boxes = page.locator(".react-flow__node-box")

  // Glide to an element, then click it, the way a person would.
  let mouse = { x: SIZE.width / 2, y: SIZE.height - 120 }
  async function glide(locator) {
    const box = await locator.boundingBox()
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.move(to.x, to.y, { steps: Math.max(14, Math.round(Math.hypot(to.x - mouse.x, to.y - mouse.y) / 16)) })
    mouse = to
  }
  async function click(locator) {
    await glide(locator)
    await page.waitForTimeout(250)
    await page.mouse.down()
    await page.waitForTimeout(70)
    await page.mouse.up()
  }

  await page.goto(base)
  await page.getByRole("heading", { name: /Find where your system/ }).waitFor()
  await page.mouse.move(mouse.x, mouse.y)
  const stop = await capture(page)
  await page.waitForTimeout(2400)

  // 1. Describe a system and let Claude draw it.
  const status = await (await fetch(`${base}/api/status`)).json()
  if (status.ai) {
    await click(page.getByRole("textbox", { name: "Describe your system" }))
    await page.keyboard.type(DEMO, { delay: 28 })
    await page.waitForTimeout(600)
    await page.keyboard.press("Enter")
    await waiting(6, () => boxes.first().waitFor({ timeout: 120_000 }))
  } else {
    await click(page.locator(".card", { hasText: "Cached feed" }))
    await boxes.first().waitFor()
  }
  await page.waitForTimeout(1800)

  // 2. Look at the API box and what it's set to.
  const named = boxes.filter({ hasText: /API/ })
  const api = (await named.count()) ? named.first() : boxes.nth(1)
  await glide(api)
  await page.waitForTimeout(700)
  await click(api)
  await page.waitForTimeout(2600)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(500)

  // 3. Run it in Docker and find the breaking point.
  await click(page.getByRole("button", { name: "Run", exact: true }))
  const find = page.getByRole("button", { name: "Find the breaking point" })
  await waiting(6, () => find.waitFor({ timeout: 300_000 }))
  await page.waitForTimeout(1500)
  await click(find)
  await waiting(10, () => page.locator(".capacity").waitFor({ timeout: 400_000 }))
  await page.locator(".panel").evaluate((el) => el.scrollTo({ top: 0 }))
  await page.waitForTimeout(3200)

  // Pictures of the live view, while the boxes still show the load.
  const first = await (await fetch(`${base}/api/session`)).json()
  await post("/api/session/rate", { rps: first.ramp.result.failedAt ?? 500 })
  const big = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" })
  await big.goto(base)
  await big.getByRole("button", { name: "Find the breaking point" }).waitFor({ timeout: 30_000 })
  await big.waitForTimeout(4500)
  await shot(big, "live")
  await big.close()

  // 4. Apply the suggested fix and run the changed design.
  await click(page.locator(".suggestion").first().getByRole("button", { name: "Apply" }))
  await page.waitForTimeout(1800)
  await click(page.getByRole("button", { name: "Run the new design" }))
  await waiting(6, () => find.waitFor({ timeout: 300_000 }))
  await page.waitForTimeout(1200)
  await click(find)
  // Done when the panel lists both tests (its heading is already there from the first).
  await waiting(10, () => page.waitForFunction(() => document.querySelectorAll(".compare-row").length >= 2 && document.querySelector(".capacity"), null, { timeout: 400_000 }))
  await page.locator(".panel").evaluate((el) => el.scrollTo({ top: 0 }))
  await page.waitForTimeout(2500)
  await page.locator(".panel").evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }))
  await page.waitForTimeout(3500)

  await stop()
  await stopSession()
  await context.close()

  // 5. The video, made first so the pictures below can't cost the recording.
  const { seconds, real } = render()
  console.log(`Captured ${frames.length} frames over ${real.toFixed(0)} s; the video runs ${seconds.toFixed(0)} s`)

  // The start page and the editor, once nothing is running.
  const still = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" })
  await still.goto(base)
  await still.locator(".sample-window .react-flow__node-box").first().waitFor()
  await still.waitForTimeout(1500)
  await shot(still, "start")
  await still.locator(".card", { hasText: "Online store" }).click()
  await still.locator(".react-flow__node-box").first().waitFor()
  await still.locator(".react-flow__node-box").filter({ has: still.locator(".box-label", { hasText: /^Orders$/ }) }).click()
  await still.mouse.move(5, 300)
  await still.waitForTimeout(600)
  await shot(still, "editor")
  await still.close()
} finally {
  await stopSession().catch(() => {})
  await browser.close()
  const exited = new Promise((r) => server.on("exit", r))
  server.kill()
  await exited
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(`Saved the demo and pictures to ${out}`)
