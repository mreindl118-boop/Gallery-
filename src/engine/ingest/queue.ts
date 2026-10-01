import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  isVideoFormat,
  type ImportIssue,
  type ImportProgress,
  type ImportState,
  type MediaFormat
} from '@shared/ingest'
import type { EngineEvent } from '@shared/rpc'
import { IngestDb, toSummary, type IssueKind, type JobRow, type JobStage } from './db'
import {
  DecodeError,
  derivativeExists,
  makeDisplay,
  makeThumb,
  megapixels,
  probe,
  removeDerivatives
} from './derivatives'
import { copyFileAtomic, freeBytes, hashFile, readHead } from './fsutil'
import { EMPTY_REASON, HEAD_BYTES, identify, RAW_REASON, unsupportedReason } from './identify'
import { EMPTY_META, readMetadata, type PhotoMeta } from './metadata'
import { joinPosix, targetCandidates } from './paths'
import type { WeightedPool } from './pool'
import { notifyImportDone, registerDecodePool } from '../build/hooks'
import { extractPoster, probeVideo, videoMegapixels, type VideoInfo } from './video'
import { walk } from './walk'

/**
 * One project's import queue: discovery feeds job rows into SQLite, a few
 * jobs run at a time, and every stage is keyed by the content hash so a quit
 * at any point resumes without duplicates.
 */

export interface QueueContext {
  broadcast: (event: EngineEvent) => void
  pool: WeightedPool
  /** Jobs in flight per project (I/O runs a little ahead of the decode pool). */
  jobsInFlight: number
  /** Stop importing when a copy would leave less than this free. */
  minFreeBytes: number
  freeBytes: (dir: string) => Promise<number>
  progressIntervalMs: number
  /** Close the database this long after the queue goes quiet, so Windows can rename or move the project. */
  idleCloseMs: number
  now: () => number
  /** Test hook, awaited before each stage of a job. */
  beforeStage?: (stage: JobStage | 'display', job: JobRow) => Promise<void> | void
  log: (message: string) => void
}

const STAGES: JobStage[] = ['new', 'hashed', 'thumbed', 'copied', 'recorded', 'done']
const reached = (job: JobRow, stage: JobStage) => STAGES.indexOf(job.stage) >= STAGES.indexOf(stage)

export const REASONS = {
  diskFull: 'The disk is almost full, so galleryLAB stopped importing. Free up space, then choose Retry.',
  unreadable:
    "galleryLAB couldn't read this file. Check that it's still there and not open in another app, then choose Retry.",
  corrupt:
    "This file looks damaged or incomplete, so galleryLAB couldn't open it. If you have another copy, add that one.",
  corruptVideo: "galleryLAB couldn't read this video. It may be damaged or use an unsupported codec.",
  writeFailed:
    "galleryLAB couldn't save a copy in the project folder. Check that the Library drive is connected and has room, then choose Retry.",
  failed: 'Something went wrong while importing this file. Choose Retry to try again.',
  duplicate: (name: string, kind: 'photo' | 'video' = 'photo') =>
    `This ${kind} is already in the project as ${name}, so it was skipped.`
}

class IssueError extends Error {
  constructor(
    readonly kind: IssueKind,
    readonly reason: string,
    readonly retryable: boolean
  ) {
    super(reason)
  }
}

const THROUGHPUT_WINDOW_MS = 10_000

export class ProjectQueue {
  private db: IngestDb | null = null
  private paused: 'user' | 'disk-full' | null = null
  private discovering = 0
  private readonly walks = new Map<number, { aborted: boolean }>()
  private readonly running = new Set<number>()
  private readonly reserved = new Set<string>()
  private completions: number[] = []
  private batchStart = 0
  private lastEmit = 0
  private progressTimer: ReturnType<typeof setTimeout> | null = null
  private closeTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    readonly projectId: string,
    public root: string,
    private readonly ctx: QueueContext
  ) {
    registerDecodePool(ctx.pool)
  }

  get busy(): boolean {
    return this.running.size > 0 || this.discovering > 0
  }

  // ----- public operations -------------------------------------------------

  add(paths: string[]): ImportProgress {
    const db = this.open(true)!
    const batch = this.batchForNewWork(db)
    if (this.paused === 'user') this.setPaused(null)
    const dropId = db.addDrop(batch, paths)
    void this.discover(dropId, batch, paths)
    return this.emitProgress(true)
  }

  pause(): ImportProgress {
    const db = this.open(false)
    if (db && !this.paused) this.setPaused('user')
    return this.emitProgress(true)
  }

  resume(): ImportProgress {
    const db = this.open(false)
    if (db) {
      // Resuming after a full disk also picks up the file that hit it.
      if (this.paused === 'disk-full') this.requeueDiskFull(db)
      this.setPaused(null)
      this.pump()
    }
    this.settle()
    return this.emitProgress(true)
  }

  cancel(): ImportProgress {
    const db = this.open(false)
    if (db) {
      for (const w of this.walks.values()) w.aborted = true
      db.finishAllDrops()
      db.cancelQueued()
    }
    this.settle()
    return this.emitProgress(true)
  }

  retry(issueIds?: number[]): ImportProgress {
    const db = this.open(false)
    if (db) {
      const batch = this.batchForNewWork(db)
      db.retry(batch, issueIds)
      this.setPaused(null)
      this.pump()
    }
    this.settle()
    return this.emitProgress(true)
  }

  status(): { progress: ImportProgress; issues: ImportIssue[] } {
    const db = this.open(false)
    const progress = this.progress()
    const issues = db ? db.issues(db.currentBatch()) : []
    this.settle()
    return { progress, issues }
  }

  issues(): ImportIssue[] {
    return this.status().issues
  }

  photos(offset: number, limit: number) {
    const db = this.open(false)
    const list = db ? db.listPhotos(offset, limit) : []
    this.settle()
    return list
  }

  /** Picks up unfinished work after a restart: interrupted jobs, and drops whose discovery didn't finish. */
  resumeUnfinished(): boolean {
    const db = this.open(false)
    if (!db) return false
    this.batchStart = this.ctx.now()
    for (const d of db.unfinishedDrops()) {
      if (!this.walks.has(d.id)) void this.discover(d.id, d.batch, d.paths)
    }
    this.pump()
    this.settle()
    this.emitProgress(true)
    return true
  }

  dispose(): void {
    this.disposed = true
    for (const w of this.walks.values()) w.aborted = true
    if (this.progressTimer) clearTimeout(this.progressTimer)
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.progressTimer = this.closeTimer = null
    this.db?.close()
    this.db = null
  }

  // ----- database lifecycle ------------------------------------------------

  private open(create: boolean): IngestDb | null {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    if (this.db) return this.db
    if (this.disposed) return null
    const db = IngestDb.open(this.root, { create })
    if (!db) return null
    this.db = db
    const p = db.getMeta('paused')
    this.paused = p === 'user' || p === 'disk-full' ? p : null
    return db
  }

  /** When nothing is running, closes the database after a short grace period. */
  private settle(): void {
    if (this.busy || !this.db || this.closeTimer || this.disposed) return
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      if (this.busy) return
      if (this.progressTimer) {
        clearTimeout(this.progressTimer)
        this.progressTimer = null
      }
      this.db?.close()
      this.db = null
    }, this.ctx.idleCloseMs)
    this.closeTimer.unref?.()
  }

  private setPaused(reason: 'user' | 'disk-full' | null): void {
    this.paused = reason
    this.db?.setMeta('paused', reason)
  }

  /** A new batch starts when the queue was empty; otherwise new work joins the running one. */
  private batchForNewWork(db: IngestDb): number {
    if (db.pending() === 0 && this.discovering === 0) {
      this.completions = []
      this.batchStart = this.ctx.now()
      return db.newBatch()
    }
    return db.currentBatch()
  }

  private requeueDiskFull(db: IngestDb): void {
    const ids = db
      .issues(db.currentBatch())
      .filter((i) => i.kind === 'disk-full')
      .map((i) => i.id)
    if (ids.length) db.retry(db.currentBatch(), ids)
  }

  // ----- discovery ---------------------------------------------------------

  private async discover(dropId: number, batch: number, paths: string[]): Promise<void> {
    const flag = { aborted: false }
    this.walks.set(dropId, flag)
    this.discovering++
    const exclude = [join(this.root, 'originals'), join(this.root, '.gallery')]
    let buffer: { source: string; relDir: string }[] = []
    let lastFlush = 0
    let first = true
    const flush = () => {
      if (buffer.length === 0 || flag.aborted || !this.db) return
      this.db.insertJobs(dropId, batch, buffer)
      buffer = []
      lastFlush = Date.now()
      this.pump()
      this.emitProgress()
    }
    try {
      for await (const entry of walk(paths, { exclude, aborted: () => flag.aborted })) {
        buffer.push(entry)
        if (first || buffer.length >= 256 || Date.now() - lastFlush >= 50) flush()
        first = false
      }
      flush()
      if (!flag.aborted) this.db?.finishDrop(dropId)
    } catch (err) {
      this.ctx.log(`Discovery failed: ${err instanceof Error ? err.message : String(err)}`)
      this.db?.finishDrop(dropId)
    } finally {
      this.walks.delete(dropId)
      this.discovering--
      this.emitProgress(true)
      this.afterWork()
    }
  }

  // ----- running jobs ------------------------------------------------------

  private pump(): void {
    if (this.paused || !this.db || this.disposed) return
    const room = this.ctx.jobsInFlight - this.running.size
    if (room <= 0) return
    for (const job of this.db.claim(room)) {
      this.running.add(job.id)
      void this.runJob(job)
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    try {
      await this.process(job)
    } catch (err) {
      await this.handleFailure(job, err)
    } finally {
      this.running.delete(job.id)
      if (!this.disposed) {
        this.completions.push(this.ctx.now())
        this.emitProgress()
        this.pump()
        this.afterWork()
      }
    }
  }

  private afterWork(): void {
    if (this.busy || this.disposed) return
    const progress = this.emitProgress(true)
    this.settle()
    // The import settled: the build picks it up from here (reading, theming, generating).
    if (progress.state === 'done' && progress.imported > 0)
      notifyImportDone({ projectId: this.projectId, root: this.root, progress })
  }

  private async stage(stage: JobStage | 'display', job: JobRow): Promise<void> {
    if (this.ctx.beforeStage) await this.ctx.beforeStage(stage, job)
    if (this.disposed) throw new Error('disposed')
  }

  private async process(job: JobRow): Promise<void> {
    const db = this.db!
    const root = this.root
    const name = basename(job.source)

    // 1. Identify by bytes and hash the content; exact duplicates stop here.
    await this.stage('new', job)
    let { hash, format, bytes } = job
    if (!reached(job, 'hashed') || !hash || !format || bytes === null) {
      const st = await fs.stat(job.source)
      if (!st.isFile()) throw Object.assign(new Error('Not a file'), { code: 'EISDIR' })
      if (st.size === 0) throw new IssueError('corrupt', EMPTY_REASON, false)
      const kind = identify(await readHead(job.source, HEAD_BYTES), name)
      if (kind.kind === 'empty') throw new IssueError('corrupt', EMPTY_REASON, false)
      if (kind.kind === 'raw') throw new IssueError('unsupported', RAW_REASON, false)
      if (kind.kind === 'unsupported') throw new IssueError('unsupported', unsupportedReason(kind.what), false)
      const h = await hashFile(job.source)
      // Check and claim in one synchronous step, so two copies in one batch can't both win.
      const dup = db.findDuplicate(h, job.id)
      if (dup)
        throw new IssueError('duplicate', REASONS.duplicate(dup.name, kind.kind === 'video' ? 'video' : 'photo'), false)
      hash = h
      format = kind.format
      bytes = st.size
      db.updateJob(job.id, { hash, format, bytes, stage: 'hashed' })
      job = { ...job, hash, format, bytes, stage: 'hashed' }
    }
    const fmt: MediaFormat = format
    const video = isVideoFormat(fmt)

    // 2. Thumbnail first, from the source, so the contact sheet fills right away.
    await this.stage('hashed', job)
    let { width, height, lqip } = job
    let dims: { width: number; height: number } | null = width && height ? { width, height } : null
    if (!reached(job, 'thumbed') || !lqip || !width || !height || !(await derivativeExists(root, 'thumb', hash))) {
      if (video) {
        // The poster frame becomes every derivative at once; a quit before the copy only redoes this step.
        const thumb = await this.videoDerivatives(hash, job.source, ['thumb', 'display'])
        ;({ width, height, lqip } = thumb)
      } else {
        dims = await probe(job.source, fmt)
        const thumb = await this.ctx.pool.run(megapixels(dims), 0, () => makeThumb(root, hash, job.source, fmt, dims))
        ;({ width, height, lqip } = thumb)
      }
      dims = { width, height }
      db.updateJob(job.id, { width, height, lqip, stage: 'thumbed' })
      job = { ...job, width, height, lqip, stage: 'thumbed' }
    }

    // 3. Copy into originals/, keeping the dropped folder structure.
    await this.stage('thumbed', job)
    let target = job.target
    if (!reached(job, 'copied') || !target || !(await fileExists(join(root, target)))) {
      target = await this.copyIn(job, hash, bytes)
      db.updateJob(job.id, { target, stage: 'copied' })
      job = { ...job, target, stage: 'copied' }
    }
    const copy = join(root, target)

    // 4. Metadata, then the photo row; the contact sheet can show it now.
    await this.stage('copied', job)
    if (!reached(job, 'recorded') || !db.photo(hash)) {
      let meta: PhotoMeta = EMPTY_META
      let info: VideoInfo | null = null
      if (video) info = await this.probeVideo(copy)
      else meta = await readMetadata(copy)
      const rec = db.upsertPhoto({
        id: hash,
        job_id: job.id,
        original_path: target,
        name: basename(target),
        kind: video ? 'video' : 'photo',
        format: fmt,
        width: width!,
        height: height!,
        bytes,
        taken_at: video ? info!.takenAt : meta.takenAt,
        duration_ms: info?.durationMs ?? null,
        fps: info?.fps ?? null,
        codec: info?.codec ?? null,
        camera: meta.camera,
        lens: meta.lens,
        focal_length: meta.focalLength,
        aperture: meta.aperture,
        shutter: meta.shutter,
        iso: meta.iso,
        gps_lat: meta.gpsLat,
        gps_lon: meta.gpsLon,
        rating: meta.rating,
        title: meta.title,
        caption: meta.caption,
        keywords: JSON.stringify(meta.keywords),
        orientation: meta.orientation,
        lqip,
        has_thumb: 1
      })
      db.updateJob(job.id, { stage: 'recorded' })
      job = { ...job, stage: 'recorded' }
      this.emitPhotos([rec.id])
    }

    // 5. Display size, from the copy.
    await this.stage('display', job)
    if (!(await derivativeExists(root, 'display', hash))) {
      if (video) await this.videoDerivatives(hash, copy, ['display'])
      else await this.ctx.pool.run(megapixels(dims), 1, () => makeDisplay(root, hash, copy, fmt))
    }
    db.tx(() => {
      db.setDisplay(hash)
      db.updateJob(job.id, { state: 'done', stage: 'done', error_kind: null, error_reason: null, retryable: null })
    })
    this.emitPhotos([hash])
  }

  /** ffprobe facts about a video; a file ffprobe can't read is reported as damaged. */
  private async probeVideo(file: string): Promise<VideoInfo> {
    try {
      return await probeVideo(file)
    } catch (err) {
      throw videoError(err)
    }
  }

  /**
   * One poster frame from the video, then the asked-for derivatives from it
   * through the same sharp pipeline as a photo. Counts against the decode
   * pool like a photo of the frame's size.
   */
  private async videoDerivatives(
    hash: string,
    file: string,
    which: ('thumb' | 'display')[]
  ): Promise<{ width: number; height: number; lqip: string }> {
    const info = await this.probeVideo(file)
    return this.ctx.pool.run(videoMegapixels(info), which.includes('thumb') ? 0 : 1, async () => {
      let poster: string
      try {
        poster = await extractPoster(file, info)
      } catch (err) {
        throw videoError(err)
      }
      try {
        const dims = await probe(poster, 'png')
        let out = { width: dims!.width, height: dims!.height, lqip: '' }
        if (which.includes('thumb')) out = await makeThumb(this.root, hash, poster, 'png', dims)
        if (which.includes('display')) await makeDisplay(this.root, hash, poster, 'png')
        return out
      } finally {
        await fs.rm(dirname(poster), { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  /** Copies the file to its first free name under originals/ and returns the target relative to the project. */
  private async copyIn(job: JobRow, hash: string, bytes: number): Promise<string> {
    const relDir = joinPosix('originals', job.rel_dir)
    const dir = join(this.root, ...relDir.split('/'))
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (err) {
      throw writeError(err)
    }
    const free = await this.ctx.freeBytes(this.root).catch(() => Number.POSITIVE_INFINITY)
    if (free - bytes < this.ctx.minFreeBytes) throw new IssueError('disk-full', REASONS.diskFull, true)

    for (const rel of targetCandidates(relDir, basename(job.source))) {
      const key = rel.toLowerCase()
      if (this.reserved.has(key) || this.db!.targetTaken(rel, job.id)) continue
      const abs = join(this.root, ...rel.split('/'))
      const existing = await fs.stat(abs).catch(() => null)
      if (existing) {
        // Our own copy from before a restart: same bytes, so use it instead of making another.
        if (existing.isFile() && existing.size === bytes && (await hashFile(abs).catch(() => '')) === hash) return rel
        continue
      }
      if (this.reserved.has(key)) continue
      this.reserved.add(key)
      try {
        await copyFileAtomic(job.source, join(dir, `.${job.id}.gl-part`), abs, bytes)
        return rel
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
        const sourceOk = await fs.access(job.source).then(
          () => true,
          () => false
        )
        throw sourceOk ? writeError(err) : err
      } finally {
        this.reserved.delete(key)
      }
    }
    throw new Error('unreachable')
  }

  private async handleFailure(job: JobRow, err: unknown): Promise<void> {
    if (this.disposed || !this.db) return
    const db = this.db
    const issue = classify(err)
    if (!(err instanceof IssueError)) this.ctx.log(`Import of ${job.source} failed: ${String(err)}`)
    if (issue.kind === 'disk-full') {
      if (this.paused === 'disk-full') {
        db.requeue(job.id) // already reported once; this file waits for Retry with the rest
        return
      }
      this.setPaused('disk-full')
    }
    db.failJob(job.id, issue.kind, issue.reason, issue.retryable)
    const out = db.issue(job.id)
    if (out) this.ctx.broadcast({ type: 'import.issue', projectId: this.projectId, issue: out })
    if (issue.kind === 'disk-full') this.emitProgress(true)
    // Nothing else refers to derivatives of a file that never became a photo.
    const hash = db.job(job.id)?.hash
    if (hash && issue.kind !== 'duplicate' && !db.photo(hash)) await removeDerivatives(this.root, hash)
  }

  // ----- events ------------------------------------------------------------

  private emitPhotos(ids: string[]): void {
    const db = this.db
    if (!db) return
    const photos = ids.flatMap((id) => {
      const r = db.photo(id)
      return r ? [toSummary(r)] : []
    })
    if (photos.length) this.ctx.broadcast({ type: 'import.photos', projectId: this.projectId, photos })
  }

  progress(): ImportProgress {
    const db = this.db ?? this.open(false)
    const base: ImportProgress = {
      projectId: this.projectId,
      state: 'idle',
      total: 0,
      done: 0,
      imported: 0,
      duplicates: 0,
      failed: 0,
      importedVideos: 0,
      photos: 0,
      videos: 0,
      filesPerSecond: 0,
      secondsLeft: null
    }
    if (!db) return base
    const batch = db.currentBatch()
    const c = db.counts(batch)
    const count = db.photoCount()
    const remaining = c.remaining
    let state: ImportState
    if (this.paused && (remaining > 0 || this.discovering > 0)) state = 'paused'
    else if (this.discovering > 0) state = 'discovering'
    else if (remaining > 0) state = this.paused ? 'paused' : 'importing'
    else state = batch > 0 ? 'done' : 'idle'

    const t = this.ctx.now()
    this.completions = this.completions.filter((x) => t - x <= THROUGHPUT_WINDOW_MS)
    let filesPerSecond = 0
    let secondsLeft: number | null = null
    if (state === 'importing' || state === 'discovering') {
      const window = Math.max(1000, Math.min(THROUGHPUT_WINDOW_MS, t - this.batchStart))
      filesPerSecond = Math.round((this.completions.length / (window / 1000)) * 10) / 10
      secondsLeft = filesPerSecond > 0 && state === 'importing' ? Math.ceil(remaining / filesPerSecond) : null
    } else if (state === 'done') secondsLeft = 0

    return {
      ...base,
      state,
      total: c.total,
      done: c.done,
      imported: c.imported,
      duplicates: c.duplicates,
      failed: c.failed,
      importedVideos: c.importedVideos,
      photos: count.photos,
      videos: count.videos,
      filesPerSecond,
      secondsLeft
    }
  }

  /** Sends progress now (state changes, replies). */
  private emitProgress(force: true): ImportProgress
  /** Sends progress at most every progressIntervalMs, with a trailing update. */
  private emitProgress(force?: false): void
  private emitProgress(force = false): ImportProgress | void {
    const t = this.ctx.now()
    if (!force && t - this.lastEmit < this.ctx.progressIntervalMs) {
      this.progressTimer ??= setTimeout(
        () => {
          this.progressTimer = null
          if (this.db && !this.disposed) this.emitProgress(true)
        },
        Math.max(0, this.ctx.progressIntervalMs - (t - this.lastEmit))
      )
      return
    }
    if (this.progressTimer) {
      clearTimeout(this.progressTimer)
      this.progressTimer = null
    }
    const p = this.progress()
    if (this.disposed) return p
    this.lastEmit = t
    this.ctx.broadcast({ type: 'import.progress', progress: p })
    return p
  }
}

async function fileExists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then((s) => s.isFile())
    .catch(() => false)
}

/** ffmpeg/ffprobe trouble with the file itself is a damaged video; filesystem errors pass through. */
function videoError(err: unknown): Error {
  return err instanceof DecodeError ? new IssueError('corrupt', REASONS.corruptVideo, false) : (err as Error)
}

function writeError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOSPC') return new IssueError('disk-full', REASONS.diskFull, true)
  return new IssueError('failed', REASONS.writeFailed, true)
}

const UNREADABLE = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EBUSY',
  'EISDIR',
  'ENOTDIR',
  'ELOOP',
  'EIO',
  'UNKNOWN',
  'ENAMETOOLONG'
])

export function classify(err: unknown): { kind: IssueKind; reason: string; retryable: boolean } {
  if (err instanceof IssueError) return { kind: err.kind, reason: err.reason, retryable: err.retryable }
  if (err instanceof DecodeError) return { kind: 'corrupt', reason: REASONS.corrupt, retryable: false }
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOSPC') return { kind: 'disk-full', reason: REASONS.diskFull, retryable: true }
  if (code && UNREADABLE.has(code)) return { kind: 'unreadable', reason: REASONS.unreadable, retryable: true }
  return { kind: 'failed', reason: REASONS.failed, retryable: true }
}

export const defaultFreeBytes = freeBytes
