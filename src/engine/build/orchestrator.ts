import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  BuildProgress,
  PhotoReading,
  type BuildStage,
  type GeneratedAsset,
  type GenerationEstimate,
  type GeneratorPrices,
  type GeneratorProvider
} from '@shared/build'
import { derivativePath } from '@shared/ingest'
import type { EngineEvent } from '@shared/rpc'
import { IngestDb, type BuildRow, type PhotoRecord } from '../ingest/db'
import { WeightedPool } from '../ingest/pool'
import { estimate as estimateCost, plan, type Limits } from './generate'
import { onImportDone, sharedDecodePool } from './hooks'
import { createProvider, ProviderError, providerLabel, type ProviderDeps } from './providers'
import { READING_VERSION, readThumb as defaultReadThumb, type ReadInput } from './reading'
import { CollectionSummary, summarize } from './summary'
import { buildTheme, DEFAULT_RULES, Theme, themeHash, writeTheme, type Rules } from './theming'

/**
 * The build orchestrator: one build per project at a time, its state in the
 * project's SQLite so a quit resumes. Stages run in order (reading →
 * theming → generating); every stage is idempotent, so resuming or
 * restarting simply re-runs the ones not yet complete. Readings share the
 * import's decode pool at a lower priority, so an import never waits.
 */

export interface Credentials {
  provider: GeneratorProvider
  key: string | null
  prices: GeneratorPrices
  limits: Limits
}

export interface BuildOptions {
  pool?: WeightedPool
  /** Progress events at most this often per project (default 200 ms, at most ~5/s). */
  progressIntervalMs?: number
  /** Close the database this long after a build goes quiet. */
  idleCloseMs?: number
  now?: () => number
  clock?: () => string
  log?: (message: string) => void
  rules?: Rules
  providerDeps?: ProviderDeps
  /** Test hook, awaited before each photo reading and each generated image. */
  beforeStep?: (step: 'photo' | 'image', id: string) => Promise<void> | void
  readThumb?: typeof defaultReadThumb
  /** Start a build when an import finishes (default true). */
  autoStart?: boolean
  /** Readings run at once (default: the pool's slots). */
  concurrency?: number
}

type Options = Required<Omit<BuildOptions, 'pool' | 'providerDeps' | 'beforeStep' | 'concurrency'>> &
  Pick<BuildOptions, 'pool' | 'providerDeps' | 'beforeStep' | 'concurrency'>

const STAGE_WEIGHT: Record<BuildStage, number> = { reading: 0.6, theming: 0.1, generating: 0.3 }
const STAGES: BuildStage[] = ['reading', 'theming', 'generating']
export const GENERATED_DIR = join('.gallery', 'generated')

export const STATUS = {
  notBuilt: 'Not built yet.',
  noPhotos: 'Add photos to build.',
  waiting: 'Waiting to start.',
  reading: (read: number, total: number) =>
    `Reading ${fmt(read)} of ${fmt(total)} ${total === 1 ? 'photo' : 'photos'}.`,
  theming: 'Working out the theme.',
  making: (i: number, n: number) => `Making image ${fmt(i)} of ${fmt(n)}.`,
  built: 'Built.',
  themedNoKey: 'Themed. Add a generator key in Settings to make assets.',
  themedNoImages: 'Themed. Images per build is 0 in Settings, so no assets were made.',
  overCap: (n: number, cost: number, cap: number) =>
    `Themed. Making ${fmt(n)} images would cost about $${cost.toFixed(2)}, over the $${cap.toFixed(2)} cap. Raise the cap or lower images per build in Settings.`,
  paused: 'Paused.',
  pausedMessage: 'Paused. Choose Resume to carry on.',
  stopped: 'Stopped.',
  failed: 'The build stopped.',
  noThumbs: 'The photos have no thumbnails yet. Finish the import, then build again.'
}

const fmt = (n: number) => n.toLocaleString('en-US')
const toOsPath = (rel: string) => rel.split('/')

interface Counts {
  photos: number
  read: number
  images: number
  made: number
}

class ProjectBuild {
  private db: IngestDb | null = null
  private row: BuildRow
  private counts: Counts = { photos: 0, read: 0, images: 0, made: 0 }
  private runPromise: Promise<void> | null = null
  private stop: 'pause' | 'cancel' | 'restart' | 'dispose' | null = null
  private lastEmit = 0
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private closeTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** Memory only: the provider key never touches the database or an event. */
  credentials: Credentials | null = null

  constructor(
    readonly projectId: string,
    public root: string,
    private readonly broadcast: (e: EngineEvent) => void,
    private readonly opts: Options
  ) {
    this.row = emptyRow()
    const db = this.open(false)
    if (db) {
      this.row = db.buildRow() ?? emptyRow()
      this.counts = { ...this.counts, ...safeJson<Partial<Counts>>(this.row.counts, {}) }
    }
    this.settle()
  }

  private resumed = false

  /** A build interrupted by a quit carries on where it stopped (once credentials, if any, are known). */
  resumeInterrupted(): void {
    if (this.resumed) return
    this.resumed = true
    if (this.row.state === 'running' || this.row.state === 'waiting') this.begin(true)
  }

  get running(): boolean {
    return this.runPromise !== null
  }

  // ----- operations ---------------------------------------------------------

  start(): BuildProgress {
    const db = this.open(false)
    if (!db) {
      this.row = { ...emptyRow(), status: STATUS.noPhotos }
      return this.progress()
    }
    if (this.running) {
      this.stop = 'restart'
      this.row.state = 'waiting'
      this.row.status = STATUS.waiting
      this.row.message = null
      this.persist()
      return this.emit(true)
    }
    this.begin(false)
    return this.progress()
  }

  pause(): BuildProgress {
    if (this.running && !this.stop) {
      this.stop = 'pause'
      return this.progress()
    }
    return this.emit(true)
  }

  resume(): BuildProgress {
    if (this.row.state === 'paused' && !this.running) this.begin(true)
    return this.emit(true)
  }

  cancel(): BuildProgress {
    if (this.running) {
      this.stop = 'cancel'
      return this.progress()
    }
    if (this.row.state === 'paused' || this.row.state === 'waiting') {
      this.row = {
        ...this.row,
        state: 'idle',
        stage: null,
        completed: '[]',
        status: STATUS.stopped,
        message: null,
        finished_at: this.opts.clock()
      }
      this.persist()
    }
    return this.emit(true)
  }

  status(): BuildProgress {
    this.settle()
    return this.progress()
  }

  reading(photoId: string): PhotoReading | null {
    const db = this.open(false)
    const raw = db?.reading(photoId)
    this.settle()
    if (!raw) return null
    const parsed = PhotoReading.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  assets(): GeneratedAsset[] {
    const db = this.open(false)
    const rows = db?.assets() ?? []
    this.settle()
    return rows.map((a) => ({
      id: a.id,
      projectId: this.projectId,
      kind: a.kind,
      path: a.path,
      seedPhotoIds: safeJson<string[]>(a.seed_photo_ids, []),
      prompt: a.prompt,
      provider: a.provider as GeneratorProvider,
      createdAt: a.created_at
    }))
  }

  estimate(): GenerationEstimate {
    const c = this.credentials
    if (!c) return { provider: 'none', images: 0, pricePerImageUsd: 0, totalUsd: 0, withinCap: true }
    const db = this.open(false)
    const photos = db?.photoCount().photos ?? 0
    this.settle()
    return estimateCost(c.provider, photos, c.prices, c.limits)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stop = 'dispose'
    if (this.emitTimer) clearTimeout(this.emitTimer)
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.emitTimer = this.closeTimer = null
    await this.runPromise
    this.db?.close()
    this.db = null
  }

  // ----- the run ------------------------------------------------------------

  private begin(continuing: boolean): void {
    const db = this.open(false)
    if (!db || this.disposed) return
    const now = this.opts.clock()
    if (!continuing) {
      this.row = {
        ...this.row,
        state: 'running',
        stage: null,
        completed: '[]',
        planned: JSON.stringify(this.plannedStages()),
        status: STATUS.waiting,
        message: null,
        started_at: now,
        finished_at: null
      }
      this.counts = { photos: 0, read: 0, images: 0, made: 0 }
    } else {
      this.row = { ...this.row, state: 'running', message: null }
      if (safeJson<string[]>(this.row.planned, []).length === 0) this.row.planned = JSON.stringify(this.plannedStages())
    }
    this.persist()
    this.emit(true)
    this.stop = null
    this.runPromise = this.run()
      .catch((err: unknown) => this.fail(err))
      .finally(() => {
        this.runPromise = null
        const stop = this.stop
        this.stop = null
        if (stop === 'restart' && !this.disposed) this.begin(false)
        else this.settle()
      })
  }

  /** Reading and theming always; generating when a provider and key are at hand. */
  private plannedStages(): BuildStage[] {
    const c = this.credentials
    return c && c.provider !== 'none' && c.key ? STAGES : ['reading', 'theming']
  }

  private get completed(): BuildStage[] {
    return safeJson<BuildStage[]>(this.row.completed, [])
  }

  private get planned(): BuildStage[] {
    return safeJson<BuildStage[]>(this.row.planned, ['reading', 'theming'])
  }

  private async run(): Promise<void> {
    for (const stage of STAGES) {
      if (this.completed.includes(stage)) continue
      if (stage === 'generating' && !this.planned.includes('generating')) break
      this.row.stage = stage
      this.persist()
      const outcome = await this.runStage(stage)
      if (this.stop) return this.stopped()
      if (outcome === 'finished-early') return
      this.row.completed = JSON.stringify([...this.completed, stage])
      this.persist()
    }
    this.finish(this.planned.includes('generating') ? STATUS.built : STATUS.themedNoKey, null)
  }

  private async runStage(stage: BuildStage): Promise<'ok' | 'finished-early'> {
    switch (stage) {
      case 'reading':
        return this.readAll()
      case 'theming':
        return this.theme()
      case 'generating':
        return this.generate()
    }
  }

  private stopped(): void {
    const stop = this.stop
    if (stop === 'pause') {
      this.row = { ...this.row, state: 'paused', status: STATUS.paused, message: STATUS.pausedMessage }
      this.persist()
      this.emit(true)
    } else if (stop === 'cancel') {
      this.row = {
        ...this.row,
        state: 'idle',
        stage: null,
        completed: '[]',
        status: STATUS.stopped,
        message: null,
        finished_at: this.opts.clock()
      }
      this.persist()
      this.emit(true)
    }
    // 'restart' and 'dispose' leave the row as it is: a restart rewrites it, a quit resumes it.
  }

  private finish(status: string, message: string | null): void {
    this.row = { ...this.row, state: 'done', status, message, finished_at: this.opts.clock() }
    this.persist()
    this.emit(true)
  }

  private fail(err: unknown): void {
    const message =
      err instanceof ProviderError
        ? err.message
        : 'Something went wrong while building. Choose Build to try again; if it keeps happening, report it.'
    if (!(err instanceof ProviderError))
      this.opts.log(
        `Build of ${this.projectId} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
      )
    if (this.disposed) return
    this.row = { ...this.row, state: 'failed', status: STATUS.failed, message, finished_at: this.opts.clock() }
    this.persist()
    this.emit(true)
  }

  // ----- reading --------------------------------------------------------------

  private async readAll(): Promise<'ok' | 'finished-early'> {
    const db = this.db!
    const all = db.allPhotos()
    const unread = db.unreadPhotos(READING_VERSION)
    const withThumb = all.filter((p) => p.has_thumb).length
    this.counts.photos = withThumb
    this.counts.read = withThumb - unread.length
    this.persist()
    if (withThumb === 0) {
      this.finish(all.length === 0 ? STATUS.noPhotos : STATUS.noThumbs, null)
      return 'finished-early'
    }
    this.emit(true)
    const pool = this.opts.pool ?? sharedDecodePool() ?? new WeightedPool(2, 50)
    const workers = Math.max(1, Math.min(this.opts.concurrency ?? pool.slots, unread.length))
    let next = 0
    const worker = async () => {
      while (!this.stop && !this.disposed) {
        const photo = unread[next++]
        if (!photo) return
        await this.opts.beforeStep?.('photo', photo.id)
        if (this.stop || this.disposed) return
        const reading = await this.readOne(pool, photo)
        if (this.disposed) return
        if (reading) this.db?.putReading(photo.id, READING_VERSION, reading)
        this.counts.read++
        this.persist()
        this.emit()
      }
    }
    await Promise.all(Array.from({ length: workers }, worker))
    return 'ok'
  }

  /** Reads one photo on the shared pool at a lower priority than any import work. A photo that won't decode is skipped. */
  private async readOne(pool: WeightedPool, photo: PhotoRecord): Promise<PhotoReading | null> {
    const file = join(this.root, ...toOsPath(derivativePath('thumb', photo.id)))
    const input: ReadInput = {
      photoId: photo.id,
      width: photo.width,
      height: photo.height,
      takenAt: photo.taken_at,
      gpsLat: photo.gps_lat
    }
    try {
      return await pool.run(0.3, 2, () => this.opts.readThumb(file, input))
    } catch (err) {
      this.opts.log(`Could not read ${photo.id}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  // ----- theming --------------------------------------------------------------

  private async theme(): Promise<'ok'> {
    const db = this.db!
    this.emit(true)
    const readings = db
      .readings(READING_VERSION)
      .map((r) => PhotoReading.safeParse(r.reading))
      .flatMap((r) => (r.success ? [r.data] : []))
    const summary = summarize(readings)
    const theme = buildTheme(this.projectId, summary, seedFor(this.projectId), this.opts.rules, this.opts.clock)
    const hash = themeHash(theme)
    await writeTheme(this.root, theme)
    if (this.disposed) return 'ok'
    this.row = { ...this.row, summary: JSON.stringify(summary), theme: JSON.stringify(theme), theme_hash: hash }
    this.persist()
    return 'ok'
  }

  // ----- generating -----------------------------------------------------------

  private async generate(): Promise<'ok' | 'finished-early'> {
    const db = this.db!
    const c = this.credentials
    if (!c || c.provider === 'none' || !c.key) {
      this.finish(STATUS.themedNoKey, null)
      return 'finished-early'
    }
    const provider = c.provider
    const theme = Theme.parse(JSON.parse(this.row.theme ?? 'null'))
    const summary = CollectionSummary.parse(JSON.parse(this.row.summary ?? 'null'))
    const hash = this.row.theme_hash ?? themeHash(theme)
    const readings = db
      .readings(READING_VERSION)
      .map((r) => PhotoReading.safeParse(r.reading))
      .flatMap((r) => (r.success ? [r.data] : []))

    if (c.limits.imagesPerBuild <= 0) {
      this.finish(STATUS.themedNoImages, null)
      return 'finished-early'
    }
    const est = estimateCost(provider, readings.length, c.prices, c.limits)
    if (!est.withinCap) {
      const msg = STATUS.overCap(est.images, est.totalUsd, c.limits.spendCapUsd)
      this.finish(msg, msg)
      return 'finished-early'
    }

    // Assets from this theme stay; ones from another theme (or whose file is gone) are replaced.
    const keep: string[] = []
    const stale: { id: string; path: string }[] = []
    for (const a of db.assets()) {
      const exists = await fs.stat(join(this.root, ...toOsPath(a.path))).then(
        (s) => s.isFile(),
        () => false
      )
      if (a.theme_hash === hash && exists) keep.push(a.id)
      else stale.push({ id: a.id, path: a.path })
    }
    if (stale.length) {
      db.deleteAssets(stale.map((s) => s.id))
      for (const s of stale) await fs.rm(join(this.root, ...toOsPath(s.path)), { force: true }).catch(() => undefined)
    }
    const items = plan(theme, summary, readings, c.limits.imagesPerBuild).slice(keep.length)
    const total = keep.length + items.length
    this.counts.images = total
    this.counts.made = keep.length
    this.persist()
    this.emit(true)
    if (items.length === 0) return 'ok'

    const api = createProvider(provider, c.key, c.prices, this.opts.providerDeps)
    await fs.mkdir(join(this.root, GENERATED_DIR), { recursive: true })
    let made = 0
    for (const item of items) {
      if (this.stop || this.disposed) return 'ok'
      if (made >= c.limits.imagesPerBuild) break
      await this.opts.beforeStep?.('image', `${item.kind}:${item.index}`)
      if (this.stop || this.disposed) return 'ok'
      const seedPath = item.seedPhotoIds[0]
        ? join(this.root, ...toOsPath(derivativePath('thumb', item.seedPhotoIds[0])))
        : null
      let result
      try {
        result = await api.generate({
          prompt: item.prompt,
          seedImagePath: seedPath,
          kind: item.kind,
          shape: item.shape,
          seed: seedFor(`${this.projectId}:${hash}:${item.index}`) % 4294967295
        })
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'filtered') {
          this.opts.log(
            `${providerLabel(provider, this.opts.providerDeps?.config)} declined image ${item.index + 1}; skipped.`
          )
          this.counts.images--
          this.persist()
          this.emit()
          continue
        }
        throw err
      }
      if (this.disposed) return 'ok'
      const id = randomUUID()
      const rel = `.gallery/generated/${id}.${result.format === 'jpeg' ? 'jpg' : result.format}`
      await fs.writeFile(join(this.root, ...toOsPath(rel)), result.bytes)
      const createdAt = this.opts.clock()
      this.db?.insertAsset({
        id,
        kind: item.kind,
        path: rel,
        seed_photo_ids: JSON.stringify(item.seedPhotoIds),
        prompt: item.prompt,
        provider,
        theme_hash: hash,
        created_at: createdAt
      })
      made++
      this.counts.made = keep.length + made
      this.persist()
      this.broadcast({
        type: 'build.asset',
        asset: {
          id,
          projectId: this.projectId,
          kind: item.kind,
          path: rel,
          seedPhotoIds: item.seedPhotoIds,
          prompt: item.prompt,
          provider,
          createdAt
        }
      })
      this.emit()
    }
    return 'ok'
  }

  // ----- state and events -----------------------------------------------------

  private open(create: boolean): IngestDb | null {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    if (this.db) return this.db
    if (this.disposed) return null
    this.db = IngestDb.open(this.root, { create, recover: false })
    return this.db
  }

  private settle(): void {
    if (this.running || !this.db || this.closeTimer || this.disposed) return
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      if (this.running) return
      this.db?.close()
      this.db = null
    }, this.opts.idleCloseMs)
    this.closeTimer.unref?.()
  }

  private persist(): void {
    if (!this.db || this.disposed) return
    this.row.counts = JSON.stringify(this.counts)
    this.row = this.db.putBuild(this.row)
  }

  progress(): BuildProgress {
    const r = this.row
    const completed = this.completed
    const planned = this.planned
    const stage = (r.stage as BuildStage | null) ?? null
    let stageFraction = 0
    if (stage === 'reading') stageFraction = this.counts.photos ? this.counts.read / this.counts.photos : 1
    else if (stage === 'theming') stageFraction = completed.includes('theming') ? 1 : 0
    else if (stage === 'generating') stageFraction = this.counts.images ? this.counts.made / this.counts.images : 1
    if (stage && completed.includes(stage)) stageFraction = 1
    stageFraction = Math.max(0, Math.min(1, stageFraction))
    const weightOf = (s: BuildStage) => (planned.includes(s) ? STAGE_WEIGHT[s] : 0)
    const totalWeight = planned.reduce((s, st) => s + weightOf(st), 0) || 1
    let fraction = completed.reduce((s, st) => s + weightOf(st), 0)
    if (stage && !completed.includes(stage)) fraction += weightOf(stage) * stageFraction
    fraction = Math.max(0, Math.min(1, fraction / totalWeight))
    if (r.state === 'done') fraction = 1
    if (r.state === 'idle') fraction = 0

    let status = r.status || STATUS.notBuilt
    if (r.state === 'running') {
      if (stage === 'reading') status = STATUS.reading(this.counts.read, this.counts.photos)
      else if (stage === 'theming') status = STATUS.theming
      else if (stage === 'generating')
        status = this.counts.images
          ? STATUS.making(Math.min(this.counts.images, this.counts.made + 1), this.counts.images)
          : STATUS.waiting
      else status = STATUS.waiting
    }
    return BuildProgress.parse({
      projectId: this.projectId,
      state: r.state,
      stage,
      stageFraction,
      fraction,
      status,
      message: r.message,
      completed,
      startedAt: r.started_at,
      finishedAt: r.finished_at
    })
  }

  /** Sends progress now (state changes, replies). */
  private emit(force: true): BuildProgress
  /** Sends progress at most every progressIntervalMs, with a trailing update. */
  private emit(force?: false): void
  private emit(force = false): BuildProgress | void {
    if (this.disposed) return force ? this.progress() : undefined
    const t = this.opts.now()
    if (!force && t - this.lastEmit < this.opts.progressIntervalMs) {
      this.emitTimer ??= setTimeout(
        () => {
          this.emitTimer = null
          if (!this.disposed) this.emit(true)
        },
        Math.max(0, this.opts.progressIntervalMs - (t - this.lastEmit))
      )
      return
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    this.lastEmit = t
    const p = this.progress()
    this.broadcast({ type: 'build.progress', progress: p })
    return p
  }
}

function emptyRow(): BuildRow {
  return {
    id: 1,
    state: 'idle',
    stage: null,
    completed: '[]',
    planned: '[]',
    status: STATUS.notBuilt,
    message: null,
    counts: '{}',
    summary: null,
    theme: null,
    theme_hash: null,
    started_at: null,
    finished_at: null,
    updated_at: ''
  }
}

function safeJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** FNV-1a of a string, for seeds. */
export function seedFor(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export interface ProjectParams {
  projectId: string
  root: string
  credentials?: Credentials | null
}

/** The build service: one ProjectBuild per project, created on first touch. */
export class Build {
  private readonly projects = new Map<string, ProjectBuild>()
  private readonly opts: Options
  private readonly unsubscribe: () => void

  constructor(
    private readonly broadcast: (e: EngineEvent) => void,
    options: BuildOptions = {}
  ) {
    this.opts = {
      pool: options.pool,
      progressIntervalMs: options.progressIntervalMs ?? 200,
      idleCloseMs: options.idleCloseMs ?? 3000,
      now: options.now ?? Date.now,
      clock: options.clock ?? (() => new Date().toISOString()),
      log: options.log ?? ((m) => console.warn(`[build] ${m}`)),
      rules: options.rules ?? DEFAULT_RULES,
      providerDeps: options.providerDeps,
      beforeStep: options.beforeStep,
      readThumb: options.readThumb ?? defaultReadThumb,
      autoStart: options.autoStart ?? true,
      concurrency: options.concurrency
    }
    this.unsubscribe = this.opts.autoStart
      ? onImportDone(({ projectId, root, progress }) => {
          if (progress.imported > 0) this.project({ projectId, root }).start()
        })
      : () => undefined
  }

  /** The project's build, with the latest credentials main sent (kept in memory only). */
  project(p: ProjectParams): ProjectBuild {
    let b = this.projects.get(p.projectId)
    if (b && b.root !== p.root && !b.running) {
      void b.dispose()
      b = undefined
    }
    if (!b) {
      b = new ProjectBuild(p.projectId, p.root, this.broadcast, this.opts)
      this.projects.set(p.projectId, b)
    }
    if (p.credentials !== undefined) b.credentials = p.credentials
    b.resumeInterrupted()
    return b
  }

  get providerDeps(): ProviderDeps | undefined {
    return this.opts.providerDeps
  }

  async dispose(): Promise<void> {
    this.unsubscribe()
    await Promise.all([...this.projects.values()].map((b) => b.dispose()))
    this.projects.clear()
  }
}
