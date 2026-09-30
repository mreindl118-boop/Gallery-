import { parse } from 'exifr'

/**
 * Photo metadata from EXIF, XMP and IPTC via exifr, normalised to plain
 * values. Missing or unreadable metadata is never an error: the photo just
 * has fewer facts.
 */

export interface PhotoMeta {
  takenAt: string | null
  camera: string | null
  lens: string | null
  focalLength: number | null
  aperture: number | null
  shutter: number | null
  iso: number | null
  gpsLat: number | null
  gpsLon: number | null
  orientation: number | null
  rating: number | null
  title: string | null
  caption: string | null
  keywords: string[]
}

export const EMPTY_META: PhotoMeta = {
  takenAt: null,
  camera: null,
  lens: null,
  focalLength: null,
  aperture: null,
  shutter: null,
  iso: null,
  gpsLat: null,
  gpsLon: null,
  orientation: null,
  rating: null,
  title: null,
  caption: null,
  keywords: []
}

const OPTIONS = {
  tiff: true,
  exif: true,
  gps: true,
  xmp: true,
  iptc: true,
  icc: false,
  jfif: false,
  ihdr: false,
  interop: false,
  ifd1: false,
  makerNote: false,
  userComment: false,
  translateValues: false,
  reviveValues: false,
  mergeOutput: true
}

export async function readMetadata(file: string): Promise<PhotoMeta> {
  try {
    const raw = (await parse(file, OPTIONS)) as Record<string, unknown> | undefined
    return raw ? normalizeMetadata(raw) : { ...EMPTY_META }
  } catch {
    return { ...EMPTY_META }
  }
}

/** Pure: exifr's merged output → PhotoMeta. */
export function normalizeMetadata(t: Record<string, unknown>): PhotoMeta {
  const make = text(t.Make)
  const model = text(t.Model)
  let camera: string | null = null
  if (make && model)
    camera = model.toLowerCase().startsWith(make.split(' ')[0]!.toLowerCase()) ? model : `${make} ${model}`
  else camera = model ?? make

  const offset = text(t.OffsetTimeOriginal) ?? text(t.OffsetTime)
  const takenAt =
    exifDate(t.DateTimeOriginal, offset) ??
    exifDate(t.CreateDate, offset) ??
    exifDate(t.DateTimeDigitized, offset) ??
    isoDate(t.DateCreated) ??
    isoDate(t.DateTimeCreated) ??
    iptcDate(t.DateCreated, t.TimeCreated)

  let aperture = num(t.FNumber)
  const apex = num(t.ApertureValue)
  if (aperture === null && apex !== null) aperture = round(Math.pow(2, apex / 2), 1)

  let shutter = num(t.ExposureTime)
  const sv = num(t.ShutterSpeedValue)
  if (shutter === null && sv !== null) shutter = Math.pow(2, -sv)

  const iso = int(t.ISO) ?? int(t.ISOSpeedRatings) ?? int(t.PhotographicSensitivity) ?? int(t.RecommendedExposureIndex)

  const lat = num(t.latitude)
  const lon = num(t.longitude)
  const gpsOk = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)

  const orientation = int(t.Orientation)
  const rating = int(t.Rating)

  const keywords = new Set<string>()
  for (const k of [...list(t.subject), ...list(t.Keywords)]) keywords.add(k)

  return {
    takenAt,
    camera,
    lens: text(t.LensModel) ?? text(t.Lens),
    focalLength: num(t.FocalLength),
    aperture,
    shutter,
    iso,
    gpsLat: gpsOk ? lat : null,
    gpsLon: gpsOk ? lon : null,
    orientation: orientation !== null && orientation >= 1 && orientation <= 8 ? orientation : null,
    rating: rating !== null && rating >= -1 && rating <= 5 ? rating : null,
    title: text(t.title) ?? text(t.ObjectName) ?? text(t.Headline),
    caption: text(t.description) ?? text(t.Caption) ?? text(t['Caption-Abstract']) ?? text(t.ImageDescription),
    keywords: [...keywords]
  }
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    // eslint-disable-next-line no-control-regex
    const s = v.replace(/\u0000/g, '').trim()
    return s === '' ? null : s
  }
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return text(v[0])
  if (v instanceof Uint8Array) return null
  if (typeof v === 'object' && 'value' in v) return text((v as { value: unknown }).value)
  return null
}

function list(v: unknown): string[] {
  if (v === null || v === undefined) return []
  if (Array.isArray(v)) return v.flatMap((x) => (text(x) ? [text(x)!] : []))
  const s = text(v)
  return s ? [s] : []
}

function num(v: unknown): number | null {
  const x = Array.isArray(v) ? v[0] : v
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return null
}

function int(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n)
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits

const EXIF_DATE = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?/

/** "2024:05:01 10:20:30" → "2024-05-01T10:20:30" (+ offset when known). Camera clocks have no zone otherwise. */
export function exifDate(v: unknown, offset?: string | null): string | null {
  if (typeof v !== 'string') return null
  const m = EXIF_DATE.exec(v.trim())
  if (!m || m[1] === '0000') return null
  const [, y, mo, d, h, mi, s] = m
  const off = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : ''
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${off}`
}

function isoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(s)) return null
  return s
}

function iptcDate(date: unknown, time: unknown): string | null {
  if (typeof date !== 'string' || !/^\d{8}$/.test(date)) return null
  const d = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
  if (typeof time === 'string' && /^\d{6}/.test(time))
    return `${d}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`
  return d
}
