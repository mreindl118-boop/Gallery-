import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'

/**
 * Test videos made on the fly with the bundled ffmpeg (nothing binary is
 * committed). Each file is a short test pattern; `seed` changes the size or
 * length a little so two fixtures never hash the same unless meant to.
 */

export interface VideoOptions {
  /** Container: decides the encoder and the header bytes. */
  container?: 'mp4' | 'mov' | 'mkv' | 'webm' | 'avi'
  width?: number
  height?: number
  /** Length in seconds. */
  seconds?: number
  fps?: number
  /** Written into the container as creation_time (ISO, UTC). */
  creationTime?: string
  /** Mixed into the picture so the bytes differ from every other fixture. */
  seed?: number
}

let counter = 0
const cache = new Map<string, Promise<Buffer>>()

function ffmpeg(args: string[]): Promise<void> {
  const bin = ffmpegPath
  if (!bin) throw new Error('ffmpeg-static has no binary for this platform')
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['-v', 'error', '-nostdin', '-y', ...args],
      { timeout: 60_000, encoding: 'utf8' },
      (err, _out, stderr) =>
        err ? reject(new Error(`ffmpeg failed: ${stderr || err.message}`)) : resolve()
    )
  })
}

/** The bytes of a small video. Identical options give the same bytes (cached), so duplicates are easy to make. */
export function video(o: VideoOptions = {}): Promise<Buffer> {
  const opts = {
    container: o.container ?? 'mp4',
    width: o.width ?? 320,
    height: o.height ?? 240,
    seconds: o.seconds ?? 2,
    fps: o.fps ?? 10,
    creationTime: o.creationTime ?? null,
    seed: o.seed ?? ++counter
  }
  const key = JSON.stringify(opts)
  let p = cache.get(key)
  if (!p) {
    p = make(opts)
    cache.set(key, p)
  }
  return p
}

async function make(o: Required<Omit<VideoOptions, 'creationTime'>> & { creationTime: string | null }) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'gl-video-'))
  const out = join(dir, `v.${o.container}`)
  const source = `testsrc=duration=${o.seconds}:size=${o.width}x${o.height}:rate=${o.fps}`
  // A one-pixel-high band whose position depends on the seed makes every fixture distinct.
  const band = `drawbox=x=0:y=${(o.seed * 7) % Math.max(1, o.height - 2)}:w=iw:h=2:color=0x${((o.seed * 2654435) & 0xffffff).toString(16).padStart(6, '0')}:t=fill`
  const args = ['-f', 'lavfi', '-i', source, '-vf', band, '-an']
  if (o.container === 'webm') args.push('-c:v', 'libvpx', '-b:v', '200k')
  else if (o.container === 'avi') args.push('-c:v', 'mpeg4', '-q:v', '5')
  else args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p')
  if (o.creationTime) args.push('-metadata', `creation_time=${o.creationTime}`)
  args.push('-f', o.container === 'mkv' ? 'matroska' : o.container, out)
  try {
    await ffmpeg(args)
    return await fs.readFile(out)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
