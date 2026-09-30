import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import sharp from 'sharp'

/**
 * Test images generated on the fly (nothing binary is committed). Every call
 * gets a distinct colour from `seed`, so two fixtures never hash the same
 * unless a test means them to.
 */

let counter = 0
const colour = (seed?: number) => {
  const n = seed ?? ++counter
  return { r: (n * 53) % 256, g: (n * 101) % 256, b: (n * 197) % 256 }
}

export interface ImageOptions {
  width?: number
  height?: number
  seed?: number
}

const base = ({ width = 64, height = 48, seed }: ImageOptions = {}) =>
  sharp({ create: { width, height, channels: 3, background: colour(seed) } })

export const jpeg = (o?: ImageOptions) => base(o).jpeg({ quality: 80 }).toBuffer()
export const png = (o?: ImageOptions) => base(o).png().toBuffer()
export const webp = (o?: ImageOptions) => base(o).webp().toBuffer()
export const avif = (o?: ImageOptions) => base(o).avif({ effort: 0 }).toBuffer()
export const tiff = (o?: ImageOptions) => base(o).tiff().toBuffer()

/** A JPEG whose pixels are stored sideways with EXIF orientation 6 (display rotates 90° clockwise). */
export const rotatedJpeg = (o: ImageOptions) => base(o).jpeg().withMetadata({ orientation: 6 }).toBuffer()

/** A noisy JPEG (so truncation leaves real scan data missing). */
export const noisyJpeg = (width = 320, height = 240) =>
  sharp({ create: { width, height, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .jpeg()
    .toBuffer()

export const jpegWithExif = (o?: ImageOptions) =>
  base(o)
    .jpeg()
    .withExif({
      IFD0: { Make: 'Canon', Model: 'Canon EOS R5' },
      IFD2: {
        DateTimeOriginal: '2024:05:01 10:20:30',
        OffsetTimeOriginal: '+09:00',
        LensModel: 'RF24-70mm F2.8 L IS USM',
        FNumber: '28/10',
        ExposureTime: '1/250',
        ISOSpeedRatings: '400',
        FocalLength: '50/1'
      },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '35/1 30/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '139/1 45/1 0/1'
      }
    })
    .withXmp(
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
        '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmp:Rating="4">' +
        '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Harbour at dawn</rdf:li></rdf:Alt></dc:title>' +
        '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Fishing boats before sunrise</rdf:li></rdf:Alt></dc:description>' +
        '<dc:subject><rdf:Bag><rdf:li>sea</rdf:li><rdf:li>boats</rdf:li></rdf:Bag></dc:subject>' +
        '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
    )
    .toBuffer()

/**
 * A baseline uncompressed 16-bit RGB TIFF, written by hand (sharp's TIFF
 * writer stores 8 bits per sample).
 */
export function tiff16(width: number, height: number, seed = 1): Buffer {
  const pixelBytes = width * height * 3 * 2
  const entries = 10
  const ifdOffset = 8
  const ifdSize = 2 + entries * 12 + 4
  const bpsOffset = ifdOffset + ifdSize
  const dataOffset = bpsOffset + 6
  const buf = Buffer.alloc(dataOffset + pixelBytes)
  buf.write('II', 0, 'latin1')
  buf.writeUInt16LE(42, 2)
  buf.writeUInt32LE(ifdOffset, 4)
  buf.writeUInt16LE(entries, ifdOffset)
  const tags: [number, number, number, number][] = [
    [256, 4, 1, width], // ImageWidth (LONG)
    [257, 4, 1, height], // ImageLength
    [258, 3, 3, bpsOffset], // BitsPerSample → offset of [16,16,16]
    [259, 3, 1, 1], // Compression: none
    [262, 3, 1, 2], // Photometric: RGB
    [273, 4, 1, dataOffset], // StripOffsets
    [277, 3, 1, 3], // SamplesPerPixel
    [278, 4, 1, height], // RowsPerStrip
    [279, 4, 1, pixelBytes], // StripByteCounts
    [284, 3, 1, 1] // PlanarConfiguration: chunky
  ]
  tags.forEach(([tag, type, count, value], i) => {
    const at = ifdOffset + 2 + i * 12
    buf.writeUInt16LE(tag, at)
    buf.writeUInt16LE(type, at + 2)
    buf.writeUInt32LE(count, at + 4)
    if (type === 3 && count === 1) buf.writeUInt16LE(value, at + 8)
    else buf.writeUInt32LE(value, at + 8)
  })
  buf.writeUInt32LE(0, ifdOffset + 2 + entries * 12)
  for (let i = 0; i < 3; i++) buf.writeUInt16LE(16, bpsOffset + i * 2)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = dataOffset + (y * width + x) * 6
      buf.writeUInt16LE(((x * 65535) / Math.max(1, width - 1)) | 0, at)
      buf.writeUInt16LE(((y * 65535) / Math.max(1, height - 1)) | 0, at + 2)
      buf.writeUInt16LE((seed * 4099) % 65536, at + 4)
    }
  return buf
}

/** First bytes of formats we can't (or needn't) generate for real: enough for identification. */
export const heads = {
  heic: () => ftyp('heic', ['mif1', 'heic']),
  heifMif1: () => ftyp('mif1', ['mif1', 'miaf']),
  avifBrand: () => ftyp('avif', ['mif1', 'avif', 'miaf']),
  cr3: () => ftyp('crx ', ['crx ', 'isom']),
  mp4: () => ftyp('isom', ['isom', 'iso2', 'mp41']),
  cr2: () => {
    const b = Buffer.alloc(64)
    b.write('II*\0', 0, 'latin1')
    b.writeUInt32LE(16, 4)
    b.write('CR', 8, 'latin1')
    return b
  },
  raf: () => Buffer.concat([Buffer.from('FUJIFILMCCD-RAW 0201FF383501'), Buffer.alloc(64)]),
  orf: () => Buffer.concat([Buffer.from('IIRO'), Buffer.alloc(64)]),
  rw2: () => Buffer.concat([Buffer.from([0x49, 0x49, 0x55, 0x00]), Buffer.alloc(64)]),
  /** A TIFF whose IFD0 carries DNGVersion. */
  dng: () => {
    const b = Buffer.alloc(64)
    b.write('II', 0, 'latin1')
    b.writeUInt16LE(42, 2)
    b.writeUInt32LE(8, 4)
    b.writeUInt16LE(1, 8)
    b.writeUInt16LE(0xc612, 10)
    b.writeUInt16LE(1, 12)
    b.writeUInt32LE(4, 14)
    return b
  },
  gif: () => Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1')
}

function ftyp(major: string, compatible: string[]): Buffer {
  const size = 16 + compatible.length * 4
  const b = Buffer.alloc(size + 32)
  b.writeUInt32BE(size, 0)
  b.write('ftyp', 4, 'latin1')
  b.write(major, 8, 'latin1')
  compatible.forEach((c, i) => b.write(c, 16 + i * 4, 'latin1'))
  return b
}

export async function writeFile(path: string, data: Buffer | string): Promise<string> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, data)
  return path
}
