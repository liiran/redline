// Browser checks for the page. Starts Redline in test mode (no Docker, no Claude, made-up numbers),
// drives it in Chrome and prints one line per check. Run with `npm run e2e` after `npm run build`.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

const root = fileURLToPath(new URL("..", import.meta.url))
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((path) => path && existsSync(path))

if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("Build the page first: npm run build")
  process.exit(1)
}
if (!CHROME) {
  console.error("Chrome wasn't found. Set CHROME_PATH.")
  process.exit(1)
}

const port = await new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})
const data = mkdtempSync(join(tmpdir(), "redline-e2e-"))
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/main.ts"], {
  cwd: root,
  env: { ...process.env, REDLINE_FAKE: "1", REDLINE_PORT: String(port), REDLINE_DATA: data },
  stdio: ["ignore", "pipe", "pipe"],
})
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("running at") && resolve())
  server.on("exit", (code) => reject(new Error(`server exited ${code}`)))
  setTimeout(() => reject(new Error("server didn't start")), 15_000)
})

const base = `http://127.0.0.1:${port}`
const browser = await chromium.launch({ executablePath: CHROME })
const results = []
const errors = []

async function check(name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok    ${name} (${Date.now() - started} ms)`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`  FAIL  ${name}\n        ${String(error.message ?? error).split("\n")[0]}`)
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

async function newPage(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...options })
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  await page.goto(base)
  return page
}

const boxes = (page) => page.locator(".react-flow__node-box")
const rate = (text) => {
  const n = Number(text.replace(/[^\d.k]/g, "").replace("k", ""))
  return /k/.test(text) ? n * 1000 : n
}

let page = await newPage()

await check("start page shows the pitch, three ways in and four examples", async () => {
  await page.getByRole("heading", { name: /Draw a system/ }).waitFor()
  for (const name of ["Choose a photo", "Sketch it here", "Describe it"]) await page.getByRole("button", { name }).waitFor()
  expect((await page.locator(".examples .card").count()) === 4, "expected 4 examples")
})

await check("an example opens on the canvas with its boxes and arrows", async () => {
  await page.locator(".card", { hasText: "Cached feed" }).click()
  await boxes(page).first().waitFor()
  expect((await boxes(page).count()) === 5, `expected 5 boxes, saw ${await boxes(page).count()}`)
  expect((await page.locator(".react-flow__edge").count()) === 4, "expected 4 arrows")
  await page.getByText("6", { exact: true }).first().waitFor()
})

await check("selecting a box shows its settings, and renaming it updates the canvas", async () => {
  await boxes(page).filter({ hasText: "Postgres" }).click()
  const name = page.getByRole("textbox", { name: "", exact: false }).first()
  await page.locator(".panel input.text-input").first().fill("Orders DB")
  await page.locator(".panel input.text-input").first().press("Enter")
  await boxes(page).filter({ hasText: "Orders DB" }).waitFor()
  void name
})

await check("copies change the badge, and undo puts it back", async () => {
  await boxes(page).filter({ hasText: "API" }).click()
  await page.getByRole("button", { name: "More copies" }).click()
  await boxes(page).filter({ hasText: "API" }).locator(".box-badge", { hasText: "×3" }).waitFor()
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } })
  await page.keyboard.press("Control+z")
  await boxes(page).filter({ hasText: "API" }).locator(".box-badge", { hasText: "×2" }).waitFor()
})

await check("adding a box from the menu and deleting it", async () => {
  const before = await boxes(page).count()
  await page.getByRole("button", { name: "Add box" }).click()
  await page.getByRole("menuitem", { name: "Worker" }).click()
  await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node-box").length === n + 1, before)
  await page.getByText("needs a queue to take jobs from").waitFor()
  await page.getByRole("button", { name: "Delete box" }).click()
  await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node-box").length === n, before)
})

await check("a run goes live, the breaking point is found and explained", async () => {
  await page.getByRole("button", { name: "Run", exact: true }).click()
  await page.getByRole("button", { name: "Find the breaking point" }).waitFor({ timeout: 20_000 })
  await page.getByText("containers running").waitFor()
  await page.getByRole("button", { name: "Find the breaking point" }).click()
  await page.locator(".capacity").waitFor({ timeout: 60_000 })
  await page.locator(".finding").first().waitFor()
  const capacity = await page.locator(".capacity").innerText()
  expect(/\d/.test(capacity), `capacity reads ${capacity}`)
  expect((await page.locator(".step").count()) >= 3, "expected the steps to be listed")
})

await check("applying a suggestion and running the new design compares the two tests", async () => {
  const first = rate(await page.locator(".capacity").innerText())
  await page.locator(".suggestion").first().getByRole("button", { name: "Apply" }).click()
  await page.getByText("You changed the design since this run started").waitFor()
  await page.getByRole("button", { name: "Run the new design" }).click()
  await page.getByRole("button", { name: "Find the breaking point" }).waitFor({ timeout: 20_000 })
  await page.getByRole("button", { name: "Find the breaking point" }).click()
  await page.locator(".capacity").waitFor({ timeout: 60_000 })
  await page.getByText("Tests of this design").waitFor()
  await page.waitForFunction(() => document.querySelectorAll(".compare-row").length >= 2)
  const second = rate(await page.locator(".capacity").innerText())
  expect(second > first, `the fix should raise capacity (${first} → ${second})`)
})

await check("opening another design while one runs says which one is running", async () => {
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Search commands" }).fill("URL shortener")
  await page.keyboard.press("Enter")
  await page.getByText("“Cached feed” is running").waitFor()
  expect((await page.locator(".box[data-status='hot'], .box[data-status='busy']").count()) === 0, "another design's numbers leaked onto this one")
  await page.getByRole("button", { name: "Open it" }).click()
  await page.getByRole("button", { name: "Find the breaking point" }).waitFor()
})

await check("stopping returns to the design view", async () => {
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await page.getByRole("button", { name: "Run in Docker" }).waitFor({ timeout: 20_000 })
})

await check("a photo is read into boxes laid over the picture", async () => {
  await page.goto(base)
  await page.getByRole("heading", { name: /Draw a system/ }).waitFor()
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 600, height: 400 } })
  await page.locator('input[type="file"]').first().setInputFiles({ name: "sketch.png", mimeType: "image/png", buffer: png })
  await page.getByText(/Found 4 boxes and 3 arrows/).first().waitFor({ timeout: 15_000 })
  expect((await boxes(page).count()) === 4, "expected 4 boxes")
  expect((await page.locator(".react-flow__node-photo img").count()) === 1, "the photo should sit under the boxes")
  await page.getByRole("button", { name: "Hide the photo" }).click()
  expect((await page.locator(".react-flow__node-photo").count()) === 0, "the photo should hide")
})

await check("describing a system in words draws it", async () => {
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Search commands" }).fill("describe")
  await page.keyboard.press("Enter")
  await page.getByRole("dialog", { name: "Describe your system" }).waitFor()
  await page.getByRole("button", { name: "Use the example" }).click()
  await page.getByRole("button", { name: "Draw it" }).click()
  await page.waitForFunction(() => document.querySelector(".name-input")?.value.startsWith("Users hit a load balancer"))
  expect((await boxes(page).count()) === 4, "expected 4 boxes")
  expect((await page.locator(".react-flow__node-photo").count()) === 0, "a described system has no photo")
})

await check("the sketch pad turns strokes into a design", async () => {
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Search commands" }).fill("sketch")
  await page.keyboard.press("Enter")
  const pad = page.getByRole("dialog", { name: "Sketch your system" }).locator("canvas")
  await pad.waitFor()
  const box = await pad.boundingBox()
  for (const [x, y] of [[0.1, 0.4], [0.4, 0.4], [0.7, 0.3]]) {
    await page.mouse.move(box.x + box.width * x, box.y + box.height * y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * (x + 0.12), box.y + box.height * y, { steps: 6 })
    await page.mouse.move(box.x + box.width * (x + 0.12), box.y + box.height * (y + 0.12), { steps: 6 })
    await page.mouse.up()
  }
  const toasts = await page.getByText(/Found 4 boxes/).count()
  await page.getByRole("button", { name: "Read my sketch" }).click()
  await page.waitForFunction((n) => [...document.querySelectorAll("[data-slot=toast]")].filter((t) => t.textContent.includes("Found 4 boxes")).length > n, toasts, { timeout: 15_000 })
})

await check("the command palette switches the theme", async () => {
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Search commands" }).fill("theme dark")
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark")
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark")
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Search commands" }).fill("match the system")
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => !document.documentElement.dataset.theme)
})

await check("saved designs come back on the start page", async () => {
  await page.goto(base)
  await page.locator(".recent-row").first().waitFor()
  expect((await page.locator(".recent-row").count()) >= 3, "expected the designs made above")
  await page.locator(".recent-row", { hasText: "Cached feed" }).click()
  await boxes(page).filter({ hasText: "Orders DB" }).waitFor()
})

await check("fits a phone screen without sideways scrolling", async () => {
  const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await phone.getByRole("heading", { name: /Draw a system/ }).waitFor()
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= 390), "start page scrolls sideways")
  await phone.locator(".card", { hasText: "Checkout" }).click()
  await phone.locator(".react-flow__node-box").first().waitFor()
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= 390), "workspace scrolls sideways")
  await phone.close()
})

await check("no errors in the browser console", async () => {
  expect(errors.length === 0, errors.join(" | "))
})

await browser.close()
const exited = new Promise((resolve) => server.on("exit", resolve))
server.kill()
await exited
rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} browser checks passed${failed.length ? `; failed: ${failed.map((f) => f.name).join("; ")}` : ""}`)
process.exit(failed.length ? 1 : 0)
