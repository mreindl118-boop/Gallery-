import type { PhotoReading } from '@shared/build'
import { hueFamily, parseOklch } from './color'
import type { CollectionSummary } from './summary'
import type { Theme } from './theming'
import type { AssetKind } from './providers/types'

/**
 * Prompts for generated assets, in plain words from what the reading knows:
 * palette, key, warmth and the archetype. No art-speak, no artist names.
 */

const colourWord = (oklch: [number, number, number]): string => {
  const [L, C, h] = oklch
  if (C < 0.02) return L > 0.8 ? 'off-white' : L > 0.55 ? 'light grey' : L > 0.3 ? 'dark grey' : 'near-black'
  const fam = hueFamily(h)
  const depth = L > 0.75 ? 'pale' : L < 0.35 ? 'deep' : C > 0.12 ? 'strong' : 'muted'
  return `${depth} ${fam}`
}

export function paletteWords(summary: CollectionSummary): string {
  const top = [...summary.palette].sort((a, b) => b.weight - a.weight).slice(0, 3)
  const words = [...new Set(top.map((p) => colourWord(p.oklch)))]
  return words.join(', ')
}

const keyWords = (s: CollectionSummary): string =>
  s.key.low > 0.5 ? 'dark, low-key' : s.key.high > 0.5 ? 'bright, high-key' : 'evenly lit'

const warmthWords = (s: CollectionSummary): string => (s.warmth > 0.25 ? 'warm' : s.warmth < -0.25 ? 'cool' : 'neutral')

const ROOM_WORDS: Record<Theme['archetype'], string> = {
  'white-cube': 'a bright white gallery',
  concrete: 'a concrete gallery',
  timber: 'a timber-lined gallery',
  nocturne: 'a dark gallery at night',
  salon: 'a richly painted salon',
  mist: 'a soft, hazy gallery'
}

const describeWall = (theme: Theme): string => {
  const c = parseOklch(theme.palette.wall)
  return c ? colourWord(c) : 'neutral'
}

export function buildPrompt(
  kind: AssetKind,
  theme: Theme,
  summary: CollectionSummary,
  seed?: PhotoReading | null,
  surface: 'wall' | 'floor' = 'wall'
): string {
  const palette = paletteWords(summary)
  const light = `${warmthWords(summary)} light`
  switch (kind) {
    case 'texture': {
      const material = surface === 'wall' ? theme.materials.wall : theme.materials.floor
      const colour =
        surface === 'wall'
          ? describeWall(theme)
          : (parseOklch(theme.palette.floor) && colourWord(parseOklch(theme.palette.floor)!)) || 'neutral'
      return `A seamless, tileable close-up of ${material}, ${colour}, flat and evenly lit, no objects, no text, no shadows at the edges, photographed straight on.`
    }
    case 'backdrop':
      return `A view through a large window from ${ROOM_WORDS[theme.archetype]}: a calm ${keyWords(summary)} scene outside in ${light}, colours of ${palette}, no people, no text, soft focus in the distance.`
    case 'companion': {
      const subject = seed
        ? `${seed.key === 'low' ? 'a dark' : seed.key === 'high' ? 'a bright' : 'an evenly lit'} ${seed.shape === 'portrait' || seed.shape === 'vertical-panorama' ? 'upright' : 'wide'} photograph with ${seed.monochrome ? 'no colour' : `${seed.hueFamily} tones`}${seed.negativeSpace > 0.4 ? ', with a lot of empty space' : ''}${seed.horizon ? ', with a horizon' : ''}`
        : `a ${keyWords(summary)} photograph`
      return `${subject[0]!.toUpperCase()}${subject.slice(1)}, in the same spirit as the collection: ${palette}, ${light}, ${keyWords(summary)}, natural and quiet, no people, no text, no watermark.`
    }
  }
}
