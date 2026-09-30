import { extname } from 'node:path'
import type { PhotoFormat } from '@shared/ingest'

/**
 * Identifying files by their first bytes. The extension never decides what a
 * file is (a PNG named .jpg imports fine); it only helps tell TIFF-based RAW
 * formats apart from plain TIFFs.
 */

export const HEAD_BYTES = 64 * 1024

export type Identified =
  | { kind: 'image'; format: Exclude<PhotoFormat, 'raw'> }
  | { kind: 'raw'; type: string }
  | { kind: 'empty' }
  | { kind: 'unsupported'; what: string | null }

const RAW_EXTENSIONS = new Set([
  '.cr2',
  '.cr3',
  '.crw',
  '.nef',
  '.nrw',
  '.arw',
  '.srf',
  '.sr2',
  '.raf',
  '.orf',
  '.rw2',
  '.dng',
  '.pef',
  '.srw',
  '.3fr',
  '.erf',
  '.kdc',
  '.mef',
  '.mos',
  '.mrw',
  '.iiq',
  '.rwl',
  '.x3f'
])

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'heif'])
const AVIF_BRANDS = new Set(['avif', 'avis'])
const VIDEO_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'qt  ', 'm4v ', '3gp4', '3gp5', '3g2a', 'avc1', 'dash'])

const ascii = (b: Uint8Array, start: number, len: number): string =>
  start + len <= b.length ? String.fromCharCode(...b.subarray(start, start + len)) : ''

const startsWith = (b: Uint8Array, bytes: number[], at = 0): boolean =>
  b.length >= at + bytes.length && bytes.every((v, i) => b[at + i] === v)

/** Major and compatible brands of an ISO-BMFF `ftyp` box, or null. */
export function ftypBrands(b: Uint8Array): string[] | null {
  if (ascii(b, 4, 4) !== 'ftyp') return null
  const size = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
  const end = Math.min(size >= 16 ? size : 16, b.length)
  const brands = [ascii(b, 8, 4)]
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(b, i, 4))
  return brands.filter((x) => x !== '')
}

/** Does IFD0 of this TIFF carry a DNGVersion tag (0xC612)? */
function hasDngVersion(b: Uint8Array): boolean {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const le = b[0] === 0x49
  if (b.length < 8) return false
  const ifd = view.getUint32(4, le)
  if (ifd + 2 > b.length) return false
  const count = view.getUint16(ifd, le)
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12
    if (at + 2 > b.length) return false
    if (view.getUint16(at, le) === 0xc612) return true
  }
  return false
}

export function identify(head: Uint8Array, name: string): Identified {
  if (head.length === 0) return { kind: 'empty' }
  const ext = extname(name).toLowerCase()

  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'image', format: 'jpeg' }
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', format: 'png' }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return { kind: 'image', format: 'webp' }

  const brands = ftypBrands(head)
  if (brands) {
    if (brands.includes('crx ')) return { kind: 'raw', type: 'CR3' }
    if (brands.some((x) => AVIF_BRANDS.has(x))) return { kind: 'image', format: 'avif' }
    if (brands.some((x) => HEIF_BRANDS.has(x))) return { kind: 'image', format: 'heic' }
    if (brands.some((x) => VIDEO_BRANDS.has(x))) return { kind: 'unsupported', what: 'video' }
    return { kind: 'unsupported', what: null }
  }

  if (ascii(head, 0, 15) === 'FUJIFILMCCD-RAW') return { kind: 'raw', type: 'RAF' }
  const magic4 = ascii(head, 0, 4)
  if (magic4 === 'IIRO' || magic4 === 'IIRS' || magic4 === 'MMOR') return { kind: 'raw', type: 'ORF' }
  if (startsWith(head, [0x49, 0x49, 0x55, 0x00])) return { kind: 'raw', type: 'RW2' }

  const tiff = startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])
  const bigTiff = startsWith(head, [0x49, 0x49, 0x2b, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2b])
  if (tiff || bigTiff) {
    if (ascii(head, 8, 2) === 'CR') return { kind: 'raw', type: 'CR2' }
    if (RAW_EXTENSIONS.has(ext)) return { kind: 'raw', type: ext.slice(1).toUpperCase() }
    if (tiff && hasDngVersion(head)) return { kind: 'raw', type: 'DNG' }
    return { kind: 'image', format: 'tiff' }
  }

  if (ascii(head, 0, 4) === 'GIF8') return { kind: 'unsupported', what: 'GIF' }
  if (ascii(head, 0, 2) === 'BM') return { kind: 'unsupported', what: 'BMP' }
  if (ascii(head, 0, 4) === '8BPS') return { kind: 'unsupported', what: 'Photoshop' }
  if (ascii(head, 0, 5) === '%PDF-') return { kind: 'unsupported', what: 'PDF' }
  if (startsWith(head, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20]))
    return { kind: 'unsupported', what: 'JPEG 2000' }
  if (startsWith(head, [0xff, 0x0a]) || ascii(head, 4, 8) === 'JXL \r\n\x87\n')
    return { kind: 'unsupported', what: 'JPEG XL' }
  return { kind: 'unsupported', what: null }
}

export const RAW_REASON = "RAW files aren't supported yet. Export them as JPEG or TIFF and add them again."
export const EMPTY_REASON = "This file is empty, so there's no photo in it."

const ADD_INSTEAD = 'Add JPEG, PNG, WebP, AVIF, TIFF or HEIC photos instead.'

export function unsupportedReason(what: string | null): string {
  if (what === 'video') return `This is a video, and galleryLAB imports photos only. ${ADD_INSTEAD}`
  if (what) return `${what} files can't be imported. ${ADD_INSTEAD}`
  return `galleryLAB can't open this kind of file. ${ADD_INSTEAD}`
}
