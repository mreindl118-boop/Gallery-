import { promises as fs } from 'node:fs'
import { extname } from 'node:path'
import { sidecar } from 'exifr'
import { copyFileAtomic } from './fsutil'

// Sidecars carry metadata, not pixels. Do not load arbitrarily large editor files.
const MAX_XMP_BYTES = 8 * 1024 * 1024

function xmlText(value: unknown): unknown {
  if (typeof value === 'string') {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    return value.replace(/&(amp|lt|gt|quot|apos|#x[\da-f]+|#\d+);/gi, (entity, code: string) => {
      if (named[code]) return named[code]!
      if (!code.startsWith('#')) return entity
      const point = code.startsWith('#x') || code.startsWith('#X') ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity
    })
  }
  if (Array.isArray(value)) return value.map(xmlText)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, xmlText(entry)]))
  }
  return value
}

async function findXmp(image: string): Promise<{ path: string; bytes: number } | null> {
  const ext = extname(image)
  const stem = ext ? image.slice(0, -ext.length) : image
  const candidates = [...new Set([`${image}.xmp`, `${image}.XMP`, `${stem}.xmp`, `${stem}.XMP`])]
  for (const path of candidates) {
    try {
      const st = await fs.lstat(path)
      if (st.isFile() && st.size > 0 && st.size <= MAX_XMP_BYTES) return { path, bytes: st.size }
    } catch {
      // Missing or inaccessible optional metadata does not stop the photo import.
    }
  }
  return null
}

/** Keep the sidecar beside the copied image so metadata survives a restart or
 * a later index rebuild. The full image name avoids JPEG/RAW stem collisions. */
export async function copyXmp(sourceImage: string, copiedImage: string): Promise<void> {
  const target = `${copiedImage}.xmp`
  try {
    await fs.lstat(target)
    return // Already copied by this job before an interrupted import.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const found = await findXmp(sourceImage)
  if (found) await copyFileAtomic(found.path, `${target}.part`, target, found.bytes)
}

export async function readXmp(image: string): Promise<Record<string, unknown> | null> {
  const found = await findXmp(image)
  if (!found) return null
  try {
    const raw = await sidecar(found.path, { reviveValues: false, translateValues: false }, 'xmp')
    if (!raw || typeof raw !== 'object') return null
    // exifr's standalone XMP parser groups tags by namespace. These are the
    // metadata namespaces supported by the existing photo normalizer.
    const grouped = raw as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const ns of ['tiff', 'exif', 'aux', 'photoshop', 'Iptc4xmpCore', 'xmp', 'dc']) {
      const tags = grouped[ns]
      if (tags && typeof tags === 'object' && !Array.isArray(tags)) Object.assign(out, xmlText(tags))
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}
