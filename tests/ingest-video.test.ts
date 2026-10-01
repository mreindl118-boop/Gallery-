import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, promises as fs, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImportProgress, PhotoSummary, type ImportState } from '@shared/ingest'
import type { EngineEvent } from '@shared/rpc'
import { Ingest, type IngestOptions } from '../src/engine/ingest'
import { ebmlDocType, identify, unsupportedReason } from '../src/engine/ingest/identify'
import { REASONS } from '../src/engine/ingest/queue'
import { creationTime, parseProbe, posterTime, tools, unpackedPath } from '../src/engine/ingest/video'
import { jpeg, png, writeFile } from './fixtures/images'
import { video } from './fixtures/videos'

let tmp: string
let src: string
const instances: Ingest[] = []

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gl-video-'))
  src = join(tmp, 'source')
})
afterEach(() => {
  for (const i of instances.splice(0)) i.dispose()
  rmSync(tmp, { recursive: true, force: true })
})

function setup(opts: IngestOptions = {}) {
  const events: EngineEvent[] = []
  const root = join(tmp, 'Project')
  const ingest = new Ingest((e) => events.push(e), { idleCloseMs: 30, log: () => undefined, ...opts })
  instances.push(ingest)
  return { ingest, events, p: { projectId: randomUUID(), root }, root }
}

async function waitFor(ingest: Ingest, p: { projectId: string; root: string }, state: ImportState = 'done') {
  const start = Date.now()
  for (;;) {
    const s = ingest.status(p)
    if (s.progress.state === state) return s
    if (Date.now() - start > 60_000) throw new Error(`Timed out waiting for ${state}`)
    await new Promise((r) => setTimeout(r, 20))
  }
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

describe('video identification', () => {
  it('tells every supported container by its bytes', async () => {
    expect(identify(await video({ container: 'mp4' }), 'a.mp4')).toEqual({ kind: 'video', format: 'mp4' })
    expect(identify(await video({ container: 'mov' }), 'a.mov')).toEqual({ kind: 'video', format: 'mov' })
    expect(identify(await video({ container: 'mkv' }), 'a.mkv')).toEqual({ kind: 'video', format: 'mkv' })
    expect(identify(await video({ container: 'webm' }), 'a.webm')).toEqual({ kind: 'video', format: 'webm' })
    expect(identify(await video({ container: 'avi' }), 'a.avi')).toEqual({ kind: 'video', format: 'avi' })
    // The extension never decides.
    expect(identify(await video({ container: 'webm' }), 'renamed.mp4')).toEqual({ kind: 'video', format: 'webm' })
    expect(identify(Buffer.from('not a video at all, just text'), 'notes.mp4')).toEqual({
      kind: 'unsupported',
      what: null
    })
    expect(unsupportedReason(null)).toMatch(/or MP4, MOV, MKV, WebM or AVI videos instead\.$/)
  })

  it('reads the EBML DocType and known ftyp brands', async () => {
    expect(ebmlDocType(await video({ container: 'mkv' }))).toBe('matroska')
    expect(ebmlDocType(await video({ container: 'webm' }))).toBe('webm')
    expect(ebmlDocType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBeNull()
    expect(ebmlDocType(Buffer.from('RIFF'))).toBeNull()
    const ftyp = (major: string) => {
      const b = Buffer.alloc(32)
      b.writeUInt32BE(16, 0)
      b.write('ftyp', 4, 'latin1')
      b.write(major, 8, 'latin1')
      return b
    }
    expect(identify(ftyp('M4V '), 'a.m4v')).toEqual({ kind: 'video', format: 'mp4' })
    expect(identify(ftyp('qt  '), 'a.mov')).toEqual({ kind: 'video', format: 'mov' })
    expect(identify(ftyp('3gp4'), 'a.3gp')).toEqual({ kind: 'unsupported', what: 'video' })
    expect(identify(ftyp('heic'), 'a.heic')).toEqual({ kind: 'image', format: 'heic' })
  })
})

describe('video helpers', () => {
  it('points packaged binaries at app.asar.unpacked', () => {
    expect(
      unpackedPath('C:\\Program Files\\galleryLAB\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe')
    ).toBe('C:\\Program Files\\galleryLAB\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe')
    expect(unpackedPath('/opt/app/resources/app.asar/node_modules/ffprobe-static/bin/linux/x64/ffprobe')).toBe(
      '/opt/app/resources/app.asar.unpacked/node_modules/ffprobe-static/bin/linux/x64/ffprobe'
    )
    expect(unpackedPath('/dev/gallery/node_modules/ffmpeg-static/ffmpeg')).toBe(
      '/dev/gallery/node_modules/ffmpeg-static/ffmpeg'
    )
    const t = tools()
    expect(existsSync(t.ffmpeg)).toBe(true)
    expect(existsSync(t.ffprobe)).toBe(true)
  })

  it('normalises creation times and picks the poster time', () => {
    expect(creationTime('2024-05-01T10:20:30.000000Z')).toBe('2024-05-01T10:20:30Z')
    expect(creationTime('2024-05-01 10:20:30')).toBe('2024-05-01T10:20:30')
    expect(creationTime('2024-05-01T10:20:30+0900')).toBe('2024-05-01T10:20:30+09:00')
    expect(creationTime('0000-00-00T00:00:00Z')).toBeNull()
    expect(creationTime(undefined)).toBeNull()
    expect(posterTime(null)).toBe(0)
    expect(posterTime(2000)).toBe(0.5)
    expect(posterTime(60_000)).toBe(6)
    expect(posterTime(3_600_000)).toBe(30)
    expect(posterTime(400)).toBeCloseTo(0.35)
  })

  it('parses ffprobe output, swapping sides for rotated phone footage', () => {
    const info = parseProbe({
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        {
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30000/1001',
          side_data_list: [{ rotation: -90 }],
          tags: { creation_time: '2024-05-01T10:20:30.000000Z' }
        }
      ],
      format: { duration: '134.5' }
    })
    expect(info).toEqual({
      width: 1080,
      height: 1920,
      durationMs: 134_500,
      fps: 29.97,
      codec: 'hevc',
      takenAt: '2024-05-01T10:20:30Z'
    })
    expect(() => parseProbe({ streams: [{ codec_type: 'audio' }] })).toThrow()
  })
})

describe('video import', () => {
  it('imports videos next to photos with a poster frame, its length and capture time', async () => {
    const { ingest, events, p, root } = setup()
    const dir = join(src, 'Clips')
    await writeFile(join(dir, 'wide.mp4'), await video({ width: 1280, height: 720, seconds: 2 }))
    await writeFile(
      join(dir, 'phone.mov'),
      await video({ container: 'mov', width: 240, height: 320, seconds: 3, creationTime: '2024-05-01T10:20:30Z' })
    )
    await writeFile(join(dir, 'clip.webm'), await video({ container: 'webm' }))
    await writeFile(join(dir, 'clip.mkv'), await video({ container: 'mkv' }))
    await writeFile(join(dir, 'old.avi'), await video({ container: 'avi' }))
    await writeFile(join(dir, 'still.jpg'), await jpeg({ width: 800, height: 600 }))
    await writeFile(join(dir, 'still.png'), await png())

    ingest.add({ ...p, paths: [dir] })
    const { progress, issues } = await waitFor(ingest, p)
    expect(issues).toEqual([])
    expect(ImportProgress.parse(progress)).toMatchObject({
      total: 7,
      imported: 7,
      importedVideos: 5,
      photos: 7,
      videos: 5,
      failed: 0
    })

    const photos = ingest.photos({ ...p, offset: 0, limit: 100 })
    const byName = Object.fromEntries(photos.map((x) => [x.name, PhotoSummary.parse(x)]))
    expect(byName['still.jpg']).toMatchObject({ kind: 'photo', format: 'jpeg', durationMs: null })
    for (const name of ['wide.mp4', 'phone.mov', 'clip.webm', 'clip.mkv', 'old.avi']) {
      const v = byName[name]!
      expect(v.kind).toBe('video')
      expect(v.originalPath).toBe(`originals/Clips/${name}`)
      expect(v.lqip).toMatch(/^data:image\/webp;base64,/)
      expect(existsSync(join(root, v.thumb!))).toBe(true)
      expect(existsSync(join(root, v.display!))).toBe(true)
      expect(v.durationMs).toBeGreaterThan(1800)
      expect(v.durationMs).toBeLessThan(3300)
    }
    expect(byName['wide.mp4']).toMatchObject({ format: 'mp4', width: 1280, height: 720 })
    expect(byName['wide.mp4']!.durationMs).toBeGreaterThanOrEqual(1900)
    expect(byName['wide.mp4']!.durationMs).toBeLessThanOrEqual(2100)
    expect(await dims(join(root, byName['wide.mp4']!.thumb!))).toEqual([512, 288, 'webp'])
    expect(await dims(join(root, byName['wide.mp4']!.display!))).toEqual([1280, 720, 'webp'])
    expect(byName['phone.mov']).toMatchObject({
      format: 'mov',
      width: 240,
      height: 320,
      takenAt: '2024-05-01T10:20:30Z'
    })
    expect(byName['phone.mov']!.durationMs).toBeGreaterThanOrEqual(2900)
    expect(byName['phone.mov']!.durationMs).toBeLessThanOrEqual(3100)
    expect(await dims(join(root, byName['phone.mov']!.thumb!))).toEqual([240, 320, 'webp'])
    expect(byName['clip.webm']!.format).toBe('webm')
    expect(byName['clip.mkv']!.format).toBe('mkv')
    expect(byName['old.avi']!.format).toBe('avi')
    expect(byName['wide.mp4']!.takenAt).toBeNull()

    // The copy is byte-identical and the row carries the stream facts.
    expect(await fs.readFile(join(root, byName['wide.mp4']!.originalPath))).toEqual(
      await fs.readFile(join(dir, 'wide.mp4'))
    )
    expect(row(root, byName['wide.mp4']!.id)).toMatchObject({
      kind: 'video',
      codec: 'h264',
      fps: 10,
      duration_ms: 2000
    })
    expect(row(root, byName['still.jpg']!.id)).toMatchObject({ kind: 'photo', codec: null, duration_ms: null })

    // The poster is a real frame (not blank): the test pattern has many colours.
    const stats = await sharp(join(root, byName['wide.mp4']!.thumb!)).stats()
    expect(stats.channels.some((c) => c.stdev > 20)).toBe(true)

    // Events carry the kind and the length, thumbnail first, then display.
    const photoEvents = events.flatMap((e) => (e.type === 'import.photos' ? e.photos : []))
    const mine = photoEvents.filter((x) => x.id === byName['wide.mp4']!.id)
    expect(mine[0]).toMatchObject({ kind: 'video', durationMs: 2000, thumb: byName['wide.mp4']!.thumb })
    expect(mine.at(-1)).toMatchObject({ display: byName['wide.mp4']!.display })
  })

  it('reports a damaged video, a duplicate one, and never confuses them with photos', async () => {
    const { ingest, events, p, root } = setup({ jobsInFlight: 1 })
    const dir = join(src, 'Mixed')
    const clip = await video({ seed: 4242 })
    await writeFile(join(dir, 'ok.mp4'), clip)
    await writeFile(join(dir, 'again', 'ok copy.mp4'), clip)
    await writeFile(join(dir, 'cut.mp4'), clip.subarray(0, Math.floor(clip.length / 2)))
    await writeFile(join(dir, 'notes.mp4'), 'Shot list for Saturday')
    await writeFile(join(dir, 'photo.jpg'), await jpeg())
    ingest.add({ ...p, paths: [dir] })
    const { progress, issues } = await waitFor(ingest, p)
    expect(progress).toMatchObject({ total: 5, done: 5, imported: 2, importedVideos: 1, duplicates: 1, failed: 2 })
    expect(progress).toMatchObject({ photos: 2, videos: 1 })
    const byFile = Object.fromEntries(issues.map((i) => [i.source.split(/[\\/]/).pop(), i]))
    expect(byFile['cut.mp4']).toMatchObject({ kind: 'corrupt', reason: REASONS.corruptVideo, retryable: false })
    expect(byFile['notes.mp4']).toMatchObject({ kind: 'unsupported', retryable: false })
    expect(byFile['ok copy.mp4']).toMatchObject({ kind: 'duplicate', reason: REASONS.duplicate('ok.mp4', 'video') })
    expect(byFile['ok copy.mp4']!.reason).toBe('This video is already in the project as ok.mp4, so it was skipped.')
    expect(events.filter((e) => e.type === 'import.issue')).toHaveLength(3)
    expect(existsSync(join(root, 'originals', 'Mixed', 'ok.mp4'))).toBe(true)
    expect(existsSync(join(root, 'originals', 'Mixed', 'again'))).toBe(false)
    expect(existsSync(join(root, 'originals', 'Mixed', 'cut.mp4'))).toBe(false)
    // No derivatives are left behind for the damaged file.
    const thumbs = await fs.readdir(join(root, '.gallery', 'derivatives', 'thumb-512'))
    expect(thumbs).toHaveLength(2)
    expect(
      ingest
        .photos({ ...p, offset: 0, limit: 10 })
        .map((x) => x.kind)
        .sort()
    ).toEqual(['photo', 'video'])
  })

  it('reads old rows without a kind as photos', async () => {
    const { ingest, p } = setup()
    await writeFile(join(src, 'a.jpg'), await jpeg())
    ingest.add({ ...p, paths: [join(src, 'a.jpg')] })
    await waitFor(ingest, p)
    const [photo] = ingest.photos({ ...p, offset: 0, limit: 1 })
    expect(photo).toMatchObject({ kind: 'photo', durationMs: null })
    expect(PhotoSummary.parse({ ...photo, kind: undefined, durationMs: undefined })).toMatchObject({
      kind: 'photo',
      durationMs: null
    })
  })
})
