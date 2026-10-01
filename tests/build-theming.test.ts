import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contrastRatio, parseOklch } from '../src/engine/build/color'
import { plan, estimate, rankSeeds } from '../src/engine/build/generate'
import { buildPrompt } from '../src/engine/build/prompts'
import { CollectionSummary, summarize } from '../src/engine/build/summary'
import {
  ARCHETYPES,
  buildTheme,
  DEFAULT_RULES,
  pickArchetype,
  readTheme,
  restraintBreaches,
  themeHash,
  writeTheme,
  type Archetype
} from '../src/engine/build/theming'
import { SETS, reading } from './fixtures/readings'

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gl-theming-'))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const PROJECT = '0f5c4a8e-2b1d-4c3e-9a7f-1234567890ab'

describe('archetype selection', () => {
  for (const archetype of ARCHETYPES) {
    it(`picks ${archetype} for its fixture set`, () => {
      const summary = summarize(SETS[archetype]!)
      const pick = pickArchetype(summary, 1)
      expect(pick.archetype, JSON.stringify(pick.scores)).toBe(archetype)
      expect(pick.drivers.length).toBeGreaterThan(0)
    })
  }

  it('breaks an exact tie with the seed, and the same seed gives the same answer', () => {
    const flat = summarize([])
    const rules = {
      ...DEFAULT_RULES,
      archetypes: Object.fromEntries(
        ARCHETYPES.map((a) => [a, { ...DEFAULT_RULES.archetypes[a]!, weights: {} }])
      ) as typeof DEFAULT_RULES.archetypes
    }
    const picks = new Set<Archetype>()
    for (let seed = 0; seed < 40; seed++) {
      const a = pickArchetype(flat, seed, rules).archetype
      expect(pickArchetype(flat, seed, rules).archetype).toBe(a)
      picks.add(a)
    }
    expect(picks.size).toBeGreaterThan(1)
  })
})

describe('theme', () => {
  it('builds a theme with reasons for every target and writes/reads theme.json', async () => {
    const summary = summarize(SETS.timber!)
    const theme = buildTheme(PROJECT, summary, 7, DEFAULT_RULES, () => '2026-10-01T00:00:00.000Z')
    expect(theme.archetype).toBe('timber')
    for (const target of [
      'archetype',
      'palette.wall',
      'palette.floor',
      'palette.ceiling',
      'palette.accent',
      'palette.text',
      'atmosphere.lightKelvin',
      'atmosphere.daylight',
      'materials'
    ])
      expect(theme.reasons.find((r) => r.target === target)?.because).toMatch(/\.$/)
    expect(theme.reasons[0]!.because).toContain('Timber, because')
    expect(theme.atmosphere.lightKelvin).toBeLessThan(DEFAULT_RULES.archetypes.timber!.atmosphere.lightKelvin)
    expect(restraintBreaches(theme)).toEqual([])

    const root = join(tmp, 'p1')
    await writeTheme(root, theme)
    const back = await readTheme(root)
    expect(back).toEqual(theme)
    expect(themeHash(theme)).toBe(themeHash({ ...theme, createdAt: 'other' }))
    expect(themeHash(theme)).not.toBe(themeHash({ ...theme, archetype: 'mist' }))
  })

  it('salon walls may carry more chroma than the rest, still under the salon limit', () => {
    const theme = buildTheme(PROJECT, summarize(SETS.salon!), 1)
    expect(theme.archetype).toBe('salon')
    const wall = parseOklch(theme.palette.wall)!
    expect(wall[1]).toBeGreaterThan(DEFAULT_RULES.restraint.wallChromaMax)
    expect(wall[1]).toBeLessThanOrEqual(DEFAULT_RULES.restraint.salonWallChromaMax)
  })

  it('nocturne gets light text on a dark wall', () => {
    const theme = buildTheme(PROJECT, summarize(SETS.nocturne!), 1)
    expect(theme.archetype).toBe('nocturne')
    expect(parseOklch(theme.palette.text)![0]).toBeGreaterThan(0.9)
  })
})

const arbSummary = (): fc.Arbitrary<CollectionSummary> => {
  const unit = fc.double({ min: 0, max: 1, noNaN: true })
  const dist3 = fc.tuple(unit, unit, unit).map(([a, b, c]) => {
    const s = a + b + c || 1
    return [a / s, b / s, c / s] as const
  })
  const swatch = fc.record({
    oklch: fc.tuple(unit, fc.double({ min: 0, max: 0.35, noNaN: true }), fc.double({ min: 0, max: 360, noNaN: true })),
    weight: unit
  })
  return fc
    .record({
      photos: fc.integer({ min: 0, max: 500 }),
      palette: fc.array(swatch, { minLength: 0, maxLength: 6 }),
      hueFamily: fc.constantFrom('red', 'blue', 'neutral', 'green'),
      hueSpread: unit,
      meanChroma: fc.double({ min: 0, max: 0.3, noNaN: true }),
      maxChroma: fc.double({ min: 0, max: 0.4, noNaN: true }),
      warmth: fc.double({ min: -1, max: 1, noNaN: true }),
      key: dist3.map(([low, mid, high]) => ({ low, mid, high })),
      meanLightness: unit,
      contrast: unit,
      shadowClipping: unit,
      highlightClipping: unit,
      liftedBlacks: unit,
      monochrome: unit,
      edgeDensity: unit,
      grain: fc.double({ min: 0, max: 0.2, noNaN: true }),
      sharpness: fc.double({ min: 0, max: 500, noNaN: true }),
      symmetry: unit,
      negativeSpace: unit,
      horizon: unit,
      orientation: dist3.map(([horizontal, vertical, diagonal]) => ({ horizontal, vertical, diagonal })),
      shapes: fc.tuple(unit, unit, unit, unit, unit).map(([a, b, c, d, e]) => {
        const s = a + b + c + d + e || 1
        return { portrait: a / s, square: b / s, landscape: c / s, panorama: d / s, 'vertical-panorama': e / s }
      }),
      timeOfDay: fc.tuple(unit, unit, unit, unit, unit, unit).map(([a, b, c, d, e, f]) => {
        const s = a + b + c + d + e + f || 1
        return { dawn: a / s, day: b / s, golden: c / s, 'blue-hour': d / s, night: e / s, unknown: f / s }
      }),
      seasons: fc.tuple(unit, unit, unit, unit, unit).map(([a, b, c, d, e]) => {
        const s = a + b + c + d + e || 1
        return { spring: a / s, summer: b / s, autumn: c / s, winter: d / s, unknown: e / s }
      }),
      variety: unit
    })
    .map((s) => CollectionSummary.parse(s))
}

describe('restraint rules (property)', () => {
  it('hold for any summary and seed: wall chroma under its limit, text contrast at least 4.5', () => {
    fc.assert(
      fc.property(arbSummary(), fc.integer({ min: 0, max: 1 << 30 }), (summary, seed) => {
        const theme = buildTheme(PROJECT, summary, seed)
        expect(restraintBreaches(theme)).toEqual([])
        const wall = parseOklch(theme.palette.wall)!
        const text = parseOklch(theme.palette.text)!
        const limit =
          theme.archetype === 'salon'
            ? DEFAULT_RULES.restraint.salonWallChromaMax
            : DEFAULT_RULES.restraint.wallChromaMax
        expect(wall[1]).toBeLessThanOrEqual(limit)
        expect(contrastRatio(text, wall)).toBeGreaterThanOrEqual(4.5)
        expect(theme.reasons.length).toBeGreaterThanOrEqual(9)
      }),
      { numRuns: 400 }
    )
  })
})

describe('generation plan and estimate', () => {
  const readings = SETS.salon!
  const summary = summarize(readings)
  const theme = buildTheme(PROJECT, summary, 1)

  it('estimates images × price and compares with the cap', () => {
    const prices = { stability: 0.04, openai: 0.04, xai: 0.07 }
    expect(estimate('none', 50, prices, { imagesPerBuild: 12, spendCapUsd: 5 })).toEqual({
      provider: 'none',
      images: 0,
      pricePerImageUsd: 0,
      totalUsd: 0,
      withinCap: true
    })
    expect(estimate('xai', 50, prices, { imagesPerBuild: 12, spendCapUsd: 5 })).toEqual({
      provider: 'xai',
      images: 12,
      pricePerImageUsd: 0.07,
      totalUsd: 0.84,
      withinCap: true
    })
    expect(estimate('openai', 50, prices, { imagesPerBuild: 12, spendCapUsd: 0.4 }).withinCap).toBe(false)
    // Never more than three fixed assets plus one companion per photo.
    expect(estimate('stability', 2, prices, { imagesPerBuild: 100, spendCapUsd: 50 }).images).toBe(5)
    expect(estimate('stability', 2, prices, { imagesPerBuild: 0, spendCapUsd: 50 }).images).toBe(0)
  })

  it('plans textures, a backdrop, then companions seeded from the strongest photos', () => {
    const items = plan(theme, summary, readings, 6)
    expect(items.map((i) => i.kind)).toEqual(['texture', 'texture', 'backdrop', 'companion', 'companion', 'companion'])
    expect(items[0]!.surface).toBe('wall')
    expect(items[1]!.surface).toBe('floor')
    expect(items[3]!.seedPhotoIds).toHaveLength(1)
    expect(new Set(items.slice(3).map((i) => i.seedPhotoIds[0])).size).toBe(3)
    expect(plan(theme, summary, readings, 2).map((i) => i.kind)).toEqual(['texture', 'texture'])
    expect(plan(theme, summary, readings, 0)).toEqual([])
  })

  it('ranks seeds by sharpness and spreads them across looks', () => {
    const rs = [
      reading('a', { sharpness: 10, key: 'low' }),
      reading('b', { sharpness: 90, key: 'low' }),
      reading('c', { sharpness: 50, key: 'high' }),
      reading('d', { sharpness: 80, key: 'low' })
    ]
    expect(rankSeeds(rs).map((r) => r.photoId)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('writes prompts in plain words with the palette and no art-speak', () => {
    const texture = buildPrompt('texture', theme, summary, null, 'wall')
    expect(texture).toMatch(/^A seamless, tileable close-up of painted panelling/)
    const backdrop = buildPrompt('backdrop', theme, summary)
    expect(backdrop).toContain('window')
    const companion = buildPrompt('companion', theme, summary, readings[1]!)
    expect(companion).toContain('upright photograph')
    for (const p of [texture, backdrop, companion]) {
      expect(p).not.toMatch(/masterpiece|trending|8k|award/i)
      expect(p.length).toBeLessThan(400)
    }
  })
})
