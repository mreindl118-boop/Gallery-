import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PhotoReading } from '@shared/build'
import {
  contrastRatio,
  hueFamily,
  labToLch,
  lchToRgb,
  oklchString,
  parseOklch,
  rgbToLab
} from '../src/engine/build/color'
import { readThumb, season, shapeClass, timeOfDay } from '../src/engine/build/reading'
import { summarize } from '../src/engine/build/summary'
import { grayRamp, horizonImage, mostlyFlat, noise, solid, stripes, symmetric } from './fixtures/readings'
import { writeFile } from './fixtures/images'

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gl-reading-'))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const input = (id: string, over: Partial<Parameters<typeof readThumb>[1]> = {}) => ({
  photoId: id,
  width: 3000,
  height: 2000,
  takenAt: null,
  gpsLat: null,
  ...over
})

async function read(name: string, bytes: Buffer, over?: Partial<Parameters<typeof readThumb>[1]>) {
  const file = await writeFile(join(tmp, `${name}.png`), bytes)
  return readThumb(file, input(name, over))
}

describe('colour math', () => {
  it('round-trips sRGB through OKLab', () => {
    for (const rgb of [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [128, 128, 128],
      [255, 255, 255],
      [0, 0, 0],
      [200, 150, 30]
    ] as const) {
      const lch = labToLch(rgbToLab(rgb[0], rgb[1], rgb[2]))
      const back = lchToRgb(lch)
      back.forEach((v, i) => expect(Math.abs(v - rgb[i]!)).toBeLessThanOrEqual(1))
    }
  })
  it('white is L≈1 with no chroma, red is high chroma', () => {
    const white = labToLch(rgbToLab(255, 255, 255))
    expect(white[0]).toBeCloseTo(1, 2)
    expect(white[1]).toBeLessThan(0.001)
    const red = labToLch(rgbToLab(255, 0, 0))
    expect(red[1]).toBeGreaterThan(0.2)
    expect(hueFamily(red[2])).toBe('red')
  })
  it('contrast ratio matches WCAG for black on white', () => {
    expect(contrastRatio([0, 0, 0], [1, 0, 0])).toBeCloseTo(21, 0)
  })
  it('oklch strings parse back', () => {
    expect(parseOklch(oklchString([0.95, 0.0123, 85.57]))).toEqual([0.95, 0.0123, 85.6])
  })
})

describe('reading a photo', () => {
  it('a pure red image reads as high chroma, red family', async () => {
    const r = await read('red', await solid(255, 0, 0))
    expect(PhotoReading.parse(r)).toBeTruthy()
    expect(r.meanChroma).toBeGreaterThan(0.2)
    expect(r.hueFamily).toBe('red')
    expect(r.monochrome).toBe(false)
    expect(r.warmth).toBeGreaterThan(0)
    expect(r.palette[0]!.weight).toBeCloseTo(1, 1)
    expect(r.palette.length).toBeLessThanOrEqual(6)
  })

  it('a gray ramp is monochrome, mid key, high contrast, no lifted blacks', async () => {
    const r = await read('ramp', await grayRamp())
    expect(r.monochrome).toBe(true)
    expect(r.hueFamily).toBe('neutral')
    expect(r.key).toBe('mid')
    expect(r.contrast).toBeGreaterThan(0.7)
    expect(r.liftedBlacks).toBe(false)
    expect(Math.abs(r.warmth)).toBeLessThan(0.1)
  })

  it('a dark image is low key with clipped shadows; a bright one is high key', async () => {
    const dark = await read('dark', await solid(2, 2, 2))
    expect(dark.key).toBe('low')
    expect(dark.clipping.shadows).toBeGreaterThan(0.9)
    const bright = await read('bright', await solid(252, 252, 252))
    expect(bright.key).toBe('high')
    expect(bright.clipping.highlights).toBeGreaterThan(0.9)
  })

  it('lifted blacks: a flat dark gray that never reaches black', async () => {
    const r = await read('lifted', await stripes(256, 192, true).then(() => lifted()))
    expect(r.liftedBlacks).toBe(true)
  })

  it('horizontal stripes have dominant horizontal energy, vertical ones vertical', async () => {
    const h = await read('hstripes', await stripes(256, 192, true))
    expect(h.orientationEnergy.horizontal).toBeGreaterThan(0.8)
    expect(h.horizon).toBe(true)
    const v = await read('vstripes', await stripes(256, 192, false))
    expect(v.orientationEnergy.vertical).toBeGreaterThan(0.8)
    expect(v.horizon).toBe(false)
  })

  it('a mirrored image is highly symmetric; noise is not', async () => {
    const s = await read('sym', await symmetric())
    expect(s.symmetry).toBeGreaterThan(0.95)
    const n = await read('noise', await noise())
    expect(n.symmetry).toBeLessThan(0.3)
    expect(n.sharpness).toBeGreaterThan(s.sharpness * 0.5)
    expect(n.edgeDensity).toBeGreaterThan(0.3)
  })

  it('a mostly flat image has high negative space and low edge density', async () => {
    const r = await read('flat', await mostlyFlat())
    expect(r.negativeSpace).toBeGreaterThan(0.9)
    expect(r.edgeDensity).toBeLessThan(0.05)
    const n = await read('noise2', await noise())
    expect(n.negativeSpace).toBe(0)
  })

  it('finds a horizon in a sky-over-ground frame', async () => {
    const r = await read('horizon', await horizonImage())
    expect(r.horizon).toBe(true)
    expect(r.orientationEnergy.horizontal).toBeGreaterThan(0.9)
  })

  it('classes shape by aspect ratio and reads time and season from takenAt', () => {
    expect(shapeClass(3000, 1000)).toBe('panorama')
    expect(shapeClass(1000, 3000)).toBe('vertical-panorama')
    expect(shapeClass(1000, 1000)).toBe('square')
    expect(shapeClass(3000, 2000)).toBe('landscape')
    expect(shapeClass(2000, 3000)).toBe('portrait')
    expect(timeOfDay('2024-05-01T06:20:30+09:00')).toBe('dawn')
    expect(timeOfDay('2024-05-01T12:00:00Z')).toBe('day')
    expect(timeOfDay('2024-05-01T18:00:00')).toBe('golden')
    expect(timeOfDay('2024-05-01T20:00:00')).toBe('blue-hour')
    expect(timeOfDay('2024-05-01T23:30:00')).toBe('night')
    expect(timeOfDay(null)).toBeNull()
    expect(season('2024-05-01T10:00:00', null)).toBe('spring')
    expect(season('2024-05-01T10:00:00', -33)).toBe('autumn')
    expect(season('2024-12-25T10:00:00', 51)).toBe('winter')
    expect(season(null, null)).toBeNull()
  })

  it('reads the same photo the same way twice', async () => {
    const a = await read('again', await noise(256, 192, 9))
    const b = await read('again', await noise(256, 192, 9))
    expect(a).toEqual(b)
  })
})

describe('collection summary', () => {
  it('aggregates readings into distributions and a variety score', async () => {
    const readings = await Promise.all([
      read('s-red', await solid(255, 0, 0)),
      read('s-blue', await solid(0, 0, 255), { takenAt: '2024-01-01T23:00:00' }),
      read('s-gray', await grayRamp(), { width: 1000, height: 1000 }),
      read('s-dark', await solid(2, 2, 2), { width: 1000, height: 3000 })
    ])
    const s = summarize(readings)
    expect(s.photos).toBe(4)
    expect(s.key.low).toBeCloseTo(0.25, 2)
    expect(s.shapes.square).toBeCloseTo(0.25, 2)
    expect(s.shapes['vertical-panorama']).toBeCloseTo(0.25, 2)
    expect(s.timeOfDay.night).toBeCloseTo(0.25, 2)
    expect(s.timeOfDay.unknown).toBeCloseTo(0.75, 2)
    expect(s.palette.length).toBeGreaterThan(1)
    expect(s.variety).toBeGreaterThan(0.4)
    const one = summarize([readings[0]!])
    expect(one.variety).toBeLessThan(0.3)
    expect(summarize([]).photos).toBe(0)
  })
})

/** Dark gray image with a faint checker so it has contrast but never reaches black. */
function lifted(): Promise<Buffer> {
  const width = 256
  const height = 192
  const buf = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 ? 70 : 140
      buf.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3)
    }
  return solidRaw(buf, width, height)
}

async function solidRaw(buf: Buffer, width: number, height: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  return sharp(buf, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
}
