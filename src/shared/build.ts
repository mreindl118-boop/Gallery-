import { z } from 'zod'
import { ProjectId } from './schemas'

/**
 * The automatic build that follows an import: read every photo (and video
 * poster), theme the exhibition from that reading, then generate assets from
 * the user's own images through a chosen image provider. Each stage reports
 * progress and a plain status line. Everything derived lives in .gallery/.
 */

export const BuildStage = z.enum(['reading', 'theming', 'generating'])
export type BuildStage = z.infer<typeof BuildStage>

export const BuildState = z.enum(['idle', 'waiting', 'running', 'paused', 'done', 'failed'])
export type BuildState = z.infer<typeof BuildState>

export const BuildProgress = z.object({
  projectId: ProjectId,
  state: BuildState,
  /** Stage under way (or the last one that ran). */
  stage: BuildStage.nullable(),
  /** 0–1 within the current stage. */
  stageFraction: z.number().min(0).max(1),
  /** 0–1 across the whole build. */
  fraction: z.number().min(0).max(1),
  /** One calm sentence: "Reading 412 of 1,204 photos." */
  status: z.string(),
  /** Why the build stopped, plainly, when state is failed or paused. */
  message: z.string().nullable(),
  /** Which stages have completed in this build. */
  completed: z.array(BuildStage),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable()
})
export type BuildProgress = z.infer<typeof BuildProgress>

/** Per-photo reading (brief §6, rules path). Stored in SQLite, shown in the info panel. */
export const PhotoReading = z.object({
  photoId: z.string(),
  palette: z.array(z.object({ oklch: z.tuple([z.number(), z.number(), z.number()]), weight: z.number() })).max(6),
  hueFamily: z.string(),
  meanChroma: z.number(),
  maxChroma: z.number(),
  key: z.enum(['low', 'mid', 'high']),
  contrast: z.number(),
  clipping: z.object({ shadows: z.number(), highlights: z.number() }),
  liftedBlacks: z.boolean(),
  monochrome: z.boolean(),
  warmth: z.number(),
  edgeDensity: z.number(),
  grain: z.number(),
  sharpness: z.number(),
  orientationEnergy: z.object({ horizontal: z.number(), vertical: z.number(), diagonal: z.number() }),
  symmetry: z.number(),
  negativeSpace: z.number(),
  horizon: z.boolean(),
  shape: z.enum(['portrait', 'square', 'landscape', 'panorama', 'vertical-panorama']),
  timeOfDay: z.enum(['dawn', 'day', 'golden', 'blue-hour', 'night']).nullable(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']).nullable()
})
export type PhotoReading = z.infer<typeof PhotoReading>

/** Image-generation providers the user can choose in Settings. */
export const GeneratorProvider = z.enum(['none', 'stability', 'openai', 'xai'])
export type GeneratorProvider = z.infer<typeof GeneratorProvider>

export const GeneratorSettings = z.object({
  provider: GeneratorProvider.default('none'),
  /** Whether a key is stored for each provider (the key itself never leaves main). */
  hasKey: z
    .object({ stability: z.boolean(), openai: z.boolean(), xai: z.boolean() })
    .default({ stability: false, openai: false, xai: false }),
  /** Images per build, and the spend cap in USD the user agreed to. */
  imagesPerBuild: z.number().int().min(0).max(200).default(12),
  spendCapUsd: z.number().min(0).max(1000).default(5)
})
export type GeneratorSettings = z.infer<typeof GeneratorSettings>

/** Price per image in USD per provider; editable config, never hardcoded in logic. */
export const KeyedProvider = z.enum(['stability', 'openai', 'xai'])
export type KeyedProvider = z.infer<typeof KeyedProvider>
export const GeneratorPrices = z.object({
  stability: z.number().nonnegative(),
  openai: z.number().nonnegative(),
  xai: z.number().nonnegative()
})
export type GeneratorPrices = z.infer<typeof GeneratorPrices>
/** Starting prices (USD per image) until verified against each account; editable in userData/generator-prices.json. */
export const DEFAULT_PRICES: GeneratorPrices = { stability: 0.04, openai: 0.04, xai: 0.07 }

/** What the user sees before the first generation run. */
export const GenerationEstimate = z.object({
  provider: GeneratorProvider,
  images: z.number().int(),
  pricePerImageUsd: z.number(),
  totalUsd: z.number(),
  withinCap: z.boolean()
})
export type GenerationEstimate = z.infer<typeof GenerationEstimate>

/** A generated asset saved under .gallery/generated/. */
export const GeneratedAsset = z.object({
  id: z.string(),
  projectId: ProjectId,
  kind: z.enum(['texture', 'backdrop', 'companion']),
  path: z.string(),
  seedPhotoIds: z.array(z.string()),
  prompt: z.string(),
  provider: GeneratorProvider,
  createdAt: z.string()
})
export type GeneratedAsset = z.infer<typeof GeneratedAsset>

/** Engine methods (main → engine) under 'build.<name>'. `root` is resolved by main. */
export const BuildMethods = {
  start: z.object({ projectId: ProjectId, root: z.string(), stages: z.array(BuildStage).optional() }),
  pause: z.object({ projectId: ProjectId, root: z.string() }),
  resume: z.object({ projectId: ProjectId, root: z.string() }),
  cancel: z.object({ projectId: ProjectId, root: z.string() }),
  status: z.object({ projectId: ProjectId, root: z.string() }),
  reading: z.object({ projectId: ProjectId, root: z.string(), photoId: z.string() }),
  assets: z.object({ projectId: ProjectId, root: z.string() })
} as const
