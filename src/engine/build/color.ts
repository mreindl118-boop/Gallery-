/**
 * Colour math for the reading and theming: sRGB ⇄ linear ⇄ OKLab ⇄ OKLCH,
 * WCAG contrast, gamut clipping and OKLCH strings. Pure functions, no deps.
 * (Björn Ottosson's OKLab, 2020.)
 */

export type Lab = [number, number, number]
/** [L 0–1, C ≥ 0, h degrees 0–360) */
export type Lch = [number, number, number]
export type Rgb = [number, number, number]

const LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export const srgbToLinear = (v: number): number => LINEAR[Math.max(0, Math.min(255, Math.round(v)))]!

export function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}

export function linearToLab(r: number, g: number, b: number): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

export const rgbToLab = (r: number, g: number, b: number): Lab =>
  linearToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b))

export function labToLinear([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

export function labToLch([L, a, b]: Lab): Lch {
  const c = Math.hypot(a, b)
  let h = (Math.atan2(b, a) * 180) / Math.PI
  if (h < 0) h += 360
  return [L, c, c < 1e-6 ? 0 : h]
}

export function lchToLab([L, c, h]: Lch): Lab {
  const rad = (h * Math.PI) / 180
  return [L, c * Math.cos(rad), c * Math.sin(rad)]
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005)

/** The nearest in-gamut sRGB colour with the same lightness and hue (chroma reduced until it fits). */
export function lchToRgb(lch: Lch): Rgb {
  const [L, c, h] = lch
  const Lc = Math.max(0, Math.min(1, L))
  let lin = labToLinear(lchToLab([Lc, c, h]))
  if (!inGamut(lin)) {
    let lo = 0
    let hi = c
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      lin = labToLinear(lchToLab([Lc, mid, h]))
      if (inGamut(lin)) lo = mid
      else hi = mid
    }
    lin = labToLinear(lchToLab([Lc, lo, h]))
  }
  return lin.map((v) => linearToSrgb(Math.max(0, Math.min(1, v)))) as Rgb
}

/** WCAG 2 relative luminance of an sRGB colour. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** WCAG 2 contrast ratio between two OKLCH colours, after gamut clipping. */
export function contrastRatio(a: Lch, b: Lch): number {
  const la = relativeLuminance(lchToRgb(a))
  const lb = relativeLuminance(lchToRgb(b))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const round = (v: number, places: number) => Number(v.toFixed(places))

/** "oklch(0.95 0.012 85)" — CSS Color 4 syntax, as the renderer's tokens use. */
export function oklchString([L, c, h]: Lch): string {
  return `oklch(${round(L, 3)} ${round(c, 4)} ${round(h, 1)})`
}

export function parseOklch(s: string): Lch | null {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(s.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export const hexString = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

/** Shortest signed distance between two hues in degrees. */
export function hueDelta(a: number, b: number): number {
  let d = ((b - a) % 360) + 540
  d = (d % 360) - 180
  return d
}

/** Weighted circular mean of hues; null when the weights cancel out. */
export function meanHue(hues: number[], weights: number[]): number | null {
  let x = 0
  let y = 0
  hues.forEach((h, i) => {
    const w = weights[i] ?? 0
    x += w * Math.cos((h * Math.PI) / 180)
    y += w * Math.sin((h * Math.PI) / 180)
  })
  if (Math.hypot(x, y) < 1e-9) return null
  let h = (Math.atan2(y, x) * 180) / Math.PI
  if (h < 0) h += 360
  return h
}

export const HUE_FAMILIES = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'magenta'] as const
export type HueFamily = (typeof HUE_FAMILIES)[number] | 'neutral'

/** The named family of an OKLCH hue (OKLab hue angles: red ≈ 25°, yellow ≈ 100°, green ≈ 145°, blue ≈ 260°). */
export function hueFamily(h: number): HueFamily {
  const x = ((h % 360) + 360) % 360
  if (x < 50 || x >= 345) return 'red'
  if (x < 80) return 'orange'
  if (x < 115) return 'yellow'
  if (x < 170) return 'green'
  if (x < 225) return 'teal'
  if (x < 285) return 'blue'
  if (x < 320) return 'violet'
  return 'magenta'
}
