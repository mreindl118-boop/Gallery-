import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import sharp, { type Sharp } from 'sharp'
import { DERIVATIVES, derivativePath, type PhotoFormat } from '@shared/ingest'
import { writeFileAtomic } from './fsutil'
import { nativePath } from './paths'

/**
 * Derivatives with sharp: auto-oriented, converted to sRGB, metadata
 * stripped. The 32 px LQIP lives in the database as a data: URL; the
 * 512 px thumbnail and 2048 px display size are WebP files named after the
 * content hash under .gallery/derivatives/.
 */

/** Panoramas and big scans work; anything past this is refused as too large. */
export const LIMIT_INPUT_PIXELS = 1_000_000_000

// Batch work: many different files once each, so a big cache only costs memory.
sharp.cache({ memory: 48, files: 0, items: 16 })

/** A file sharp or the HEIC decoder could not read: damaged, truncated or not really an image. */
export class DecodeError extends Error {
  override name = 'DecodeError'
}

export interface Probe {
  /** Size as shown, after EXIF orientation. */
  width: number
  height: number
}

const HEIC_FALLBACK_MP = 48

const open = (file: string): Sharp =>
  sharp(nativePath(file), { sequentialRead: true, limitInputPixels: LIMIT_INPUT_PIXELS, failOn: 'truncated' })

/** Header-only read: displayed dimensions, for the megapixel budget and the photo row. */
export async function probe(file: string, format: PhotoFormat): Promise<Probe | null> {
  try {
    const m = await open(file).metadata()
    const w = m.autoOrient?.width ?? m.width
    const h = m.autoOrient?.height ?? m.height
    if (!w || !h) throw new DecodeError('No dimensions')
    return { width: w, height: h }
  } catch (err) {
    if (format === 'heic') return null // libvips may lack the HEVC decoder; heic-decode handles it
    throw asDecodeError(err)
  }
}

/** Megapixels to reserve while decoding this image. */
export const megapixels = (p: Probe | null): number => (p ? (p.width * p.height) / 1e6 : HEIC_FALLBACK_MP)

let heicDecode:
  ((input: { buffer: Uint8Array }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>) | null = null

/** A sharp pipeline over the decoded image, already auto-oriented. */
async function pipeline(
  file: string,
  format: PhotoFormat
): Promise<{ img: Sharp; width: number; height: number } | null> {
  if (format === 'heic') {
    heicDecode ??= (await import('heic-decode')).default
    const buffer = await fs.readFile(file)
    let decoded
    try {
      decoded = await heicDecode({ buffer })
    } catch (err) {
      throw asDecodeError(err)
    }
    const { width, height, data } = decoded
    // libheif applies the HEIF rotation/mirror boxes itself; EXIF orientation in HEIC is informative only.
    const img = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 },
      limitInputPixels: LIMIT_INPUT_PIXELS
    })
    return { img, width, height }
  }
  return null
}

const fit = (size: number) => ({ width: size, height: size, fit: 'inside' as const, withoutEnlargement: true })

export interface ThumbResult {
  width: number
  height: number
  lqip: string
}

/** Makes the 512 px thumbnail and the LQIP. The thumbnail file is written before this resolves. */
export async function makeThumb(
  root: string,
  id: string,
  file: string,
  format: PhotoFormat,
  known: Probe | null
): Promise<ThumbResult> {
  const out = join(root, derivativePath('thumb', id))
  await fs.mkdir(dirname(out), { recursive: true })
  let width = known?.width ?? 0
  let height = known?.height ?? 0
  let data: Buffer
  try {
    const heic = await pipeline(file, format)
    const img = heic ? heic.img : open(file).rotate()
    if (heic) ({ width, height } = heic)
    data = await img
      .resize(fit(DERIVATIVES.thumb.size))
      .toColourspace('srgb')
      .webp({ quality: 80, effort: 3 })
      .toBuffer()
  } catch (err) {
    throw asDecodeError(err)
  }
  if (!width || !height) {
    const m = await sharp(data).metadata()
    width = m.width
    height = m.height
  }
  await writeFileAtomic(out, data)
  const lqip = await sharp(data).resize(fit(DERIVATIVES.lqip)).webp({ quality: 40, effort: 2 }).toBuffer()
  return { width, height, lqip: `data:image/webp;base64,${lqip.toString('base64')}` }
}

/** Makes the 2048 px display size from the project's copy. */
export async function makeDisplay(root: string, id: string, file: string, format: PhotoFormat): Promise<void> {
  const out = join(root, derivativePath('display', id))
  await fs.mkdir(dirname(out), { recursive: true })
  let data: Buffer
  try {
    const heic = await pipeline(file, format)
    const img = heic ? heic.img : open(file).rotate()
    data = await img
      .resize(fit(DERIVATIVES.display.size))
      .toColourspace('srgb')
      .webp({ quality: 82, effort: 4, smartSubsample: true })
      .toBuffer()
  } catch (err) {
    throw asDecodeError(err)
  }
  await writeFileAtomic(out, data)
}

export async function derivativeExists(root: string, kind: 'thumb' | 'display', id: string): Promise<boolean> {
  return fs
    .stat(join(root, derivativePath(kind, id)))
    .then((s) => s.size > 0)
    .catch(() => false)
}

export async function removeDerivatives(root: string, id: string): Promise<void> {
  await Promise.all(
    (['thumb', 'display'] as const).map((k) =>
      fs.rm(join(root, derivativePath(k, id)), { force: true }).catch(() => undefined)
    )
  )
}

function asDecodeError(err: unknown): Error {
  if (err instanceof DecodeError) return err
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code && /^E[A-Z]+$/.test(code)) return err as Error // filesystem trouble, not a damaged image
  return new DecodeError(err instanceof Error ? err.message : String(err))
}
