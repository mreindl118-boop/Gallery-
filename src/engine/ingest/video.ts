import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { path as ffprobeStatic } from 'ffprobe-static'
import { DecodeError } from './derivatives'
import { nativePath } from './paths'

/**
 * Videos: facts from ffprobe and one poster frame from ffmpeg, both the
 * static binaries from ffmpeg-static / ffprobe-static. The poster is a PNG in
 * a temp folder that the normal sharp derivative pipeline turns into the LQIP,
 * thumbnail and display size, so a video looks like a photo everywhere else.
 */

export interface VideoInfo {
  /** Size as shown, after the container's rotation. */
  width: number
  height: number
  durationMs: number | null
  fps: number | null
  codec: string | null
  /** creation_time from the container (ISO), if any. */
  takenAt: string | null
}

/** Mirrors `megapixels` for photos: a poster decode costs about the frame's size. */
export const videoMegapixels = (v: VideoInfo): number => (v.width * v.height) / 1e6

const PROBE_TIMEOUT_MS = 60_000
const POSTER_TIMEOUT_MS = 120_000
/** The poster comes from 10% into the video: past any fade-in, but early so seeking stays cheap. */
const POSTER_AT = 0.1
const POSTER_MIN_S = 0.5
const POSTER_MAX_S = 30

/**
 * Packaged apps keep these binaries outside the asar archive (electron-builder
 * asarUnpack); the module's own path still points inside it.
 */
export function unpackedPath(p: string): string {
  return p.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
}

let binaries: { ffmpeg: string; ffprobe: string } | null = null

/** Where the ffmpeg and ffprobe binaries resolve to (`GALLERYLAB_FFMPEG` / `GALLERYLAB_FFPROBE` override them). */
export function tools(): { ffmpeg: string; ffprobe: string } {
  if (binaries) return binaries
  const ffmpeg = process.env['GALLERYLAB_FFMPEG'] || ffmpegStatic
  const ffprobe = process.env['GALLERYLAB_FFPROBE'] || ffprobeStatic
  if (!ffmpeg || !ffprobe) throw new Error('No ffmpeg build for this platform')
  binaries = { ffmpeg: unpackedPath(ffmpeg), ffprobe: unpackedPath(ffprobe) }
  return binaries
}

function run(bin: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code
          // A missing or unrunnable binary is our problem, not the file's; the file's trouble is a decode error.
          if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) reject(err)
          else reject(new DecodeError(stderr.trim().split('\n').pop() || err.message))
        } else resolve({ stdout, stderr })
      }
    )
  })
}

interface ProbeOutput {
  streams?: {
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    r_frame_rate?: string
    avg_frame_rate?: string
    duration?: string
    side_data_list?: { rotation?: number }[]
    tags?: Record<string, string>
  }[]
  format?: { duration?: string; tags?: Record<string, string> }
}

export async function probeVideo(file: string): Promise<VideoInfo> {
  const { ffprobe } = tools()
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', nativePath(file)],
    PROBE_TIMEOUT_MS
  )
  let out: ProbeOutput
  try {
    out = JSON.parse(stdout) as ProbeOutput
  } catch {
    throw new DecodeError('ffprobe gave no usable output')
  }
  return parseProbe(out)
}

/** Pure: ffprobe's JSON → VideoInfo. Throws DecodeError when there is no video stream with a size. */
export function parseProbe(out: ProbeOutput): VideoInfo {
  const video = (out.streams ?? []).find((s) => s.codec_type === 'video' && s.width && s.height)
  if (!video) throw new DecodeError('No video stream')
  let width = video.width!
  let height = video.height!
  const rotation = Math.abs(video.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? 0) % 180
  const tagRotation = Math.abs(Number(video.tags?.['rotate'] ?? 0)) % 180
  if (rotation === 90 || tagRotation === 90) [width, height] = [height, width]
  const seconds = positive(out.format?.duration) ?? positive(video.duration)
  const tags = { ...lowerKeys(out.format?.tags), ...lowerKeys(video.tags) }
  return {
    width,
    height,
    durationMs: seconds === null ? null : Math.round(seconds * 1000),
    fps: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
    codec: video.codec_name ?? null,
    takenAt: creationTime(tags['creation_time'] ?? tags['com.apple.quicktime.creationdate'])
  }
}

function lowerKeys(t: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(t ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
}

function positive(v: string | undefined): number | null {
  const n = Number(v)
  return v !== undefined && Number.isFinite(n) && n > 0 ? n : null
}

function frameRate(v: string | undefined): number | null {
  if (!v) return null
  const [num, den] = v.split('/').map(Number)
  if (!num || !Number.isFinite(num)) return null
  const fps = den ? num / den : num
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null
}

/** "2024-05-01T10:20:30.000000Z" → "2024-05-01T10:20:30Z"; a zone offset is kept, an absent one left out. */
export function creationTime(v: string | undefined): string | null {
  if (!v) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/.exec(v.trim())
  if (!m || m[1] === '0000') return null
  const zone = m[7] ? (m[7].length === 5 ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : m[7]) : ''
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`
}

/** Seconds into the video the poster frame is taken from. */
export function posterTime(durationMs: number | null): number {
  if (durationMs === null) return 0
  const t = (durationMs / 1000) * POSTER_AT
  return Math.min(POSTER_MAX_S, Math.max(POSTER_MIN_S, t), Math.max(0, durationMs / 1000 - 0.05))
}

/**
 * Writes one frame of the video as a PNG and returns its path. The caller
 * removes the folder when done (`fs.rm(dirname(path), { recursive: true })`).
 */
export async function extractPoster(file: string, info: VideoInfo): Promise<string> {
  const { ffmpeg } = tools()
  const dir = await fs.mkdtemp(join(tmpdir(), 'gallerylab-poster-'))
  const out = join(dir, 'poster.png')
  const at = posterTime(info.durationMs)
  const args = ['-y', '-v', 'error', '-nostdin', '-ss', at.toFixed(3), '-i', nativePath(file)]
  args.push('-frames:v', '1', '-an', '-sn', '-dn', '-f', 'image2', '-pix_fmt', 'rgb24', out)
  try {
    await run(ffmpeg, args, POSTER_TIMEOUT_MS)
    const st = await fs.stat(out).catch(() => null)
    if (!st || st.size === 0) {
      // Seeking past the last keyframe of a very short clip can give nothing: take the first frame instead.
      if (at > 0) {
        args.splice(args.indexOf('-ss'), 2)
        await run(ffmpeg, args, POSTER_TIMEOUT_MS)
      }
      const again = await fs.stat(out).catch(() => null)
      if (!again || again.size === 0) throw new DecodeError('No frame could be decoded')
    }
    return out
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}
