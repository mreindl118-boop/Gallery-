import sharp from 'sharp'
import { PhotoReading } from '@shared/build'
import { HUE_FAMILIES, hueFamily, labToLch, rgbToLab, type HueFamily, type Lab } from './color'

/**
 * Reading a photograph (brief §6, rules path): palette, tone, warmth,
 * texture, structure, shape and context from its 512 px thumbnail (a video's
 * poster). Pure math over raw RGB pixels so it is testable on synthetic
 * images; `readThumb` is the sharp loader in front of it.
 */

/** Bump when the maths changes so stored readings get redone. */
export const READING_VERSION = 1
export const READ_SIZE = 256
export const SWATCHES = 6

export interface ReadInput {
  photoId: string
  /** Full-size dimensions, for the shape class. */
  width: number
  height: number
  takenAt: string | null
  gpsLat: number | null
}

export interface Pixels {
  data: Uint8Array | Buffer
  width: number
  height: number
  channels: number
}

/** Decodes a thumbnail to a 256 px RGB raster and reads it. */
export async function readThumb(file: string, input: ReadInput): Promise<PhotoReading> {
  const { data, info } = await sharp(file, { failOn: 'none' })
    .rotate()
    .resize(READ_SIZE, READ_SIZE, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  return analyze({ data, width: info.width, height: info.height, channels: info.channels }, input)
}

/** Small deterministic PRNG (mulberry32) so the same photo always reads the same. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const seedFromId = (id: string) => {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return h >>> 0
}

export function analyze(px: Pixels, input: ReadInput): PhotoReading {
  const { width: w, height: h, channels } = px
  const n = w * h
  const L = new Float32Array(n)
  const A = new Float32Array(n)
  const B = new Float32Array(n)
  const weight = new Float32Array(n)
  let shadows = 0
  let highlights = 0
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const radius = Math.hypot(cx, cy) || 1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const o = i * channels
      const r = px.data[o]!
      const g = px.data[o + 1]!
      const b = px.data[o + 2]!
      const lab = rgbToLab(r, g, b)
      L[i] = lab[0]
      A[i] = lab[1]
      B[i] = lab[2]
      // Centre-weighted: the middle counts about three times the corners.
      const d = Math.hypot(x - cx, y - cy) / radius
      weight[i] = 1 - 0.65 * d * d
      if (Math.max(r, g, b) <= 4) shadows++
      if (Math.min(r, g, b) >= 251) highlights++
    }

  // ----- palette -----------------------------------------------------------
  const swatches = kmeans(L, A, B, weight, SWATCHES, rng(seedFromId(input.photoId)))
  const palette = swatches.map((s) => {
    const [l, c, hue] = labToLch(s.center)
    return { oklch: [r3(l), r4(c), r1(hue)] as [number, number, number], weight: r4(s.weight) }
  })

  // ----- chroma, warmth ----------------------------------------------------
  const chroma = new Float32Array(n)
  let chromaSum = 0
  let wSum = 0
  let aSum = 0
  let bSum = 0
  for (let i = 0; i < n; i++) {
    const c = Math.hypot(A[i]!, B[i]!)
    chroma[i] = c
    chromaSum += c * weight[i]!
    aSum += A[i]! * weight[i]!
    bSum += B[i]! * weight[i]!
    wSum += weight[i]!
  }
  const meanChroma = chromaSum / wSum
  const sortedChroma = Float32Array.from(chroma).sort()
  const maxChroma = quantile(sortedChroma, 0.98)
  const monochrome = meanChroma < 0.02 && quantile(sortedChroma, 0.95) < 0.04
  const warmth = clamp((0.8 * bSum + 0.6 * aSum) / wSum / 0.08, -1, 1)

  const family = dominantHue(palette, meanChroma)

  // ----- tone --------------------------------------------------------------
  const sortedL = Float32Array.from(L).sort()
  const meanL = mean(L)
  const key = meanL < 0.38 ? 'low' : meanL > 0.66 ? 'high' : 'mid'
  const p5 = quantile(sortedL, 0.05)
  const p95 = quantile(sortedL, 0.95)
  const p2 = quantile(sortedL, 0.02)
  const contrast = clamp(p95 - p5, 0, 1)
  const liftedBlacks = p2 > 0.14 && p2 < 0.42 && contrast > 0.08

  // ----- texture and structure (on lightness) ------------------------------
  const tex = texture(L, w, h)
  const shape = shapeClass(input.width, input.height)

  return PhotoReading.parse({
    photoId: input.photoId,
    palette,
    hueFamily: family,
    meanChroma: r4(meanChroma),
    maxChroma: r4(maxChroma),
    key,
    contrast: r3(contrast),
    clipping: { shadows: r4(shadows / n), highlights: r4(highlights / n) },
    liftedBlacks,
    monochrome,
    warmth: r3(warmth),
    edgeDensity: r4(tex.edgeDensity),
    grain: r4(tex.grain),
    sharpness: r3(tex.sharpness),
    orientationEnergy: tex.orientation,
    symmetry: r3(tex.symmetry),
    negativeSpace: r3(tex.negativeSpace),
    horizon: tex.horizon,
    shape,
    timeOfDay: timeOfDay(input.takenAt),
    season: season(input.takenAt, input.gpsLat)
  })
}

// ----- helpers ---------------------------------------------------------------

const r1 = (v: number) => Math.round(v * 10) / 10
const r3 = (v: number) => Math.round(v * 1000) / 1000
const r4 = (v: number) => Math.round(v * 10000) / 10000
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function mean(a: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]!
  return a.length ? s / a.length : 0
}

function quantile(sorted: Float32Array, q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!
}

interface Swatch {
  center: Lab
  weight: number
}

/** Weighted k-means++ in OKLab over every pixel; swatches sorted by weight. */
export function kmeans(
  L: Float32Array,
  A: Float32Array,
  B: Float32Array,
  weight: Float32Array,
  k: number,
  random: () => number
): Swatch[] {
  const n = L.length
  if (n === 0) return []
  const centers: Lab[] = []
  const dist = new Float32Array(n).fill(Number.POSITIVE_INFINITY)
  const pick = (): number => {
    let total = 0
    for (let i = 0; i < n; i++) total += dist[i]! * weight[i]!
    if (total <= 0) return Math.floor(random() * n)
    let r = random() * total
    for (let i = 0; i < n; i++) {
      r -= dist[i]! * weight[i]!
      if (r <= 0) return i
    }
    return n - 1
  }
  const first = Math.floor(random() * n)
  centers.push([L[first]!, A[first]!, B[first]!])
  const updateDist = (c: Lab) => {
    for (let i = 0; i < n; i++) {
      const d = (L[i]! - c[0]) ** 2 + (A[i]! - c[1]) ** 2 + (B[i]! - c[2]) ** 2
      if (d < dist[i]!) dist[i] = d
    }
  }
  updateDist(centers[0]!)
  while (centers.length < k) {
    const i = pick()
    const c: Lab = [L[i]!, A[i]!, B[i]!]
    centers.push(c)
    updateDist(c)
  }
  const assign = new Int32Array(n)
  for (let iter = 0; iter < 12; iter++) {
    let moved = 0
    for (let i = 0; i < n; i++) {
      let best = 0
      let bd = Number.POSITIVE_INFINITY
      for (let j = 0; j < centers.length; j++) {
        const c = centers[j]!
        const d = (L[i]! - c[0]) ** 2 + (A[i]! - c[1]) ** 2 + (B[i]! - c[2]) ** 2
        if (d < bd) {
          bd = d
          best = j
        }
      }
      if (assign[i] !== best) moved++
      assign[i] = best
    }
    const sums = centers.map(() => ({ l: 0, a: 0, b: 0, w: 0 }))
    for (let i = 0; i < n; i++) {
      const s = sums[assign[i]!]!
      const wt = weight[i]!
      s.l += L[i]! * wt
      s.a += A[i]! * wt
      s.b += B[i]! * wt
      s.w += wt
    }
    sums.forEach((s, j) => {
      if (s.w > 0) centers[j] = [s.l / s.w, s.a / s.w, s.b / s.w]
    })
    if (moved === 0 && iter > 0) break
  }
  const weights = centers.map(() => 0)
  let total = 0
  for (let i = 0; i < n; i++) {
    weights[assign[i]!]! += weight[i]!
    total += weight[i]!
  }
  // Merge near-identical centres (flat images) so the weights say what the eye sees.
  const out: Swatch[] = []
  centers.forEach((c, j) => {
    const wgt = weights[j]! / total
    if (wgt <= 0) return
    const near = out.find((o) => Math.hypot(o.center[0] - c[0], o.center[1] - c[1], o.center[2] - c[2]) < 0.012)
    if (near) {
      const t = near.weight + wgt
      near.center = [
        (near.center[0] * near.weight + c[0] * wgt) / t,
        (near.center[1] * near.weight + c[1] * wgt) / t,
        (near.center[2] * near.weight + c[2] * wgt) / t
      ]
      near.weight = t
    } else out.push({ center: c, weight: wgt })
  })
  return out.sort((a, b) => b.weight - a.weight)
}

function dominantHue(palette: PhotoReading['palette'], meanChroma: number): HueFamily {
  const chromatic = palette.filter((p) => p.oklch[1] >= 0.03)
  if (meanChroma < 0.015 || chromatic.length === 0) return 'neutral'
  const votes = new Map<HueFamily, number>()
  for (const p of chromatic) {
    const f = hueFamily(p.oklch[2])
    votes.set(f, (votes.get(f) ?? 0) + p.weight * p.oklch[1])
  }
  let best: HueFamily = 'neutral'
  let bw = 0
  for (const f of HUE_FAMILIES) {
    const v = votes.get(f) ?? 0
    if (v > bw) {
      bw = v
      best = f
    }
  }
  return best
}

export function shapeClass(width: number, height: number): PhotoReading['shape'] {
  const r = width / Math.max(1, height)
  if (r >= 2.4) return 'panorama'
  if (r <= 1 / 2.4) return 'vertical-panorama'
  if (r > 0.95 && r < 1.05) return 'square'
  return r > 1 ? 'landscape' : 'portrait'
}

interface Texture {
  edgeDensity: number
  grain: number
  sharpness: number
  orientation: { horizontal: number; vertical: number; diagonal: number }
  symmetry: number
  negativeSpace: number
  horizon: boolean
}

/** Gradients, Laplacian, blocks and mirrors over the lightness plane (0–1). */
export function texture(L: Float32Array, w: number, h: number): Texture {
  const at = (x: number, y: number) => L[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!
  const gx = new Float32Array(w * h)
  const gy = new Float32Array(w * h)
  const mag = new Float32Array(w * h)
  let lapSum = 0
  let lapSq = 0
  let eH = 0
  let eV = 0
  let eD = 0
  let edges = 0
  const EDGE = 0.08
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const sx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const sy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      gx[i] = sx / 4
      gy[i] = sy / 4
      const m = Math.hypot(gx[i]!, gy[i]!)
      mag[i] = m
      if (m > EDGE) edges++
      if (m > 0.02) {
        // Gradient direction: a horizontal edge has a vertical gradient.
        const ang = Math.abs((Math.atan2(sy, sx) * 180) / Math.PI) % 180
        const dist90 = Math.abs(ang - 90)
        if (dist90 <= 22.5) eH += m
        else if (ang <= 22.5 || ang >= 157.5) eV += m
        else eD += m
      }
      const lap = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) - 4 * at(x, y)) * 100
      lapSum += lap
      lapSq += lap * lap
    }
  const n = w * h
  const lapVar = lapSq / n - (lapSum / n) ** 2
  const eSum = eH + eV + eD || 1
  const orientation = {
    horizontal: r3(eH / eSum),
    vertical: r3(eV / eSum),
    diagonal: r3(eD / eSum)
  }

  // Grain: residual against a 3×3 box blur, measured where there are no edges.
  const residuals: number[] = []
  for (let y = 1; y < h - 1; y += 2)
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x
      if (mag[i]! > 0.03) continue
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += at(x + dx, y + dy)
      residuals.push(Math.abs(at(x, y) - s / 9))
    }
  residuals.sort((a, b) => a - b)
  const grain = residuals.length ? residuals[Math.floor(residuals.length * 0.5)]! * 2 : 0

  // Negative space: share of 16 px blocks that are flat.
  const bs = 16
  let flat = 0
  let blocks = 0
  for (let by = 0; by + bs <= h; by += bs)
    for (let bx = 0; bx + bs <= w; bx += bs) {
      let s = 0
      let sq = 0
      let em = 0
      for (let y = by; y < by + bs; y++)
        for (let x = bx; x < bx + bs; x++) {
          const v = L[y * w + x]!
          s += v
          sq += v * v
          em += mag[y * w + x]!
        }
      const cnt = bs * bs
      const sd = Math.sqrt(Math.max(0, sq / cnt - (s / cnt) ** 2))
      blocks++
      if (sd < 0.03 && em / cnt < 0.02) flat++
    }
  const negativeSpace = blocks ? flat / blocks : 1

  // Bilateral symmetry: left half against the mirrored right half.
  let diff = 0
  let cnt = 0
  const half = Math.floor(w / 2)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < half; x++) {
      diff += Math.abs(L[y * w + x]! - L[y * w + (w - 1 - x)]!)
      cnt++
    }
  const symmetry = cnt ? clamp(1 - diff / cnt / 0.2, 0, 1) : 1

  // Horizon: one row band in the middle 15–85 % where a horizontal edge crosses most of the width.
  let horizon = false
  const rowCover = new Float32Array(h)
  for (let y = 0; y < h; y++) {
    let c = 0
    for (let x = 0; x < w; x++)
      if (Math.abs(gy[y * w + x]!) > 0.03 && Math.abs(gy[y * w + x]!) > 2 * Math.abs(gx[y * w + x]!)) c++
    rowCover[y] = c / w
  }
  const yLo = Math.floor(h * 0.15)
  const yHi = Math.ceil(h * 0.85)
  for (let y = yLo; y < yHi && !horizon; y++) if (rowCover[y]! >= 0.6) horizon = true

  return {
    edgeDensity: edges / n,
    grain,
    sharpness: lapVar,
    orientation,
    symmetry,
    negativeSpace,
    horizon
  }
}

/** Local clock time from the ISO string itself (the camera's clock), not the machine's zone. */
export function timeOfDay(takenAt: string | null): PhotoReading['timeOfDay'] {
  const m = takenAt && /T(\d{2}):(\d{2})/.exec(takenAt)
  if (!m) return null
  const hour = Number(m[1]) + Number(m[2]) / 60
  if (hour >= 5 && hour < 7.5) return 'dawn'
  if (hour >= 7.5 && hour < 17) return 'day'
  if (hour >= 17 && hour < 19.5) return 'golden'
  if (hour >= 19.5 && hour < 21) return 'blue-hour'
  return 'night'
}

export function season(takenAt: string | null, gpsLat: number | null): PhotoReading['season'] {
  const m = takenAt && /^\d{4}-(\d{2})/.exec(takenAt)
  if (!m) return null
  let month = Number(m[1])
  if (gpsLat !== null && gpsLat < 0) month = ((month + 5) % 12) + 1
  if (month >= 3 && month <= 5) return 'spring'
  if (month >= 6 && month <= 8) return 'summer'
  if (month >= 9 && month <= 11) return 'autumn'
  return 'winter'
}
