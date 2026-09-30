import { mkdtempSync, promises as fs, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IngestDb, SCHEMA_VERSION } from '../src/engine/ingest/db'
import { identify, RAW_REASON, unsupportedReason } from '../src/engine/ingest/identify'
import { exifDate, normalizeMetadata } from '../src/engine/ingest/metadata'
import {
  droppedFolderName,
  isInside,
  isSkippedDir,
  isSkippedFile,
  numberedName,
  targetCandidates
} from '../src/engine/ingest/paths'
import { WeightedPool } from '../src/engine/ingest/pool'
import { walk } from '../src/engine/ingest/walk'
import { avif, heads, jpeg, png, tiff, tiff16, webp, writeFile } from './fixtures/images'

describe('identify', () => {
  it('recognises every supported format by its bytes', async () => {
    expect(identify(await jpeg(), 'a.jpg')).toEqual({ kind: 'image', format: 'jpeg' })
    expect(identify(await png(), 'a.png')).toEqual({ kind: 'image', format: 'png' })
    expect(identify(await webp(), 'a.webp')).toEqual({ kind: 'image', format: 'webp' })
    expect(identify(await avif(), 'a.avif')).toEqual({ kind: 'image', format: 'avif' })
    expect(identify(await tiff(), 'a.tif')).toEqual({ kind: 'image', format: 'tiff' })
    expect(identify(tiff16(4, 4), 'a.tif')).toEqual({ kind: 'image', format: 'tiff' })
    expect(identify(heads.heic(), 'a.heic')).toEqual({ kind: 'image', format: 'heic' })
    expect(identify(heads.heifMif1(), 'a.heif')).toEqual({ kind: 'image', format: 'heic' })
    expect(identify(heads.avifBrand(), 'a.avif')).toEqual({ kind: 'image', format: 'avif' })
  })

  it('lets bytes decide, not the extension', async () => {
    expect(identify(await png(), 'holiday.jpg')).toEqual({ kind: 'image', format: 'png' })
    expect(identify(await jpeg(), 'noext')).toEqual({ kind: 'image', format: 'jpeg' })
  })

  it('recognises RAW formats', async () => {
    expect(identify(heads.cr2(), 'x.cr2')).toMatchObject({ kind: 'raw', type: 'CR2' })
    expect(identify(heads.cr3(), 'x.cr3')).toMatchObject({ kind: 'raw', type: 'CR3' })
    expect(identify(heads.raf(), 'x.raf')).toMatchObject({ kind: 'raw', type: 'RAF' })
    expect(identify(heads.orf(), 'x.orf')).toMatchObject({ kind: 'raw', type: 'ORF' })
    expect(identify(heads.rw2(), 'x.rw2')).toMatchObject({ kind: 'raw', type: 'RW2' })
    expect(identify(heads.dng(), 'x.tif')).toMatchObject({ kind: 'raw', type: 'DNG' })
    expect(identify(await tiff(), 'x.nef')).toMatchObject({ kind: 'raw', type: 'NEF' })
    expect(identify(await tiff(), 'x.ARW')).toMatchObject({ kind: 'raw', type: 'ARW' })
    expect(RAW_REASON).toBe("RAW files aren't supported yet. Export them as JPEG or TIFF and add them again.")
  })

  it('reports empty and unknown files', () => {
    expect(identify(new Uint8Array(0), 'a.jpg')).toEqual({ kind: 'empty' })
    expect(identify(Buffer.from('hello, this is text'), 'notes.jpg')).toEqual({ kind: 'unsupported', what: null })
    expect(identify(heads.gif(), 'a.gif')).toEqual({ kind: 'unsupported', what: 'GIF' })
    expect(identify(heads.mp4(), 'a.mp4')).toEqual({ kind: 'unsupported', what: 'video' })
    expect(identify(Buffer.from([0xff, 0xd8]), 'a.jpg')).toEqual({ kind: 'unsupported', what: null })
    expect(unsupportedReason(null)).toMatch(/^galleryLAB can't open this kind of file\. /)
    expect(unsupportedReason('GIF')).toMatch(/^GIF files can't be imported\./)
  })
})

describe('paths', () => {
  it('skips hidden and system entries', () => {
    for (const n of ['.git', '.Trash', '$RECYCLE.BIN', 'System Volume Information', '__MACOSX', '@eaDir'])
      expect(isSkippedDir(n)).toBe(true)
    expect(isSkippedDir('Kyoto')).toBe(false)
    for (const n of ['Thumbs.db', 'desktop.ini', '._IMG_1.jpg', '.DS_Store', 'IMG_1.xmp', 'IMG_1.AAE'])
      expect(isSkippedFile(n)).toBe(true)
    expect(isSkippedFile('IMG_1.jpg')).toBe(false)
  })

  it('numbers colliding names before the extension', () => {
    expect(numberedName('IMG_1.jpg', 1)).toBe('IMG_1.jpg')
    expect(numberedName('IMG_1.jpg', 2)).toBe('IMG_1 (2).jpg')
    expect(numberedName('archive.tar.gz', 3)).toBe('archive.tar (3).gz')
    expect(numberedName('README', 2)).toBe('README (2)')
    const it = targetCandidates('originals/Kyoto', 'a.jpg')
    expect([it.next().value, it.next().value, it.next().value]).toEqual([
      'originals/Kyoto/a.jpg',
      'originals/Kyoto/a (2).jpg',
      'originals/Kyoto/a (3).jpg'
    ])
  })

  it('names dropped folders, including drive roots', () => {
    expect(droppedFolderName('/home/me/Kyoto/')).toBe('Kyoto')
    expect(droppedFolderName('D:\\')).toBe('Drive D')
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
  })
})

describe('WeightedPool', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5))

  it('limits slots and weight, and runs heavy tasks alone', async () => {
    const pool = new WeightedPool(3, 300)
    let active = 0
    let maxActive = 0
    let maxWeight = 0
    const task = (w: number) =>
      pool.run(w, 0, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        maxWeight = Math.max(maxWeight, pool.inFlightWeight)
        await tick()
        active--
      })
    await Promise.all([task(10), task(10), task(10), task(10), task(200), task(200), task(1000), task(10)])
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(maxWeight).toBeLessThanOrEqual(300)
  })

  it('serves lower priority numbers first', async () => {
    const pool = new WeightedPool(1, 100)
    const order: string[] = []
    const blocker = pool.run(1, 0, tick)
    const a = pool.run(1, 1, async () => void order.push('display'))
    const b = pool.run(1, 0, async () => void order.push('thumb'))
    await Promise.all([blocker, a, b])
    expect(order).toEqual(['thumb', 'display'])
  })
})

describe('metadata', () => {
  it('normalises EXIF dates', () => {
    expect(exifDate('2024:05:01 10:20:30')).toBe('2024-05-01T10:20:30')
    expect(exifDate('2024:05:01 10:20:30', '+09:00')).toBe('2024-05-01T10:20:30+09:00')
    expect(exifDate('0000:00:00 00:00:00')).toBeNull()
    expect(exifDate(undefined)).toBeNull()
  })

  it('normalises exifr output', () => {
    const m = normalizeMetadata({
      Make: 'NIKON CORPORATION',
      Model: 'NIKON Z 6',
      ApertureValue: 4,
      ShutterSpeedValue: 8,
      ISO: [800],
      latitude: 0,
      longitude: 0,
      Orientation: 9,
      title: { lang: 'x-default', value: ' Title ' },
      Keywords: ['a', 'b'],
      subject: 'a'
    })
    expect(m.camera).toBe('NIKON Z 6')
    expect(m.aperture).toBe(4)
    expect(m.shutter).toBeCloseTo(1 / 256)
    expect(m.iso).toBe(800)
    expect(m.gpsLat).toBeNull()
    expect(m.orientation).toBeNull()
    expect(m.title).toBe('Title')
    expect(m.keywords).toEqual(['a', 'b'])
    expect(normalizeMetadata({ Make: 'FUJIFILM', Model: 'X-T5' }).camera).toBe('FUJIFILM X-T5')
  })
})

describe('walk', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gl-walk-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const collect = async (paths: string[], exclude?: string[]) => {
    const out: { source: string; relDir: string }[] = []
    for await (const e of walk(paths, { exclude })) out.push(e)
    return out
  }

  it('walks folders depth first, keeps structure, skips hidden, system files and symlinks', async () => {
    const top = join(dir, 'Trip')
    await writeFile(join(top, 'b.jpg'), 'x')
    await writeFile(join(top, 'a10.jpg'), 'x')
    await writeFile(join(top, 'a2.jpg'), 'x')
    await writeFile(join(top, 'Thumbs.db'), 'x')
    await writeFile(join(top, '._a2.jpg'), 'x')
    await writeFile(join(top, '.git', 'config.jpg'), 'x')
    await writeFile(join(top, 'Day 1', 'c.jpg'), 'x')
    await writeFile(join(dir, 'outside', 'secret.jpg'), 'x')
    symlinkSync(join(dir, 'outside'), join(top, 'link'), 'dir')
    symlinkSync(join(dir, 'outside', 'secret.jpg'), join(top, 'linked.jpg'))
    const loose = await writeFile(join(dir, 'loose.png'), 'x')

    const found = await collect([top, loose])
    expect(found.map((f) => [f.source.slice(dir.length + 1).replace(/\\/g, '/'), f.relDir])).toEqual([
      ['Trip/a2.jpg', 'Trip'],
      ['Trip/a10.jpg', 'Trip'],
      ['Trip/b.jpg', 'Trip'],
      ['Trip/Day 1/c.jpg', 'Trip/Day 1'],
      ['loose.png', '']
    ])
  })

  it('handles deep, long and Unicode paths', async () => {
    const segments = [
      'Ōsaka 大阪',
      'Été à Paris',
      'Ünïcödé 😀',
      ...Array.from({ length: 12 }, (_, i) => `level-${i}-${'x'.repeat(12)}`)
    ]
    const deep = join(dir, ...segments)
    await writeFile(join(deep, 'фото.jpg'), 'x')
    const found = await collect([join(dir, segments[0]!)])
    expect(found).toHaveLength(1)
    expect(found[0]!.relDir).toBe(segments.join('/'))
    expect(found[0]!.source.endsWith('фото.jpg')).toBe(true)
  })

  it('streams: the first file comes out before the walk finishes', async () => {
    for (let d = 0; d < 20; d++) await writeFile(join(dir, 'Big', `d${d}`, 'x.jpg'), 'x')
    const gen = walk([join(dir, 'Big')])
    const first = await gen.next()
    expect(first.done).toBe(false)
    await gen.return(undefined)
  })

  it('never enters excluded folders and passes missing paths through', async () => {
    await writeFile(join(dir, 'P', 'originals', 'a.jpg'), 'x')
    await writeFile(join(dir, 'P', 'b.jpg'), 'x')
    const found = await collect([join(dir, 'P'), join(dir, 'missing.jpg')], [join(dir, 'P', 'originals')])
    expect(found.map((f) => f.relDir)).toEqual(['P', ''])
    await fs.rm(join(dir, 'P'), { recursive: true })
  })
})

describe('IngestDb', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gl-db-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates a versioned WAL database only when asked, and refuses newer schemas', () => {
    expect(IngestDb.open(dir, { create: false })).toBeNull()
    const db = IngestDb.open(dir, { create: true })!
    db.close()
    const raw = new DatabaseSync(join(dir, '.gallery', 'index.sqlite'))
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()
    expect(() => IngestDb.open(dir, { create: false })).toThrow(/newer version of galleryLAB/)
  })

  it('puts interrupted jobs back in the queue on open and ignores re-discovered files', () => {
    const db = IngestDb.open(dir, { create: true })!
    const batch = db.newBatch()
    const drop = db.addDrop(batch, ['/x'])
    expect(
      db.insertJobs(drop, batch, [
        { source: '/x/a.jpg', relDir: 'x' },
        { source: '/x/b.jpg', relDir: 'x' }
      ])
    ).toBe(2)
    expect(db.insertJobs(drop, batch, [{ source: '/x/a.jpg', relDir: 'x' }])).toBe(0)
    expect(db.claim(5).map((j) => j.state)).toEqual(['working', 'working'])
    db.close()
    const again = IngestDb.open(dir, { create: false })!
    expect(again.counts(batch)).toMatchObject({ total: 2, remaining: 2, done: 0 })
    expect(again.queued()).toBe(2)
    again.close()
  })
})
