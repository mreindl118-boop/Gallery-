import { z } from 'zod'
import { PhotoReading } from '@shared/build'
import { HUE_FAMILIES, lchToLab, labToLch, hueFamily, type HueFamily } from './color'
import { kmeans, rng } from './reading'

/**
 * The collection seen as one thing: area-weighted palette clusters,
 * distributions of every per-photo reading and a variety score. Theming
 * works from this alone, so it is stored in the build row.
 */

export const CollectionSummary = z.object({
  photos: z.number().int(),
  palette: z.array(z.object({ oklch: z.tuple([z.number(), z.number(), z.number()]), weight: z.number() })),
  hueFamily: z.string(),
  hueSpread: z.number(),
  meanChroma: z.number(),
  maxChroma: z.number(),
  warmth: z.number(),
  key: z.object({ low: z.number(), mid: z.number(), high: z.number() }),
  meanLightness: z.number(),
  contrast: z.number(),
  shadowClipping: z.number(),
  highlightClipping: z.number(),
  liftedBlacks: z.number(),
  monochrome: z.number(),
  edgeDensity: z.number(),
  grain: z.number(),
  sharpness: z.number(),
  symmetry: z.number(),
  negativeSpace: z.number(),
  horizon: z.number(),
  orientation: z.object({ horizontal: z.number(), vertical: z.number(), diagonal: z.number() }),
  shapes: z.object({
    portrait: z.number(),
    square: z.number(),
    landscape: z.number(),
    panorama: z.number(),
    'vertical-panorama': z.number()
  }),
  timeOfDay: z.object({
    dawn: z.number(),
    day: z.number(),
    golden: z.number(),
    'blue-hour': z.number(),
    night: z.number(),
    unknown: z.number()
  }),
  seasons: z.object({
    spring: z.number(),
    summer: z.number(),
    autumn: z.number(),
    winter: z.number(),
    unknown: z.number()
  }),
  variety: z.number()
})
export type CollectionSummary = z.infer<typeof CollectionSummary>

const r3 = (v: number) => Math.round(v * 1000) / 1000
const r4 = (v: number) => Math.round(v * 10000) / 10000

export function summarize(readings: PhotoReading[]): CollectionSummary {
  const n = readings.length
  const avg = (f: (r: PhotoReading) => number) => (n ? r4(readings.reduce((s, r) => s + f(r), 0) / n) : 0)
  const share = (f: (r: PhotoReading) => boolean) => (n ? r4(readings.filter(f).length / n) : 0)

  // Every swatch of every photo, weighted by its share of that photo, clustered again.
  const swatches = readings.flatMap((r) => r.palette.map((p) => ({ lab: lchToLab(p.oklch), w: p.weight / n })))
  const L = Float32Array.from(swatches.map((s) => s.lab[0]))
  const A = Float32Array.from(swatches.map((s) => s.lab[1]))
  const B = Float32Array.from(swatches.map((s) => s.lab[2]))
  const W = Float32Array.from(swatches.map((s) => s.w))
  const clusters = swatches.length ? kmeans(L, A, B, W, Math.min(6, swatches.length), rng(7)) : []
  const palette = clusters.map((c) => {
    const [l, ch, h] = labToLch(c.center)
    return { oklch: [r3(l), r4(ch), Math.round(h * 10) / 10] as [number, number, number], weight: r4(c.weight) }
  })

  const familyVotes = new Map<HueFamily, number>()
  for (const r of readings)
    familyVotes.set(r.hueFamily as HueFamily, (familyVotes.get(r.hueFamily as HueFamily) ?? 0) + 1)
  let family: string = 'neutral'
  let fv = 0
  for (const f of [...HUE_FAMILIES, 'neutral' as const]) {
    const v = familyVotes.get(f) ?? 0
    if (v > fv) {
      fv = v
      family = f
    }
  }
  // Hue spread: how many hue families the chromatic swatches cover (0 = one, 1 = all).
  const families = new Set<string>()
  for (const p of palette) if (p.oklch[1] >= 0.03) families.add(hueFamily(p.oklch[2]))
  const hueSpread = Math.min(1, families.size / 5)

  const keyShare = {
    low: share((r) => r.key === 'low'),
    mid: share((r) => r.key === 'mid'),
    high: share((r) => r.key === 'high')
  }
  const meanChroma = avg((r) => r.meanChroma)
  const contrast = avg((r) => r.contrast)
  const shapes = {
    portrait: share((r) => r.shape === 'portrait'),
    square: share((r) => r.shape === 'square'),
    landscape: share((r) => r.shape === 'landscape'),
    panorama: share((r) => r.shape === 'panorama'),
    'vertical-panorama': share((r) => r.shape === 'vertical-panorama')
  }
  const timeOfDay = {
    dawn: share((r) => r.timeOfDay === 'dawn'),
    day: share((r) => r.timeOfDay === 'day'),
    golden: share((r) => r.timeOfDay === 'golden'),
    'blue-hour': share((r) => r.timeOfDay === 'blue-hour'),
    night: share((r) => r.timeOfDay === 'night'),
    unknown: share((r) => r.timeOfDay === null)
  }
  const seasons = {
    spring: share((r) => r.season === 'spring'),
    summer: share((r) => r.season === 'summer'),
    autumn: share((r) => r.season === 'autumn'),
    winter: share((r) => r.season === 'winter'),
    unknown: share((r) => r.season === null)
  }

  // Variety: spread of key, chroma, hue and shape across the set.
  const sd = (f: (r: PhotoReading) => number) => {
    if (n < 2) return 0
    const m = readings.reduce((s, r) => s + f(r), 0) / n
    return Math.sqrt(readings.reduce((s, r) => s + (f(r) - m) ** 2, 0) / n)
  }
  const keyEntropy = entropy([keyShare.low, keyShare.mid, keyShare.high])
  const shapeEntropy = entropy(Object.values(shapes))
  const variety = r3(
    Math.min(
      1,
      0.3 * keyEntropy + 0.25 * hueSpread + 0.25 * Math.min(1, sd((r) => r.meanChroma) / 0.05) + 0.2 * shapeEntropy
    )
  )

  return CollectionSummary.parse({
    photos: n,
    palette,
    hueFamily: family,
    hueSpread: r3(hueSpread),
    meanChroma,
    maxChroma: avg((r) => r.maxChroma),
    warmth: avg((r) => r.warmth),
    key: keyShare,
    meanLightness: avg((r) => r.palette.reduce((s, p) => s + p.oklch[0] * p.weight, 0)),
    contrast,
    shadowClipping: avg((r) => r.clipping.shadows),
    highlightClipping: avg((r) => r.clipping.highlights),
    liftedBlacks: share((r) => r.liftedBlacks),
    monochrome: share((r) => r.monochrome),
    edgeDensity: avg((r) => r.edgeDensity),
    grain: avg((r) => r.grain),
    sharpness: avg((r) => r.sharpness),
    symmetry: avg((r) => r.symmetry),
    negativeSpace: avg((r) => r.negativeSpace),
    horizon: share((r) => r.horizon),
    orientation: {
      horizontal: avg((r) => r.orientationEnergy.horizontal),
      vertical: avg((r) => r.orientationEnergy.vertical),
      diagonal: avg((r) => r.orientationEnergy.diagonal)
    },
    shapes,
    timeOfDay,
    seasons,
    variety
  })
}

/** Normalized Shannon entropy of a distribution (0 = one bucket, 1 = even). */
function entropy(p: number[]): number {
  const nz = p.filter((v) => v > 0)
  if (nz.length <= 1) return 0
  const h = -nz.reduce((s, v) => s + v * Math.log(v), 0)
  return h / Math.log(p.length)
}
