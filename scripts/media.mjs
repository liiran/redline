// Takes the README pictures from a real run: starts Redline, opens the URL shortener, finds its
// breaking point in Docker, and saves the page in light and dark to docs/img. About two minutes.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

const root = fileURLToPath(new URL("..", import.meta.url))
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(
  (p) => p && existsSync(p),
)
const port = 4689
const data = mkdtempSync(join(tmpdir(), "redline-media-"))
const out = join(root, "docs", "img")
mkdirSync(out, { recursive: true })

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/main.ts"], {
  cwd: root,
  env: { ...process.env, REDLINE_PORT: String(port), REDLINE_DATA: data },
  stdio: ["ignore", "pipe", "inherit"],
})
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("running at") && resolve()))

const browser = await chromium.launch({ executablePath: chrome })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const shot = async (name) => {
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, `${name}-${scheme}.png`) })
  }
}

try {
  await page.goto(`http://127.0.0.1:${port}`)
  await page.getByRole("heading", { name: /Draw a system/ }).waitFor()
  await shot("start")
  await page.locator(".card", { hasText: "URL shortener" }).click()
  await page.getByRole("button", { name: "Run", exact: true }).click()
  await page.getByRole("button", { name: "Find the breaking point" }).waitFor({ timeout: 240_000 })
  await page.waitForTimeout(2000)
  await page.getByRole("button", { name: "Find the breaking point" }).click()
  await page.locator(".capacity").waitFor({ timeout: 300_000 })
  // Hold the traffic just past the breaking point so the picture shows the box that broke.
  const result = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()
  await fetch(`http://127.0.0.1:${port}/api/session/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rps: result.ramp.result.failedAt ?? 500 }),
  })
  await page.waitForTimeout(6000)
  await page.locator(".panel").evaluate((el) => el.scrollTo(0, 0))
  await shot("live")
} finally {
  await fetch(`http://127.0.0.1:${port}/api/session`, { method: "DELETE", headers: { "Content-Type": "application/json" } }).catch(() => {})
  await browser.close()
  const exited = new Promise((r) => server.on("exit", r))
  server.kill()
  await exited
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(`Saved pictures to ${out}`)
