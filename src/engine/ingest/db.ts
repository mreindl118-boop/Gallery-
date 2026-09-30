import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { derivativePath, type ImportIssue, type PhotoFormat, type PhotoSummary } from '@shared/ingest'

/**
 * The project's ingest index: <root>/.gallery/index.sqlite (WAL). It holds
 * the job queue, so a quit mid-import resumes where it stopped, and the photo
 * rows. Everything in it can be rebuilt from originals/.
 */

export const DB_FILE = join('.gallery', 'index.sqlite')

export type JobState = 'queued' | 'working' | 'done' | 'failed' | 'duplicate' | 'cancelled'
/** How far a job got. Every stage is keyed by the content hash, so redoing one is harmless. */
export type JobStage = 'new' | 'hashed' | 'thumbed' | 'copied' | 'recorded' | 'done'
export type IssueKind = ImportIssue['kind']

export interface JobRow {
  id: number
  drop_id: number
  batch: number
  source: string
  rel_dir: string
  state: JobState
  stage: JobStage
  attempts: number
  hash: string | null
  format: PhotoFormat | null
  bytes: number | null
  width: number | null
  height: number | null
  lqip: string | null
  target: string | null
  error_kind: IssueKind | null
  error_reason: string | null
  retryable: number | null
}

export interface PhotoRecord {
  id: string
  job_id: number | null
  original_path: string
  name: string
  format: PhotoFormat
  width: number
  height: number
  bytes: number
  taken_at: string | null
  camera: string | null
  lens: string | null
  focal_length: number | null
  aperture: number | null
  shutter: number | null
  iso: number | null
  gps_lat: number | null
  gps_lon: number | null
  rating: number | null
  title: string | null
  caption: string | null
  keywords: string
  orientation: number | null
  lqip: string | null
  has_thumb: number
  has_display: number
  seq: number
  created_at: string
}

export type NewPhoto = Omit<PhotoRecord, 'seq' | 'created_at' | 'has_display'>

export interface BatchCounts {
  total: number
  done: number
  imported: number
  duplicates: number
  failed: number
  remaining: number
}

type Migration = (db: DatabaseSync) => void

/** Schema migrations; index i upgrades user_version i → i + 1. Append only. */
export const MIGRATIONS: Migration[] = [
  (db) =>
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE drops (
        id INTEGER PRIMARY KEY,
        batch INTEGER NOT NULL,
        paths TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        drop_id INTEGER NOT NULL,
        batch INTEGER NOT NULL,
        source TEXT NOT NULL,
        rel_dir TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','working','done','failed','duplicate','cancelled')),
        stage TEXT NOT NULL DEFAULT 'new',
        attempts INTEGER NOT NULL DEFAULT 0,
        hash TEXT,
        format TEXT,
        bytes INTEGER,
        width INTEGER,
        height INTEGER,
        lqip TEXT,
        target TEXT,
        error_kind TEXT,
        error_reason TEXT,
        retryable INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (drop_id, source)
      );
      CREATE INDEX jobs_state ON jobs (state, id);
      CREATE INDEX jobs_batch ON jobs (batch, state);
      CREATE INDEX jobs_hash ON jobs (hash);
      CREATE TABLE photos (
        id TEXT PRIMARY KEY,
        job_id INTEGER,
        original_path TEXT NOT NULL,
        name TEXT NOT NULL,
        format TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        taken_at TEXT,
        camera TEXT,
        lens TEXT,
        focal_length REAL,
        aperture REAL,
        shutter REAL,
        iso INTEGER,
        gps_lat REAL,
        gps_lon REAL,
        rating INTEGER,
        title TEXT,
        caption TEXT,
        keywords TEXT NOT NULL DEFAULT '[]',
        orientation INTEGER,
        lqip TEXT,
        has_thumb INTEGER NOT NULL DEFAULT 0,
        has_display INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX photos_path ON photos (lower(original_path));
      CREATE INDEX jobs_target ON jobs (lower(target));
    `)
]

export const SCHEMA_VERSION = MIGRATIONS.length

const now = () => new Date().toISOString()

export class IngestDb {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (or with `create`, creates) the index. Returns null when it doesn't exist and create is false. */
  static open(root: string, { create }: { create: boolean }): IngestDb | null {
    const file = join(root, DB_FILE)
    if (!existsSync(file)) {
      if (!create) return null
      mkdirSync(join(root, '.gallery'), { recursive: true })
    }
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000')
      migrateDb(db)
    } catch (err) {
      db.close()
      throw err
    }
    const store = new IngestDb(db)
    store.recoverInterrupted()
    return store
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Jobs that were in flight when the app stopped go back to the queue. */
  private recoverInterrupted(): void {
    this.db.prepare(`UPDATE jobs SET state = 'queued', updated_at = ? WHERE state = 'working'`).run(now())
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
    else
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run(key, value)
  }

  currentBatch(): number {
    return Number(this.getMeta('batch') ?? 0)
  }

  newBatch(): number {
    const next = this.currentBatch() + 1
    this.setMeta('batch', String(next))
    return next
  }

  addDrop(batch: number, paths: string[]): number {
    const r = this.db
      .prepare('INSERT INTO drops (batch, paths, created_at) VALUES (?, ?, ?)')
      .run(batch, JSON.stringify(paths), now())
    return Number(r.lastInsertRowid)
  }

  unfinishedDrops(): { id: number; batch: number; paths: string[] }[] {
    const rows = this.db.prepare('SELECT id, batch, paths FROM drops WHERE done = 0 ORDER BY id').all() as {
      id: number
      batch: number
      paths: string
    }[]
    return rows.map((r) => ({ id: r.id, batch: r.batch, paths: JSON.parse(r.paths) as string[] }))
  }

  finishDrop(id: number): void {
    this.db.prepare('UPDATE drops SET done = 1 WHERE id = ?').run(id)
  }

  finishAllDrops(): void {
    this.db.prepare('UPDATE drops SET done = 1 WHERE done = 0').run()
  }

  /** Adds discovered files as queued jobs. Re-walking a drop after a restart adds nothing twice. */
  insertJobs(dropId: number, batch: number, entries: { source: string; relDir: string }[]): number {
    if (entries.length === 0) return 0
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO jobs (drop_id, batch, source, rel_dir, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`
    )
    const t = now()
    return this.tx(() => {
      let added = 0
      for (const e of entries) added += Number(stmt.run(dropId, batch, e.source, e.relDir, t, t).changes)
      return added
    })
  }

  /** Takes up to `n` queued jobs, oldest first, and marks them working. */
  claim(n: number): JobRow[] {
    if (n <= 0) return []
    return this.tx(() => {
      const rows = this.db
        .prepare(`SELECT * FROM jobs WHERE state = 'queued' ORDER BY id LIMIT ?`)
        .all(n) as unknown as JobRow[]
      const mark = this.db.prepare(
        `UPDATE jobs SET state = 'working', attempts = attempts + 1, updated_at = ? WHERE id = ?`
      )
      const t = now()
      for (const r of rows) mark.run(t, r.id)
      return rows.map((r) => ({ ...r, state: 'working' as const, attempts: r.attempts + 1 }))
    })
  }

  /** Puts a working job back in the queue (disk full while another job already paused the queue). */
  requeue(id: number): void {
    this.db
      .prepare(`UPDATE jobs SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'working'`)
      .run(now(), id)
  }

  job(id: number): JobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined) ?? null
  }

  updateJob(id: number, fields: Partial<Omit<JobRow, 'id'>>): void {
    const keys = Object.keys(fields)
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = ?`).join(', ')
    const values = keys.map((k) => (fields as Record<string, SQLInputValue>)[k] ?? null)
    this.db.prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id)
  }

  failJob(id: number, kind: IssueKind, reason: string, retryable: boolean): void {
    this.updateJob(id, {
      state: kind === 'duplicate' ? 'duplicate' : 'failed',
      error_kind: kind,
      error_reason: reason,
      retryable: retryable ? 1 : 0
    })
  }

  /**
   * What a content hash already belongs to: a photo made by another job, or
   * another live job in the queue that claimed it first. Null when it is new.
   */
  findDuplicate(hash: string, jobId: number): { name: string; originalPath: string | null } | null {
    const photo = this.db.prepare('SELECT name, original_path, job_id FROM photos WHERE id = ?').get(hash) as
      { name: string; original_path: string; job_id: number | null } | undefined
    if (photo && photo.job_id !== jobId) return { name: photo.name, originalPath: photo.original_path }
    if (photo) return null
    const other = this.db
      .prepare(
        `SELECT source, target FROM jobs WHERE hash = ? AND id != ? AND state IN ('queued','working','done') ORDER BY id LIMIT 1`
      )
      .get(hash, jobId) as { source: string; target: string | null } | undefined
    if (!other) return null
    const name = (other.target ?? other.source).split(/[\\/]/).pop() ?? other.source
    return { name, originalPath: other.target }
  }

  /** Relative targets already used by photos or reserved by jobs (lowercased, for NTFS-style comparison). */
  targetTaken(rel: string, jobId: number): boolean {
    const lower = rel.toLowerCase()
    const photo = this.db.prepare('SELECT job_id FROM photos WHERE lower(original_path) = ?').get(lower) as
      { job_id: number | null } | undefined
    if (photo && photo.job_id !== jobId) return true
    const job = this.db
      .prepare(
        `SELECT id FROM jobs WHERE lower(target) = ? AND id != ? AND state IN ('queued','working','done') LIMIT 1`
      )
      .get(lower, jobId)
    return job !== undefined
  }

  /** Records a photo (idempotent: a resumed job updates its own row and keeps its place). */
  upsertPhoto(p: NewPhoto): PhotoRecord {
    return this.tx(() => {
      const existing = this.photo(p.id)
      const seq = existing?.seq ?? this.nextSeq()
      const createdAt = existing?.created_at ?? now()
      this.db
        .prepare(
          `INSERT INTO photos (id, job_id, original_path, name, format, width, height, bytes, taken_at, camera, lens,
             focal_length, aperture, shutter, iso, gps_lat, gps_lon, rating, title, caption, keywords, orientation, lqip,
             has_thumb, has_display, seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET job_id = excluded.job_id, original_path = excluded.original_path,
             name = excluded.name, format = excluded.format, width = excluded.width, height = excluded.height,
             bytes = excluded.bytes, taken_at = excluded.taken_at, camera = excluded.camera, lens = excluded.lens,
             focal_length = excluded.focal_length, aperture = excluded.aperture, shutter = excluded.shutter,
             iso = excluded.iso, gps_lat = excluded.gps_lat, gps_lon = excluded.gps_lon, rating = excluded.rating,
             title = excluded.title, caption = excluded.caption, keywords = excluded.keywords,
             orientation = excluded.orientation, lqip = excluded.lqip, has_thumb = excluded.has_thumb`
        )
        .run(
          p.id,
          p.job_id,
          p.original_path,
          p.name,
          p.format,
          p.width,
          p.height,
          p.bytes,
          p.taken_at,
          p.camera,
          p.lens,
          p.focal_length,
          p.aperture,
          p.shutter,
          p.iso,
          p.gps_lat,
          p.gps_lon,
          p.rating,
          p.title,
          p.caption,
          p.keywords,
          p.orientation,
          p.lqip,
          p.has_thumb,
          existing?.has_display ?? 0,
          seq,
          createdAt
        )
      return this.photo(p.id)!
    })
  }

  private nextSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM photos').get() as { m: number | null }
    return row.m === null ? 0 : row.m + 1
  }

  setDisplay(id: string): void {
    this.db.prepare('UPDATE photos SET has_display = 1 WHERE id = ?').run(id)
  }

  photo(id: string): PhotoRecord | null {
    return (this.db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as unknown as PhotoRecord | undefined) ?? null
  }

  photoCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n
  }

  listPhotos(offset: number, limit: number): PhotoSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM photos ORDER BY seq LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as PhotoRecord[]
    return rows.map(toSummary)
  }

  counts(batch: number): BatchCounts {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM jobs WHERE batch = ? GROUP BY state').all(batch) as {
      state: JobState
      n: number
    }[]
    const by = (s: JobState) => rows.find((r) => r.state === s)?.n ?? 0
    const imported = by('done')
    const duplicates = by('duplicate')
    const failed = by('failed')
    const remaining = by('queued') + by('working')
    return {
      total: imported + duplicates + failed + remaining,
      done: imported + duplicates + failed,
      imported,
      duplicates,
      failed,
      remaining
    }
  }

  /** Queued or working jobs in any batch. */
  pending(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','working')`).get() as { n: number }
    ).n
  }

  queued(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'`).get() as { n: number }).n
  }

  issues(batch: number, limit = 10_000): ImportIssue[] {
    const rows = this.db
      .prepare(
        `SELECT id, source, error_kind, error_reason, retryable FROM jobs
         WHERE batch = ? AND state IN ('failed','duplicate') ORDER BY id LIMIT ?`
      )
      .all(batch, limit) as unknown as Pick<JobRow, 'id' | 'source' | 'error_kind' | 'error_reason' | 'retryable'>[]
    return rows.map(toIssue)
  }

  issue(id: number): ImportIssue | null {
    const row = this.job(id)
    return row && (row.state === 'failed' || row.state === 'duplicate') ? toIssue(row) : null
  }

  /** Cancels the queue: queued jobs are dropped, finished work stays. */
  cancelQueued(): number {
    return Number(
      this.db.prepare(`UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE state = 'queued'`).run(now()).changes
    )
  }

  /**
   * Re-queues failed jobs into `batch`: the given issue ids (any failed job),
   * or every failed job that Retry can help. Stages restart from the top;
   * they are idempotent, so finished pieces are reused.
   */
  retry(batch: number, ids?: number[]): number {
    const reset = `state = 'queued', stage = 'new', hash = NULL, target = NULL, error_kind = NULL, error_reason = NULL,
      retryable = NULL, batch = ?, updated_at = ?`
    const t = now()
    if (ids) {
      const stmt = this.db.prepare(`UPDATE jobs SET ${reset} WHERE id = ? AND state = 'failed'`)
      return this.tx(() => ids.reduce((n, id) => n + Number(stmt.run(batch, t, id).changes), 0))
    }
    return Number(
      this.db.prepare(`UPDATE jobs SET ${reset} WHERE state = 'failed' AND retryable = 1`).run(batch, t).changes
    )
  }
}

function migrateDb(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version > SCHEMA_VERSION)
    throw new Error('This project was imported by a newer version of galleryLAB. Update galleryLAB, then try again.')
  for (let v = version; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN IMMEDIATE')
    try {
      MIGRATIONS[v]!(db)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

export function toSummary(r: PhotoRecord): PhotoSummary {
  return {
    id: r.id,
    originalPath: r.original_path,
    name: r.name,
    format: r.format,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    takenAt: r.taken_at,
    lqip: r.lqip,
    thumb: r.has_thumb ? derivativePath('thumb', r.id) : null,
    display: r.has_display ? derivativePath('display', r.id) : null,
    seq: r.seq
  }
}

function toIssue(r: Pick<JobRow, 'id' | 'source' | 'error_kind' | 'error_reason' | 'retryable'>): ImportIssue {
  return {
    id: r.id,
    source: r.source,
    kind: r.error_kind ?? 'failed',
    reason: r.error_reason ?? 'Something went wrong while importing this file. Choose Retry to try again.',
    retryable: r.retryable === 1
  }
}
