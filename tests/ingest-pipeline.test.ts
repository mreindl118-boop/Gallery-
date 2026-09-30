import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, promises as fs, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImportIssue, ImportProgress, PhotoSummary, type ImportState } from '@shared/ingest'
import type { EngineEvent } from '@shared/rpc'
import { createIngest, Ingest, type IngestOptions } from '../src/engine/ingest'
import { REASONS } from '../src/engine/ingest/queue'
import { RAW_REASON } from '../src/engine/ingest/identify'
import {
  avif,
  heads,
  jpeg,
  jpegWithExif,
  noisyJpeg,
  png,
  rotatedJpeg,
  tiff,
  tiff16,
  webp,
  writeFile
} from './fixtures/images'

let tmp: string
let src: string
const instances: Ingest[] = []

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gl-ingest-'))
  src = join(tmp, 'source')
})
afterEach(() => {
  for (const i of instances.splice(0)) i.dispose()
  rmSync(tmp, { recursive: true, force: true })
})

function setup(opts: IngestOptions = {}, root = join(tmp, 'Project')) {
  const events: (EngineEvent & { at?: number })[] = []
  const ingest = new Ingest((e) => events.push({ ...e, at: Date.now() }), {
    idleCloseMs: 30,
    log: () => undefined,
    ...opts
  })
  instances.push(ingest)
  const p = { projectId: randomUUID(), root }
  return { ingest, events, p, root }
}

async function until<T>(fn: () => T | undefined | false, timeout = 15_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error('Timed out waiting')
    await new Promise((r) => setTimeout(r, 15))
  }
}

const waitFor = (ingest: Ingest, p: { projectId: string; root: string }, state: ImportState = 'done') =>
  until(() => {
    const s = ingest.status(p)
    return s.progress.state === state ? s : undefined
  })

/** Every file under a folder, relative with forward slashes, sorted. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) visit(p)
      else out.push(relative(dir, p).split('\\').join('/'))
    }
  }
  visit(dir)
  return out.sort()
}

const dims = async (file: string) => {
  const m = await sharp(file).metadata()
  return [m.width, m.height, m.format]
}

function row(root: string, id: string): Record<string, unknown> {
  const db = new DatabaseSync(join(root, '.gallery', 'index.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as Record<string, unknown>
  } finally {
    db.close()
  }
}

describe('ingest pipeline', () => {
  it('imports every supported format, keeps the folder structure and makes derivatives', async () => {
    const { ingest, events, p, root } = setup()
    const trip = join(src, 'Trip 2024')
    await writeFile(join(trip, 'a.jpg'), await jpeg({ width: 3000, height: 2000 }))
    await writeFile(join(trip, 'b.png'), await png())
    await writeFile(join(trip, 'actually-png.jpg'), await png({ width: 40, height: 30 }))
    await writeFile(join(trip, 'Day 1', 'c.webp'), await webp())
    await writeFile(join(trip, 'Day 1', 'd.avif'), await avif())
    await writeFile(join(trip, 'Day 1', 'Évora ☀', 'e.tif'), await tiff())
    await writeFile(join(trip, 'scan16.tif'), tiff16(600, 400))
    await writeFile(join(trip, 'Thumbs.db'), 'junk')
    await writeFile(join(trip, '.hidden', 'x.jpg'), await jpeg())
    const loose = await writeFile(join(src, 'loose.jpg'), await jpeg())

    const first = ingest.add({ ...p, paths: [trip, loose] })
    expect(ImportProgress.parse(first).state).toBe('discovering')
    const { progress, issues } = await waitFor(ingest, p)
    expect(issues).toEqual([])
    expect(progress).toMatchObject({ total: 8, done: 8, imported: 8, duplicates: 0, failed: 0, photos: 8 })

    expect(tree(join(root, 'originals'))).toEqual([
      'Trip 2024/Day 1/c.webp',
      'Trip 2024/Day 1/d.avif',
      'Trip 2024/Day 1/Évora ☀/e.tif',
      'Trip 2024/a.jpg',
      'Trip 2024/actually-png.jpg',
      'Trip 2024/b.png',
      'Trip 2024/scan16.tif',
      'loose.jpg'
    ])

    const photos = ingest.photos({ ...p, offset: 0, limit: 100 })
    expect(photos).toHaveLength(8)
    for (const ph of photos) {
      PhotoSummary.parse(ph)
      expect(ph.thumb).toBe(`.gallery/derivatives/thumb-512/${ph.id}.webp`)
      expect(ph.display).toBe(`.gallery/derivatives/display-2048/${ph.id}.webp`)
      expect(ph.lqip).toMatch(/^data:image\/webp;base64,/)
      expect(existsSync(join(root, ph.thumb!))).toBe(true)
      expect(existsSync(join(root, ph.display!))).toBe(true)
    }
    expect(photos.map((x) => x.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    const byName = Object.fromEntries(photos.map((x) => [x.name, x]))
    expect(byName['actually-png.jpg']!.format).toBe('png')
    expect(byName['d.avif']!.format).toBe('avif')
    expect(byName['scan16.tif']).toMatchObject({ format: 'tiff', width: 600, height: 400 })

    const big = byName['a.jpg']!
    expect(big).toMatchObject({ width: 3000, height: 2000, originalPath: 'originals/Trip 2024/a.jpg' })
    expect(await dims(join(root, big.thumb!))).toEqual([512, 341, 'webp'])
    expect(await dims(join(root, big.display!))).toEqual([2048, 1365, 'webp'])
    expect(await dims(join(root, byName['scan16.tif']!.thumb!))).toEqual([512, 341, 'webp'])
    const lqip = Buffer.from(big.lqip!.split(',')[1]!, 'base64')
    expect((await sharp(lqip).metadata()).width).toBe(32)

    // Originals are byte-identical copies.
    expect(await fs.readFile(join(root, big.originalPath))).toEqual(await fs.readFile(join(trip, 'a.jpg')))

    // The thumbnail event for a photo comes before its display event.
    const photoEvents = events.flatMap((e) => (e.type === 'import.photos' ? e.photos : []))
    for (const ph of photos) {
      const mine = photoEvents.filter((x) => x.id === ph.id)
      expect(mine[0]).toMatchObject({ thumb: ph.thumb, display: null })
      expect(mine.at(-1)).toMatchObject({ display: ph.display })
    }
    const last = events.filter((e) => e.type === 'import.progress').at(-1)
    expect(last).toMatchObject({ progress: { state: 'done', done: 8 } })

    // Pages in import order.
    expect(ingest.photos({ ...p, offset: 2, limit: 3 }).map((x) => x.seq)).toEqual([2, 3, 4])
  })

  it('applies EXIF orientation and handles a wide panorama', async () => {
    const { ingest, p, root } = setup()
    await writeFile(join(src, 'rotated.jpg'), await rotatedJpeg({ width: 300, height: 200 }))
    await writeFile(join(src, 'pano.jpg'), await jpeg({ width: 12000, height: 1500 }))
    ingest.add({ ...p, paths: [join(src, 'rotated.jpg'), join(src, 'pano.jpg')] })
    await waitFor(ingest, p)
    const byName = Object.fromEntries(ingest.photos({ ...p, offset: 0, limit: 10 }).map((x) => [x.name, x]))
    const r = byName['rotated.jpg']!
    expect([r.width, r.height]).toEqual([200, 300])
    expect(await dims(join(root, r.thumb!))).toEqual([200, 300, 'webp'])
    expect(await dims(join(root, r.display!))).toEqual([200, 300, 'webp'])
    expect((await sharp(join(root, r.display!)).metadata()).orientation).toBeUndefined()
    const pano = byName['pano.jpg']!
    expect([pano.width, pano.height]).toEqual([12000, 1500])
    expect(await dims(join(root, pano.thumb!))).toEqual([512, 64, 'webp'])
    expect(await dims(join(root, pano.display!))).toEqual([2048, 256, 'webp'])
  })

  it('reads metadata', async () => {
    const { ingest, p, root } = setup()
    await writeFile(join(src, 'meta.jpg'), await jpegWithExif({ width: 120, height: 80 }))
    ingest.add({ ...p, paths: [join(src, 'meta.jpg')] })
    await waitFor(ingest, p)
    const [photo] = ingest.photos({ ...p, offset: 0, limit: 1 })
    expect(photo!.takenAt).toBe('2024-05-01T10:20:30+09:00')
    const r = row(root, photo!.id)
    expect(r).toMatchObject({
      camera: 'Canon EOS R5',
      lens: 'RF24-70mm F2.8 L IS USM',
      focal_length: 50,
      aperture: 2.8,
      shutter: 0.004,
      iso: 400,
      rating: 4,
      title: 'Harbour at dawn',
      caption: 'Fishing boats before sunrise'
    })
    expect(r.gps_lat).toBeCloseTo(35.5)
    expect(r.gps_lon).toBeCloseTo(139.75)
    expect(JSON.parse(r.keywords as string)).toEqual(['sea', 'boats'])
  })

  it('turns bad files into issues without stopping the batch', async () => {
    const { ingest, events, p, root } = setup()
    const dir = join(src, 'Mixed')
    await writeFile(join(dir, 'good.jpg'), await jpeg())
    await writeFile(join(dir, 'empty.jpg'), Buffer.alloc(0))
    const noisy = await noisyJpeg()
    await writeFile(join(dir, 'truncated.jpg'), noisy.subarray(0, Math.floor(noisy.length / 2)))
    await writeFile(join(dir, 'notes.txt'), 'Shot list for Saturday')
    await writeFile(join(dir, 'IMG_0001.CR2'), heads.cr2())
    await writeFile(join(dir, 'good2.png'), await png())
    await writeFile(join(dir, 'not-really.heic'), heads.heic())
    ingest.add({ ...p, paths: [dir] })
    const { progress, issues } = await waitFor(ingest, p)
    expect(progress).toMatchObject({ total: 7, done: 7, imported: 2, failed: 5, duplicates: 0 })
    const byFile = Object.fromEntries(issues.map((i) => [i.source.split(/[\\/]/).pop(), ImportIssue.parse(i)]))
    expect(byFile['empty.jpg']).toMatchObject({ kind: 'corrupt', retryable: false })
    expect(byFile['truncated.jpg']).toMatchObject({ kind: 'corrupt', reason: REASONS.corrupt, retryable: false })
    expect(byFile['notes.txt']).toMatchObject({ kind: 'unsupported', retryable: false })
    expect(byFile['IMG_0001.CR2']).toMatchObject({ kind: 'unsupported', reason: RAW_REASON })
    expect(byFile['not-really.heic']).toMatchObject({ kind: 'corrupt' })
    expect(events.filter((e) => e.type === 'import.issue')).toHaveLength(5)
    expect(tree(join(root, 'originals'))).toEqual(['Mixed/good.jpg', 'Mixed/good2.png'])
    // No leftover derivatives from the truncated file.
    expect(tree(join(root, '.gallery', 'derivatives', 'thumb-512'))).toHaveLength(2)
  })

  it('never overwrites: colliding names get numbered', async () => {
    const { ingest, p, root } = setup()
    const a1 = await writeFile(join(src, 'one', 'a.jpg'), await jpeg())
    const a2 = await writeFile(join(src, 'two', 'a.jpg'), await jpeg())
    const a3 = await writeFile(join(src, 'three', 'a.jpg'), await jpeg())
    // A file already sitting where the first copy would go (not in the index).
    const squatter = await writeFile(join(root, 'originals', 'a.jpg'), 'someone else')
    ingest.add({ ...p, paths: [a1, a2, a3] })
    await waitFor(ingest, p)
    expect(tree(join(root, 'originals'))).toEqual(['a (2).jpg', 'a (3).jpg', 'a (4).jpg', 'a.jpg'])
    expect(await fs.readFile(squatter, 'utf8')).toBe('someone else')
    const photos = ingest.photos({ ...p, offset: 0, limit: 10 })
    const copies = await Promise.all(photos.map((x) => fs.readFile(join(root, x.originalPath))))
    const sources = await Promise.all([a1, a2, a3].map((f) => fs.readFile(f)))
    for (const s of sources) expect(copies.some((c) => c.equals(s))).toBe(true)
  })

  it('skips exact duplicates, in one batch and when a folder is dropped again', async () => {
    const { ingest, events, p, root } = setup()
    const dir = join(src, 'Roll')
    const same = await jpeg({ seed: 777 })
    await writeFile(join(dir, 'x.jpg'), same)
    await writeFile(join(dir, 'copies', 'x copy.jpg'), same)
    await writeFile(join(dir, 'y.jpg'), await jpeg())
    ingest.add({ ...p, paths: [dir] })
    const first = await waitFor(ingest, p)
    expect(first.progress).toMatchObject({ total: 3, imported: 2, duplicates: 1, photos: 2 })
    expect(first.issues).toHaveLength(1)
    expect(first.issues[0]).toMatchObject({ kind: 'duplicate', retryable: false })
    expect(first.issues[0]!.reason).toBe(REASONS.duplicate('x.jpg'))
    expect(tree(join(root, 'originals'))).toEqual(['Roll/x.jpg', 'Roll/y.jpg'])

    events.length = 0
    ingest.add({ ...p, paths: [dir] })
    const again = await waitFor(ingest, p)
    expect(again.progress).toMatchObject({ total: 3, imported: 0, duplicates: 3, photos: 2 })
    expect(tree(join(root, 'originals'))).toEqual(['Roll/x.jpg', 'Roll/y.jpg'])
    expect(events.filter((e) => e.type === 'import.issue')).toHaveLength(3)
    expect(events.filter((e) => e.type === 'import.photos')).toHaveLength(0)
  })

  it('resumes after a crash mid-import with no duplicates', async () => {
    const root = join(tmp, 'Project')
    const dir = join(src, 'Crash')
    for (let i = 0; i < 8; i++) await writeFile(join(dir, `f${i}.jpg`), await jpeg())
    const hang = () => new Promise<void>(() => undefined)
    let n = 0
    // First run: jobs stall at different stages, as if the app quit right there.
    const stages = ['hashed', 'thumbed', 'copied', 'display'] as const
    const one = setup(
      {
        jobsInFlight: 8,
        beforeStage: (stage, job) => {
          if (stage === stages[job.id % stages.length]) {
            n++
            return hang()
          }
        }
      },
      root
    )
    one.ingest.add({ ...one.p, paths: [dir] })
    await until(() => n === 8)
    one.ingest.dispose()
    const db = new DatabaseSync(join(root, '.gallery', 'index.sqlite'), { readOnly: true })
    const states = db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all()
    db.close()
    expect(states).toEqual([{ state: 'working', n: 8 }])

    const two = setup({}, root)
    const res = two.ingest.resumeAll({ projects: [{ projectId: one.p.projectId, root }] })
    expect(res.resumed).toEqual([one.p.projectId])
    const p = { projectId: one.p.projectId, root }
    const { progress } = await waitFor(two.ingest, p)
    expect(progress).toMatchObject({ imported: 8, duplicates: 0, failed: 0, photos: 8 })
    expect(tree(join(root, 'originals'))).toEqual(Array.from({ length: 8 }, (_, i) => `Crash/f${i}.jpg`))
    expect(tree(join(root, '.gallery', 'derivatives', 'thumb-512'))).toHaveLength(8)
    expect(tree(join(root, '.gallery', 'derivatives', 'display-2048'))).toHaveLength(8)
  })

  it('resumes a drop whose discovery was interrupted', async () => {
    const root = join(tmp, 'Project')
    const dir = join(src, 'Interrupted')
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `sub${i}`, `f${i}.jpg`), await jpeg())
    const one = setup({ beforeStage: () => new Promise<void>(() => undefined) }, root)
    one.ingest.add({ ...one.p, paths: [dir] })
    one.ingest.dispose() // quits before the walk gets far

    const two = setup({}, root)
    two.ingest.resumeAll({ projects: [{ projectId: one.p.projectId, root }] })
    const p = { projectId: one.p.projectId, root }
    const { progress } = await waitFor(two.ingest, p)
    expect(progress).toMatchObject({ imported: 5, photos: 5 })
    expect(tree(join(root, 'originals'))).toHaveLength(5)
  })

  it('does not create a database for projects that never imported', () => {
    const { ingest, p, root } = setup()
    expect(ingest.resumeAll({ projects: [p] }).resumed).toEqual([])
    expect(ingest.status(p).progress.state).toBe('idle')
    expect(ingest.photos({ ...p, offset: 0, limit: 10 })).toEqual([])
    expect(existsSync(join(root, '.gallery'))).toBe(false)
  })

  it('pauses (in-flight jobs finish), resumes and cancels', async () => {
    const gate: (() => void)[] = []
    const { ingest, p } = setup({
      jobsInFlight: 2,
      beforeStage: (stage) => (stage === 'new' ? new Promise<void>((r) => gate.push(r)) : undefined)
    })
    const dir = join(src, 'Ten')
    for (let i = 0; i < 10; i++) await writeFile(join(dir, `f${i}.jpg`), await jpeg())
    ingest.add({ ...p, paths: [dir] })
    await until(() => gate.length === 2 && ingest.status(p).progress.total === 10)
    expect(ingest.pause(p).state).toBe('paused')
    gate.splice(0).forEach((r) => r())
    await until(() => ingest.status(p).progress.done === 2)
    await new Promise((r) => setTimeout(r, 100))
    expect(ingest.status(p).progress).toMatchObject({ state: 'paused', done: 2, total: 10 })
    expect(gate).toHaveLength(0)

    // Resume, let two more start, then cancel: those finish, the rest are dropped.
    expect(ingest.resume(p).state).toBe('importing')
    await until(() => gate.length === 2)
    const cancelled = ingest.cancel(p)
    expect(cancelled.total).toBe(4)
    gate.splice(0).forEach((r) => r())
    const { progress } = await waitFor(ingest, p)
    expect(progress).toMatchObject({ total: 4, done: 4, imported: 4, photos: 4 })
  })

  it('retries failed files', async () => {
    const { ingest, p } = setup()
    const later = join(src, 'later.jpg')
    await writeFile(join(src, 'now.jpg'), await jpeg())
    ingest.add({ ...p, paths: [join(src, 'now.jpg'), later] })
    const first = await waitFor(ingest, p)
    expect(first.issues).toEqual([expect.objectContaining({ source: later, kind: 'unreadable', retryable: true })])
    await writeFile(later, await jpeg())
    ingest.retry({ ...p, issueIds: [first.issues[0]!.id] })
    const second = await waitFor(ingest, p)
    expect(second.issues).toEqual([])
    expect(second.progress).toMatchObject({ imported: 1, photos: 2 })
  })

  it('stops cleanly when the disk is almost full, and Retry continues', async () => {
    let free = 512 * 1024 ** 2
    const { ingest, events, p, root } = setup({ jobsInFlight: 1, freeBytes: async () => free })
    const dir = join(src, 'Full')
    for (let i = 0; i < 4; i++) await writeFile(join(dir, `f${i}.jpg`), await jpeg())
    ingest.add({ ...p, paths: [dir] })
    const stopped = await waitFor(ingest, p, 'paused')
    expect(stopped.issues).toEqual([
      expect.objectContaining({ kind: 'disk-full', reason: REASONS.diskFull, retryable: true })
    ])
    expect(events.filter((e) => e.type === 'import.issue')).toHaveLength(1)
    expect(tree(join(root, 'originals'))).toEqual([])

    free = 50 * 1024 ** 3
    expect(ingest.retry(p).state).not.toBe('paused')
    const { progress, issues } = await waitFor(ingest, p)
    expect(issues).toEqual([])
    expect(progress).toMatchObject({ imported: 4, photos: 4 })
  })

  it('throttles progress events and always sends the final state', async () => {
    const { ingest, events, p } = setup({ progressIntervalMs: 200 })
    const dir = join(src, 'Many')
    for (let i = 0; i < 40; i++) await writeFile(join(dir, `f${i}.png`), await png({ width: 16, height: 16 }))
    const start = Date.now()
    ingest.add({ ...p, paths: [dir] })
    await waitFor(ingest, p)
    await new Promise((r) => setTimeout(r, 250))
    const progress = events.filter((e) => e.type === 'import.progress')
    const elapsed = Date.now() - start
    // At most one per interval, plus the few sent at state changes.
    expect(progress.length).toBeLessThanOrEqual(Math.ceil(elapsed / 200) + 6)
    expect(progress.length).toBeLessThan(40)
    const last = progress.at(-1)!
    expect(last.type === 'import.progress' && last.progress).toMatchObject({ state: 'done', done: 40, total: 40 })
    const mid = progress.find((e) => e.type === 'import.progress' && e.progress.state === 'importing')
    if (mid && mid.type === 'import.progress') expect(mid.progress.filesPerSecond).toBeGreaterThanOrEqual(0)
  })

  it('makes the first thumbnail quickly', async () => {
    const { ingest, events, p } = setup()
    const dir = join(src, 'Quick')
    for (let i = 0; i < 12; i++) await writeFile(join(dir, `f${i}.jpg`), await jpeg({ width: 1600, height: 1200 }))
    const start = Date.now()
    ingest.add({ ...p, paths: [dir] })
    await until(() => events.some((e) => e.type === 'import.photos'))
    expect(Date.now() - start).toBeLessThan(2000)
    await waitFor(ingest, p)
  })

  it('works through the engine handlers with validated params', async () => {
    const events: EngineEvent[] = []
    const h = createIngest((e) => events.push(e), { idleCloseMs: 30, log: () => undefined })
    const p = { projectId: randomUUID(), root: join(tmp, 'Handlers') }
    await writeFile(join(src, 'h.jpg'), await jpeg())
    expect(() => h.add!({ projectId: 'nope', root: p.root, paths: [] })).toThrow()
    const out = h.add!({ ...p, paths: [join(src, 'h.jpg')] }) as ImportProgress
    expect(out.projectId).toBe(p.projectId)
    await until(() => (h.status!(p) as { progress: ImportProgress }).progress.state === 'done')
    expect((h.photos!({ ...p, offset: 0, limit: 10 }) as PhotoSummary[]).length).toBe(1)
    // Let the idle timer close the database before the temp folder goes.
    await new Promise((r) => setTimeout(r, 80))
    expect(statSync(join(p.root, '.gallery', 'index.sqlite')).size).toBeGreaterThan(0)
  })
})
