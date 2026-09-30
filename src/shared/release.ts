import { z } from 'zod'

/**
 * Where published builds live: this repository's own GitHub Releases, which
 * must be public so installed apps can fetch updates without a token. Must
 * match `publish` in electron-builder.yml (a test checks).
 */
export const RELEASES_REPO = { owner: 'mreindl118-boop', repo: 'Gallery-' } as const

export const releasesPageUrl = (): string => `https://github.com/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases`

/** The portable build's update feed, published next to the NSIS latest.yml. */
export const PORTABLE_FEED_FILE = 'latest-portable.json'

export const PortableFeed = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  /** File name of the portable exe in the same release. */
  file: z
    .string()
    .min(1)
    .regex(/^[^/\\:]+\.exe$/, 'Must be a bare .exe file name'),
  size: z.number().int().positive(),
  /** Base64 SHA-512 of the file, the same encoding electron-updater uses in latest.yml. */
  sha512: z.string().min(80),
  releaseDate: z.string()
})
export type PortableFeed = z.infer<typeof PortableFeed>

/** URLs for the portable feed and its exe, for the public releases repo or a test feed base URL. */
export function portableFeedUrls(feedBase: string | null, version?: string, file?: string) {
  if (feedBase) {
    const base = feedBase.endsWith('/') ? feedBase : `${feedBase}/`
    return {
      feed: `${base}${PORTABLE_FEED_FILE}`,
      asset: file ? `${base}${encodeURIComponent(file)}` : null
    }
  }
  const root = `https://github.com/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases`
  return {
    feed: `${root}/latest/download/${PORTABLE_FEED_FILE}`,
    asset: version && file ? `${root}/download/v${version}/${encodeURIComponent(file)}` : null
  }
}

/**
 * Compare semantic versions (major.minor.patch with optional prerelease).
 * Returns >0 when a is newer than b. A prerelease sorts before its release.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2) as [string, string | undefined]
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = pa.nums[i]! - pb.nums[i]!
    if (d !== 0) return d
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === undefined) return 1
  if (pb.pre === undefined) return -1
  const xa = pa.pre.split('.')
  const xb = pb.pre.split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const sa = xa[i]
    const sb = xb[i]
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    const na = /^\d+$/.test(sa) ? Number(sa) : NaN
    const nb = /^\d+$/.test(sb) ? Number(sb) : NaN
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1
    }
  }
  return 0
}
