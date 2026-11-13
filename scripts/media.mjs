// Records the README demo and pictures from a real run. It types a description, lets Claude draw it,
// runs it in Docker, finds the breaking point and applies the suggested fix, saving that as
// docs/img/demo.gif. Then it takes the start page, the editor and the live view in light and dark.
// Needs Docker, plus Claude Code signed in or an ANTHROPIC_API_KEY (without one, the demo starts
// from an example). About four minutes and a few cents of Claude usage.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import gifenc from "gifenc"
import { chromium } from "playwright-core"
import { PNG } from "pngjs"

const { GIFEncoder, applyPalette, quantize } = gifenc
const root = fileURLToPath(new URL("..", import.meta.url))
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(
  (p) => p && existsSync(p),
)
const port = 4689
const base = `http://127.0.0.1:${port}`
const data = mkdtempSync(join(tmpdir(), "redline-media-"))
const out = join(root, "docs", "img")
mkdirSync(out, { recursive: true })

const DEMO = "Users hit a load balancer in front of an API. The API reads from Redis and falls back to Postgres."

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/main.ts"], {
  cwd: root,
  env: { ...process.env, REDLINE_PORT: String(port), REDLINE_DATA: data },
  stdio: ["ignore", "pipe", "inherit"],
})
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("running at") && resolve()))
const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

/** Keeps screenshots and how long each one shows, then writes them as one looping GIF. */
class Recorder {
  frames = []
  constructor(page) {
    this.page = page
  }
  async snap(showMs) {
    this.frames.push({ png: await this.page.screenshot(), delay: showMs })
  }
  /** Time-lapse: a frame every `everyMs` of real time, each shown for `showMs`, until `done()` is true. */
  async watch(done, { everyMs = 1000, showMs = 250, timeoutMs = 600_000 } = {}) {
    const end = Date.now() + timeoutMs
    while (!(await done())) {
      if (Date.now() > end) throw new Error("timed out while recording")
      await this.snap(showMs)
      await this.page.waitForTimeout(everyMs)
    }
  }
  /**
   * One palette for the whole GIF, taken from frames across the recording. Pixels that didn't change
   * since the frame before are left transparent, so a frame only stores what moved.
   */
  save(file) {
    const first = PNG.sync.read(this.frames[0].png)
    const { width, height } = first
    const picks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => this.frames[Math.round(f * (this.frames.length - 1))])
    const sample = []
    for (const frame of picks) {
      const rgba = PNG.sync.read(frame.png).data
      for (let i = 0; i < rgba.length; i += 4 * 7) sample.push(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])
    }
    const palette = quantize(new Uint8Array(sample), 255)
    palette.push([255, 0, 255])
    const clear = palette.length - 1
    const gif = GIFEncoder()
    let previous = null
    for (const [i, frame] of this.frames.entries()) {
      const index = applyPalette(PNG.sync.read(frame.png).data, palette)
      const pixels = new Uint8Array(index)
      if (previous) for (let p = 0; p < pixels.length; p++) if (index[p] === previous[p]) pixels[p] = clear
      gif.writeFrame(pixels, width, height, {
        palette: i === 0 ? palette : undefined,
        delay: frame.delay,
        transparent: i > 0,
        transparentIndex: clear,
        dispose: 1,
        repeat: 0,
      })
      previous = index
    }
    gif.finish()
    writeFileSync(file, gif.bytes())
    return { frames: this.frames.length, seconds: this.frames.reduce((s, f) => s + f.delay, 0) / 1000 }
  }
}

const browser = await chromium.launch({ executablePath: chrome })
const shot = async (page, name) => {
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: "light" })
}

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 750 }, colorScheme: "light" })
  const rec = new Recorder(page)
  const boxes = page.locator(".react-flow__node-box")
  await page.goto(base)
  await page.getByRole("heading", { name: /Find where your system/ }).waitFor()
  await rec.snap(1600)

  const status = await (await fetch(`${base}/api/status`)).json()
  if (status.ai) {
    await page.getByRole("textbox", { name: "Describe your system" }).click()
    for (let i = 0; i < DEMO.length; i += 4) {
      await page.keyboard.type(DEMO.slice(i, i + 4))
      await rec.snap(60)
    }
    await rec.snap(700)
    await page.keyboard.press("Enter")
    await rec.watch(async () => (await boxes.count()) >= 3, { everyMs: 600, showMs: 220 })
  } else {
    await page.locator(".card", { hasText: "Cached feed" }).click()
  }
  await boxes.first().waitFor()
  await page.waitForTimeout(900)
  await rec.snap(2200)

  // Pick the busiest-looking box to show what the panel offers.
  const named = boxes.filter({ hasText: /API/ })
  const api = (await named.count()) ? named.first() : boxes.nth(1)
  await api.hover()
  await page.waitForTimeout(250)
  await rec.snap(900)
  await api.click()
  await page.waitForTimeout(250)
  await rec.snap(2200)
  await page.keyboard.press("Escape")
  await page.mouse.move(5, 300)
  await page.waitForTimeout(250)
  await rec.snap(500)

  await page.getByRole("button", { name: "Run", exact: true }).click()
  const findButton = page.getByRole("button", { name: "Find the breaking point" })
  await rec.watch(() => findButton.isVisible(), { everyMs: 1000, showMs: 300, timeoutMs: 300_000 })
  await page.waitForTimeout(2500)
  await rec.snap(1400)
  await findButton.click()
  await rec.watch(() => page.locator(".capacity").isVisible(), { everyMs: 1500, showMs: 200, timeoutMs: 400_000 })

  // Hold the traffic just past the breaking point so the box that broke stays red.
  const session = await (await fetch(`${base}/api/session`)).json()
  await post("/api/session/rate", { rps: session.ramp.result.failedAt ?? 500 })
  await page.waitForTimeout(5000)
  await page.locator(".panel").evaluate((el) => el.scrollTo(0, 0))
  for (let i = 0; i < 4; i++) {
    await rec.snap(700)
    await page.waitForTimeout(700)
  }

  // The still of the live view, at full size, while the traffic still runs.
  const big = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" })
  await big.goto(base)
  await big.getByRole("button", { name: "Find the breaking point" }).waitFor({ timeout: 30_000 })
  await big.waitForTimeout(4000)
  await shot(big, "live")

  await page.locator(".suggestion").first().getByRole("button", { name: "Apply" }).click()
  await page.waitForTimeout(500)
  await rec.snap(3000)

  await fetch(`${base}/api/session`, { method: "DELETE", headers: { "Content-Type": "application/json" } })
  const gif = rec.save(join(out, "demo.gif"))
  console.log(`Saved demo.gif: ${gif.frames} frames, ${gif.seconds.toFixed(1)} s`)

  // The start page and the editor, once nothing is running.
  await big.goto(base)
  await big.getByRole("heading", { name: /Find where your system/ }).waitFor()
  await big.locator(".sample-window").waitFor()
  await big.waitForTimeout(1500)
  await shot(big, "start")
  await big.locator(".card", { hasText: "Online store" }).click()
  await big.locator(".react-flow__node-box").first().waitFor()
  await big.locator(".react-flow__node-box", { hasText: "Orders" }).click()
  await big.mouse.move(5, 300)
  await big.waitForTimeout(500)
  await shot(big, "editor")
} finally {
  await fetch(`${base}/api/session`, { method: "DELETE", headers: { "Content-Type": "application/json" } }).catch(() => {})
  await browser.close()
  const exited = new Promise((r) => server.on("exit", r))
  server.kill()
  await exited
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(`Saved pictures to ${out}`)
