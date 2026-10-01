import sharp from 'sharp'
import type { PhotoReading } from '@shared/build'

/**
 * Synthetic images with known properties for the reading tests, and
 * hand-written readings for the theming tests (each set designed to land on
 * one archetype).
 */

export const solid = (r: number, g: number, b: number, width = 256, height = 192) =>
  sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer()

/** Left-to-right gray ramp. */
export function grayRamp(width = 256, height = 192): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = Math.round((x / (width - 1)) * 255)
      buf.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3)
    }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/** Horizontal stripes, 16 px tall, alternating dark and light. */
export function stripes(width = 256, height = 192, horizontal = true): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const band = Math.floor((horizontal ? y : x) / 16) % 2
      buf.fill(band ? 220 : 40, (y * width + x) * 3, (y * width + x) * 3 + 3)
    }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/** A mirror-symmetric image: random noise on the left, mirrored on the right. */
export function symmetric(width = 256, height = 192, seed = 1): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3)
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width / 2; x++) {
      const v = Math.round(rnd() * 255)
      const l = (y * width + x) * 3
      const r = (y * width + (width - 1 - x)) * 3
      buf.fill(v, l, l + 3)
      buf.fill(v, r, r + 3)
    }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/** Random noise everywhere (no symmetry, no negative space). */
export function noise(width = 256, height = 192, seed = 3): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3)
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < width * height; i++) buf.fill(Math.round(rnd() * 255), i * 3, i * 3 + 3)
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/** Mostly flat mid-gray with one small detailed square in a corner. */
export function mostlyFlat(width = 256, height = 192): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3, 150)
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) buf.fill((x + y) % 2 ? 20 : 240, (y * width + x) * 3, (y * width + x) * 3 + 3)
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

/** A sky-over-ground frame: light top half, dark bottom half (a horizon). */
export function horizonImage(width = 256, height = 192): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) buf.fill(y < height / 2 ? 200 : 60, y * width * 3, (y + 1) * width * 3)
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

// ----- readings for theming ---------------------------------------------------

const base: PhotoReading = {
  photoId: 'p',
  palette: [{ oklch: [0.6, 0.05, 80], weight: 1 }],
  hueFamily: 'orange',
  meanChroma: 0.05,
  maxChroma: 0.1,
  key: 'mid',
  contrast: 0.5,
  clipping: { shadows: 0, highlights: 0 },
  liftedBlacks: false,
  monochrome: false,
  warmth: 0,
  edgeDensity: 0.1,
  grain: 0.01,
  sharpness: 30,
  orientationEnergy: { horizontal: 0.34, vertical: 0.33, diagonal: 0.33 },
  symmetry: 0.5,
  negativeSpace: 0.2,
  horizon: false,
  shape: 'landscape',
  timeOfDay: 'day',
  season: 'summer'
}

export const reading = (id: string, over: Partial<PhotoReading>): PhotoReading => ({ ...base, ...over, photoId: id })

const many = (n: number, prefix: string, f: (i: number) => Partial<PhotoReading>) =>
  Array.from({ length: n }, (_, i) => reading(`${prefix}-${i}`, f(i)))

/** One fixture set per archetype. */
export const SETS: Record<string, PhotoReading[]> = {
  'white-cube': many(12, 'wc', (i) => ({
    key: 'high',
    meanChroma: 0.02,
    contrast: 0.7,
    sharpness: 80,
    warmth: 0.05,
    palette: [
      { oklch: [0.92, 0.01, 90], weight: 0.7 },
      { oklch: [0.3, 0.02, 250], weight: 0.3 }
    ],
    hueFamily: 'neutral',
    shape: i % 2 ? 'landscape' : 'portrait'
  })),
  concrete: many(12, 'cc', () => ({
    key: 'mid',
    meanChroma: 0.005,
    monochrome: true,
    hueFamily: 'neutral',
    warmth: -0.4,
    edgeDensity: 0.35,
    contrast: 0.75,
    sharpness: 90,
    palette: [
      { oklch: [0.5, 0.005, 250], weight: 0.6 },
      { oklch: [0.2, 0.005, 250], weight: 0.4 }
    ]
  })),
  timber: many(12, 'tb', () => ({
    key: 'mid',
    meanChroma: 0.06,
    warmth: 0.7,
    hueFamily: 'orange',
    horizon: true,
    timeOfDay: 'golden',
    contrast: 0.5,
    palette: [
      { oklch: [0.6, 0.08, 70], weight: 0.6 },
      { oklch: [0.35, 0.05, 60], weight: 0.4 }
    ]
  })),
  nocturne: many(12, 'nt', () => ({
    key: 'low',
    meanChroma: 0.03,
    contrast: 0.7,
    clipping: { shadows: 0.15, highlights: 0.01 },
    timeOfDay: 'night',
    warmth: -0.1,
    palette: [
      { oklch: [0.15, 0.02, 260], weight: 0.8 },
      { oklch: [0.7, 0.15, 60], weight: 0.2 }
    ],
    hueFamily: 'blue'
  })),
  salon: many(12, 'sl', (i) => ({
    key: i % 3 === 0 ? 'low' : i % 3 === 1 ? 'mid' : 'high',
    meanChroma: 0.13 + (i % 4) * 0.02,
    warmth: 0.3,
    shape: i % 2 ? 'portrait' : 'square',
    hueFamily: (['red', 'green', 'blue', 'yellow', 'violet'] as const)[i % 5]!,
    palette: [
      { oklch: [0.5, 0.18, [25, 140, 260, 100, 300][i % 5]!], weight: 0.6 },
      { oklch: [0.6, 0.12, [100, 25, 140, 300, 260][i % 5]!], weight: 0.4 }
    ]
  })),
  mist: many(12, 'ms', () => ({
    key: 'high',
    meanChroma: 0.015,
    contrast: 0.12,
    liftedBlacks: true,
    negativeSpace: 0.75,
    sharpness: 5,
    edgeDensity: 0.01,
    warmth: -0.1,
    hueFamily: 'neutral',
    palette: [
      { oklch: [0.85, 0.01, 230], weight: 0.8 },
      { oklch: [0.7, 0.01, 230], weight: 0.2 }
    ]
  }))
}
