import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { designSchema, type Design } from "../shared/design.ts"
import type { Sample } from "../shared/samples.ts"
import type { RampResult } from "./ramp.ts"

export type DesignRow = { id: string; name: string; design: Design; createdAt: number; updatedAt: number }
export type TestRow = {
  id: string
  designId: string | null
  name: string
  design: Design
  startedAt: number
  finishedAt: number
  result: RampResult
}

export function newId() {
  return randomUUID().replace(/-/g, "").slice(0, 16)
}

export class Store {
  readonly dir: string
  readonly db: DatabaseSync

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(join(dir, "photos"), { recursive: true })
    mkdirSync(join(dir, "runs"), { recursive: true })
    this.db = new DatabaseSync(join(dir, "redline.db"))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS designs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tests (
        id TEXT PRIMARY KEY, design_id TEXT, name TEXT NOT NULL, design_json TEXT NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, result_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tests_by_design ON tests (design_id, started_at);
      CREATE TABLE IF NOT EXISTS samples (
        test_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (test_id, seq));
    `)
  }

  close() {
    this.db.close()
  }

  listDesigns() {
    const rows = this.db.prepare("SELECT id, name, json, updated_at FROM designs ORDER BY updated_at DESC LIMIT 200").all() as {
      id: string
      name: string
      json: string
      updated_at: number
    }[]
    return rows.map((row) => {
      const design = JSON.parse(row.json) as Design
      return { id: row.id, name: row.name, updatedAt: row.updated_at, boxes: design.nodes.length, photo: design.photo?.id ?? null }
    })
  }

  getDesign(id: string): DesignRow | null {
    const row = this.db.prepare("SELECT * FROM designs WHERE id = ?").get(id) as
      | { id: string; name: string; json: string; created_at: number; updated_at: number }
      | undefined
    if (!row) return null
    return { id: row.id, name: row.name, design: designSchema.parse(JSON.parse(row.json)), createdAt: row.created_at, updatedAt: row.updated_at }
  }

  saveDesign(design: Design, id = newId()) {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO designs (id, name, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(id, design.name, JSON.stringify(design), now, now)
    return id
  }

  deleteDesign(id: string) {
    const design = this.getDesign(id)
    this.db.prepare("DELETE FROM designs WHERE id = ?").run(id)
    const photo = design?.design.photo?.id
    if (photo && !this.photoInUse(photo)) rmSync(this.photoPath(photo), { force: true })
  }

  photoInUse(photoId: string) {
    return !!this.db.prepare("SELECT 1 FROM designs WHERE json_extract(json, '$.photo.id') = ? LIMIT 1").get(photoId)
  }

  /**
   * Deletes photos no saved design uses, once they're a day old: a drawing that was read and then
   * thrown away isn't kept. Returns how many went.
   */
  sweepPhotos(olderThanMs = 24 * 60 * 60 * 1000) {
    const dir = join(this.dir, "photos")
    let removed = 0
    for (const name of readdirSync(dir)) {
      const id = name.match(/^([a-f0-9]{16})\.img$/)?.[1]
      if (!id || Date.now() - statSync(join(dir, name)).mtimeMs < olderThanMs || this.photoInUse(id)) continue
      rmSync(this.photoPath(id), { force: true })
      rmSync(`${this.photoPath(id)}.type`, { force: true })
      removed++
    }
    return removed
  }

  photoPath(id: string) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Bad photo id")
    return join(this.dir, "photos", `${id}.img`)
  }

  savePhoto(bytes: Buffer, type: string) {
    const id = newId()
    writeFileSync(this.photoPath(id), bytes)
    writeFileSync(`${this.photoPath(id)}.type`, type)
    return id
  }

  readPhoto(id: string) {
    const path = this.photoPath(id)
    if (!existsSync(path)) return null
    return { bytes: readFileSync(path), type: existsSync(`${path}.type`) ? readFileSync(`${path}.type`, "utf8") : "image/jpeg" }
  }

  saveTest(test: TestRow) {
    this.db
      .prepare("INSERT OR REPLACE INTO tests (id, design_id, name, design_json, started_at, finished_at, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(test.id, test.designId, test.name, JSON.stringify(test.design), test.startedAt, test.finishedAt, JSON.stringify(test.result))
  }

  saveSamples(testId: string, samples: Sample[]) {
    const insert = this.db.prepare("INSERT OR REPLACE INTO samples (test_id, seq, json) VALUES (?, ?, ?)")
    this.db.exec("BEGIN")
    try {
      for (const sample of samples) insert.run(testId, sample.seq, JSON.stringify(sample))
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  listTests(designId?: string) {
    const rows = (
      designId
        ? this.db.prepare("SELECT * FROM tests WHERE design_id = ? ORDER BY started_at DESC LIMIT 100").all(designId)
        : this.db.prepare("SELECT * FROM tests ORDER BY started_at DESC LIMIT 100").all()
    ) as { id: string; design_id: string | null; name: string; design_json: string; started_at: number; finished_at: number; result_json: string }[]
    return rows.map((row) => this.#test(row))
  }

  getTest(id: string) {
    const row = this.db.prepare("SELECT * FROM tests WHERE id = ?").get(id) as
      | { id: string; design_id: string | null; name: string; design_json: string; started_at: number; finished_at: number; result_json: string }
      | undefined
    if (!row) return null
    const samples = (this.db.prepare("SELECT json FROM samples WHERE test_id = ? ORDER BY seq").all(id) as { json: string }[]).map(
      (s) => JSON.parse(s.json) as Sample,
    )
    return { ...this.#test(row), samples }
  }

  #test(row: { id: string; design_id: string | null; name: string; design_json: string; started_at: number; finished_at: number; result_json: string }): TestRow {
    return {
      id: row.id,
      designId: row.design_id,
      name: row.name,
      design: JSON.parse(row.design_json),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      result: JSON.parse(row.result_json),
    }
  }
}
