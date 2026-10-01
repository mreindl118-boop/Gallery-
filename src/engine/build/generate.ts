import type { GenerationEstimate, GeneratorPrices, GeneratorProvider, PhotoReading } from '@shared/build'
import { buildPrompt } from './prompts'
import type { AssetKind, Shape } from './providers/types'
import type { CollectionSummary } from './summary'
import type { Theme } from './theming'

/**
 * What a generating run makes, in order: a wall texture, a floor texture, a
 * backdrop, then companions seeded from the strongest photographs. Never
 * more than the user's images-per-build; nothing when the estimate is over
 * the spend cap.
 */

export interface PlannedAsset {
  index: number
  kind: AssetKind
  surface: 'wall' | 'floor' | null
  shape: Shape
  seedPhotoIds: string[]
  prompt: string
}

export interface Limits {
  imagesPerBuild: number
  spendCapUsd: number
}

/** How many images a build would make for this collection and limit. */
export function plannedImages(photos: number, imagesPerBuild: number): number {
  if (imagesPerBuild <= 0) return 0
  return Math.min(imagesPerBuild, 3 + photos)
}

export function estimate(
  provider: GeneratorProvider,
  photos: number,
  prices: GeneratorPrices,
  limits: Limits
): GenerationEstimate {
  if (provider === 'none') return { provider, images: 0, pricePerImageUsd: 0, totalUsd: 0, withinCap: true }
  const images = plannedImages(photos, limits.imagesPerBuild)
  const price = prices[provider]
  const totalUsd = Math.round(images * price * 10000) / 10000
  return { provider, images, pricePerImageUsd: price, totalUsd, withinCap: totalUsd <= limits.spendCapUsd + 1e-9 }
}

/** Strongest photographs first: sharp, and different from the ones already chosen. */
export function rankSeeds(readings: PhotoReading[]): PhotoReading[] {
  const pool = [...readings].sort((a, b) => b.sharpness - a.sharpness)
  const out: PhotoReading[] = []
  const seen = new Set<string>()
  while (pool.length) {
    const i = pool.findIndex((r) => !seen.has(`${r.hueFamily}/${r.key}/${r.shape}`))
    const next = pool.splice(i === -1 ? 0 : i, 1)[0]!
    seen.add(`${next.hueFamily}/${next.key}/${next.shape}`)
    out.push(next)
    if (i === -1) seen.clear()
  }
  return out
}

export function plan(
  theme: Theme,
  summary: CollectionSummary,
  readings: PhotoReading[],
  imagesPerBuild: number
): PlannedAsset[] {
  const n = plannedImages(readings.length, imagesPerBuild)
  const out: PlannedAsset[] = []
  const fixed: Omit<PlannedAsset, 'index' | 'prompt'>[] = [
    { kind: 'texture', surface: 'wall', shape: 'square', seedPhotoIds: [] },
    { kind: 'texture', surface: 'floor', shape: 'square', seedPhotoIds: [] },
    { kind: 'backdrop', surface: null, shape: 'landscape', seedPhotoIds: [] }
  ]
  for (const f of fixed) {
    if (out.length >= n) break
    out.push({ ...f, index: out.length, prompt: buildPrompt(f.kind, theme, summary, null, f.surface ?? 'wall') })
  }
  const seeds = rankSeeds(readings)
  for (const seed of seeds) {
    if (out.length >= n) break
    const shape: Shape =
      seed.shape === 'portrait' || seed.shape === 'vertical-panorama'
        ? 'portrait'
        : seed.shape === 'square'
          ? 'square'
          : 'landscape'
    out.push({
      index: out.length,
      kind: 'companion',
      surface: null,
      shape,
      seedPhotoIds: [seed.photoId],
      prompt: buildPrompt('companion', theme, summary, seed)
    })
  }
  return out
}
