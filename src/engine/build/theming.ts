import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonVersioned, writeJsonAtomic } from '@shared/node/atomic-json'
import defaultRules from '../../../design/rules.json'
import { contrastRatio, hueFamily, oklchString, parseOklch, type Lch } from './color'
import { rng } from './reading'
import type { CollectionSummary } from './summary'

/**
 * Theming (brief §8, rules path): six archetypes scored as data-driven
 * fitness functions over the collection summary, the winner translated into
 * a palette and atmosphere under the restraint rules. Every choice carries a
 * reason. The theme is written to <root>/exhibition/theme.json.
 */

export const ARCHETYPES = ['white-cube', 'concrete', 'timber', 'nocturne', 'salon', 'mist'] as const
export type Archetype = (typeof ARCHETYPES)[number]

const HueSource = z.union([z.number(), z.literal('collection'), z.literal('wall'), z.literal('accent')])
const Swatch = z.object({ L: z.number(), chroma: z.number(), hue: HueSource })

export const Rules = z.object({
  schemaVersion: z.literal(1),
  notes: z.string().optional(),
  restraint: z.object({
    wallChromaMax: z.number(),
    salonWallChromaMax: z.number(),
    floorChromaMax: z.number(),
    ceilingChromaMax: z.number(),
    accentChromaMax: z.number(),
    textContrastMin: z.number()
  }),
  archetypes: z.record(
    z.enum(ARCHETYPES),
    z.object({
      label: z.string(),
      weights: z.record(z.string(), z.number()),
      palette: z.object({ wall: Swatch, floor: Swatch, ceiling: Swatch, accent: Swatch }),
      atmosphere: z.object({
        lightKelvin: z.number(),
        ambient: z.number(),
        contrast: z.number(),
        fog: z.number(),
        daylight: z.number()
      }),
      materials: z.object({ wall: z.string(), floor: z.string(), ceiling: z.string() })
    })
  ),
  text: z.object({
    dark: z.object({ L: z.number(), chroma: z.number() }),
    light: z.object({ L: z.number(), chroma: z.number() })
  }),
  signals: z.object({
    chromaScale: z.number(),
    grainScale: z.number(),
    edgeScale: z.number(),
    sharpnessScale: z.number(),
    shadowClipScale: z.number()
  })
})
export type Rules = z.infer<typeof Rules>

export const DEFAULT_RULES: Rules = Rules.parse(defaultRules)

export const THEME_FILE = join('exhibition', 'theme.json')
export const THEME_SCHEMA_VERSION = 1

export const Theme = z.object({
  schemaVersion: z.literal(THEME_SCHEMA_VERSION),
  projectId: z.string(),
  archetype: z.enum(ARCHETYPES),
  label: z.string(),
  seed: z.number().int(),
  /** OKLCH strings. */
  palette: z.object({ wall: z.string(), floor: z.string(), ceiling: z.string(), accent: z.string(), text: z.string() }),
  atmosphere: z.object({
    lightKelvin: z.number(),
    ambient: z.number(),
    contrast: z.number(),
    fog: z.number(),
    daylight: z.number()
  }),
  materials: z.object({ wall: z.string(), floor: z.string(), ceiling: z.string() }),
  scores: z.record(z.string(), z.number()),
  reasons: z.array(z.object({ target: z.string(), because: z.string() })),
  createdAt: z.string()
})
export type Theme = z.infer<typeof Theme>

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** The 0–1 signals the weights refer to. Add one here and it is usable from rules.json. */
export function signals(s: CollectionSummary, rules: Rules = DEFAULT_RULES): Record<string, number> {
  const k = rules.signals
  const chroma = clamp01(s.meanChroma / k.chromaScale)
  const sharp = clamp01(s.sharpness / k.sharpnessScale)
  const daylight = s.timeOfDay.day + s.timeOfDay.dawn + s.timeOfDay.golden
  return {
    highKey: s.key.high,
    midKey: s.key.mid,
    lowKey: s.key.low,
    lowChroma: 1 - chroma,
    midChroma: 1 - Math.abs(chroma - 0.5) * 2,
    highChroma: chroma,
    warm: clamp01(s.warmth),
    cool: clamp01(-s.warmth),
    monochrome: s.monochrome,
    highContrast: clamp01(s.contrast),
    lowContrast: 1 - clamp01(s.contrast),
    grain: clamp01(s.grain / k.grainScale),
    negativeSpace: clamp01(s.negativeSpace),
    variety: clamp01(s.variety),
    liftedBlacks: s.liftedBlacks,
    night: s.timeOfDay.night + s.timeOfDay['blue-hour'],
    daylight,
    edges: clamp01(s.edgeDensity / k.edgeScale),
    sharp,
    soft: 1 - sharp,
    portraits: s.shapes.portrait + s.shapes['vertical-panorama'],
    panoramas: s.shapes.panorama,
    symmetry: clamp01(s.symmetry),
    horizon: s.horizon,
    shadowClipping: clamp01(s.shadowClipping / k.shadowClipScale)
  }
}

export interface Pick {
  archetype: Archetype
  scores: Record<Archetype, number>
  /** The signals that argued most for the winner, strongest first. */
  drivers: { signal: string; contribution: number }[]
}

/** Highest fitness wins; an exact tie falls to a seeded draw so the same collection always gets the same room. */
export function pickArchetype(s: CollectionSummary, seed: number, rules: Rules = DEFAULT_RULES): Pick {
  const sig = signals(s, rules)
  const scores = {} as Record<Archetype, number>
  const contributions = {} as Record<Archetype, { signal: string; contribution: number }[]>
  for (const a of ARCHETYPES) {
    const def = rules.archetypes[a]
    if (!def) {
      scores[a] = Number.NEGATIVE_INFINITY
      contributions[a] = []
      continue
    }
    let total = 0
    const parts: { signal: string; contribution: number }[] = []
    for (const [name, weight] of Object.entries(def.weights)) {
      const v = sig[name]
      if (v === undefined) continue
      const c = weight * v
      total += c
      parts.push({ signal: name, contribution: c })
    }
    scores[a] = Math.round(total * 10000) / 10000
    contributions[a] = parts.filter((p) => p.contribution > 0).sort((x, y) => y.contribution - x.contribution)
  }
  const best = Math.max(...ARCHETYPES.map((a) => scores[a]))
  const tied = ARCHETYPES.filter((a) => scores[a] === best)
  const archetype = tied[Math.floor(rng(seed)() * tied.length)]!
  return { archetype, scores, drivers: contributions[archetype].slice(0, 3) }
}

const SIGNAL_WORDS: Record<string, string> = {
  highKey: 'most of the photographs are bright',
  midKey: 'the photographs sit in the middle tones',
  lowKey: 'most of the photographs are dark',
  lowChroma: 'the colours are quiet',
  midChroma: 'the colours are present without shouting',
  highChroma: 'the colours are strong',
  warm: 'the collection runs warm',
  cool: 'the collection runs cool',
  monochrome: 'much of the work is monochrome',
  highContrast: 'the contrast is high',
  lowContrast: 'the contrast is gentle',
  grain: 'there is visible grain',
  negativeSpace: 'the frames hold a lot of empty space',
  variety: 'the collection is varied',
  liftedBlacks: 'the blacks are lifted',
  night: 'many were taken at night',
  daylight: 'most were taken in daylight',
  edges: 'the frames are full of edges and detail',
  sharp: 'the images are crisp',
  soft: 'the images are soft',
  portraits: 'many are upright frames',
  panoramas: 'there are panoramas',
  symmetry: 'the compositions are symmetrical',
  horizon: 'horizons run through many frames',
  shadowClipping: 'the shadows fall to black'
}

/** Builds the full theme for a summary. Pure: the same inputs give the same theme (apart from createdAt). */
export function buildTheme(
  projectId: string,
  s: CollectionSummary,
  seed: number,
  rules: Rules = DEFAULT_RULES,
  now = () => new Date().toISOString()
): Theme {
  const pick = pickArchetype(s, seed, rules)
  const def = rules.archetypes[pick.archetype]!
  const r = rules.restraint
  const reasons: { target: string; because: string }[] = []

  const why = pick.drivers.map((d) => SIGNAL_WORDS[d.signal] ?? d.signal)
  reasons.push({
    target: 'archetype',
    because: why.length
      ? `${def.label}, because ${joinWords(why)}.`
      : `${def.label} by default; the collection gave no strong signal.`
  })

  // Hues: the collection's dominant chromatic cluster, or the archetype's own.
  const chromatic = [...s.palette].filter((p) => p.oklch[1] >= 0.03).sort((a, b) => b.weight - a.weight)
  const strongest = [...s.palette].sort((a, b) => b.oklch[1] * b.weight - a.oklch[1] * a.weight)[0]
  const collectionHue = chromatic[0]?.oklch[2] ?? null
  const accentHue = strongest && strongest.oklch[1] >= 0.02 ? strongest.oklch[2] : null

  const wallChromaMax = pick.archetype === 'salon' ? r.salonWallChromaMax : r.wallChromaMax
  const wall = swatch(def.palette.wall, wallChromaMax, { collection: collectionHue, accent: accentHue, wall: null })
  if (def.palette.wall.hue === 'collection')
    reasons.push({
      target: 'palette.wall',
      because:
        collectionHue === null
          ? 'A neutral wall; the collection has no dominant hue to borrow.'
          : `A faint ${hueFamily(collectionHue)} cast taken from the collection, kept under ${wallChromaMax} chroma so the prints carry the colour.`
    })
  else reasons.push({ target: 'palette.wall', because: `${def.label}'s own wall; chroma held to ${wallChromaMax}.` })
  const ctx = { collection: collectionHue, accent: accentHue, wall: wall[2] }
  const floor = swatch(def.palette.floor, r.floorChromaMax, ctx)
  reasons.push({
    target: 'palette.floor',
    because: `${def.materials.floor}, darker than the wall so the room reads as a room.`
  })
  const ceiling = swatch(def.palette.ceiling, r.ceilingChromaMax, ctx)
  reasons.push({
    target: 'palette.ceiling',
    because: `${def.materials.ceiling}, near the wall's hue and almost without chroma.`
  })
  const accent = swatch(def.palette.accent, r.accentChromaMax, ctx)
  reasons.push({
    target: 'palette.accent',
    because:
      accentHue === null
        ? 'A restrained accent; the collection is too neutral to sample one.'
        : `Sampled from the collection's strongest ${hueFamily(accentHue)}, capped at ${r.accentChromaMax} chroma.`
  })
  const text = textFor(wall, rules)
  reasons.push({
    target: 'palette.text',
    because: `${text[0] < 0.5 ? 'Dark' : 'Light'} text for at least ${r.textContrastMin}:1 against the wall.`
  })

  const atmosphere = { ...def.atmosphere }
  if (s.warmth > 0.25) {
    atmosphere.lightKelvin = Math.round(Math.max(2700, atmosphere.lightKelvin - 300))
    reasons.push({ target: 'atmosphere.lightKelvin', because: 'Warmer light, because the collection runs warm.' })
  } else if (s.warmth < -0.25) {
    atmosphere.lightKelvin = Math.round(Math.min(6500, atmosphere.lightKelvin + 300))
    reasons.push({ target: 'atmosphere.lightKelvin', because: 'Cooler light, because the collection runs cool.' })
  } else reasons.push({ target: 'atmosphere.lightKelvin', because: `${def.label}'s usual light.` })
  const night = s.timeOfDay.night + s.timeOfDay['blue-hour']
  if (night > 0.5 && atmosphere.daylight > 0) {
    atmosphere.daylight = Math.round(atmosphere.daylight * 0.5 * 100) / 100
    reasons.push({
      target: 'atmosphere.daylight',
      because: 'Less daylight, because most of the photographs were taken at night.'
    })
  } else reasons.push({ target: 'atmosphere.daylight', because: `${def.label}'s usual share of daylight.` })
  reasons.push({ target: 'atmosphere.ambient', because: `Ambient light set for ${def.label}.` })
  reasons.push({ target: 'atmosphere.contrast', because: `Lighting contrast set for ${def.label}.` })
  reasons.push({
    target: 'atmosphere.fog',
    because: atmosphere.fog > 0 ? `A little haze, part of ${def.label}.` : 'No haze; the air stays clear.'
  })
  reasons.push({
    target: 'materials',
    because: `${def.materials.wall}, ${def.materials.floor} and ${def.materials.ceiling}: ${def.label}'s materials.`
  })

  return Theme.parse({
    schemaVersion: THEME_SCHEMA_VERSION,
    projectId,
    archetype: pick.archetype,
    label: def.label,
    seed,
    palette: {
      wall: oklchString(wall),
      floor: oklchString(floor),
      ceiling: oklchString(ceiling),
      accent: oklchString(accent),
      text: oklchString(text)
    },
    atmosphere,
    materials: { ...def.materials },
    scores: pick.scores,
    reasons,
    createdAt: now()
  })
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function swatch(
  def: z.infer<typeof Swatch>,
  chromaMax: number,
  hues: { collection: number | null; accent: number | null; wall: number | null }
): Lch {
  let hue: number
  if (typeof def.hue === 'number') hue = def.hue
  else hue = hues[def.hue] ?? hues.wall ?? hues.collection ?? 80
  const chroma = Math.min(def.chroma, chromaMax)
  return [clamp01(def.L), Math.max(0, chroma), ((hue % 360) + 360) % 360]
}

/** Dark or light text, whichever reads better on the wall, pushed further until it meets the contrast floor. */
export function textFor(wall: Lch, rules: Rules = DEFAULT_RULES): Lch {
  const min = rules.restraint.textContrastMin
  const dark: Lch = [rules.text.dark.L, rules.text.dark.chroma, wall[2]]
  const light: Lch = [rules.text.light.L, rules.text.light.chroma, wall[2]]
  let best = contrastRatio(dark, wall) >= contrastRatio(light, wall) ? dark : light
  for (let i = 0; i < 40 && contrastRatio(best, wall) < min; i++) {
    best =
      best[0] < 0.5 ? [Math.max(0, best[0] - 0.02), best[1], best[2]] : [Math.min(1, best[0] + 0.02), best[1], best[2]]
  }
  if (contrastRatio(best, wall) < min) best = best[0] < 0.5 ? [0, 0, wall[2]] : [1, 0, wall[2]]
  return best
}

/** Checks the restraint rules on a theme; returns the breaches (empty when it passes). */
export function restraintBreaches(theme: Theme, rules: Rules = DEFAULT_RULES): string[] {
  const out: string[] = []
  const r = rules.restraint
  const wall = parseOklch(theme.palette.wall)
  const text = parseOklch(theme.palette.text)
  const max = theme.archetype === 'salon' ? r.salonWallChromaMax : r.wallChromaMax
  if (!wall || wall[1] > max + 1e-9) out.push(`wall chroma ${wall?.[1]} over ${max}`)
  if (!wall || !text || contrastRatio(text, wall) < r.textContrastMin) out.push('text contrast under the floor')
  for (const [k, lim] of [
    ['floor', r.floorChromaMax],
    ['ceiling', r.ceilingChromaMax],
    ['accent', r.accentChromaMax]
  ] as const) {
    const c = parseOklch(theme.palette[k])
    if (!c || c[1] > lim + 1e-9) out.push(`${k} chroma over ${lim}`)
  }
  return out
}

/** A stable fingerprint of what generating depends on (not the timestamp). */
export function themeHash(theme: Theme): string {
  const { createdAt: _createdAt, ...rest } = theme
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 16)
}

export async function writeTheme(root: string, theme: Theme): Promise<void> {
  await writeJsonAtomic(join(root, THEME_FILE), theme)
}

export async function readTheme(root: string): Promise<Theme | null> {
  return readJsonVersioned(join(root, THEME_FILE), Theme, THEME_SCHEMA_VERSION)
}
