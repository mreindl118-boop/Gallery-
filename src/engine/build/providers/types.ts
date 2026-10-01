import type { GeneratedAsset, KeyedProvider } from '@shared/build'
import providersJson from '../../../../design/providers.json'

/**
 * What every image provider looks like to the build, and how their failures
 * are told to the user. Adapters use global fetch with the key in the
 * Authorization header only; the key is never logged, stored or echoed.
 */

export type AssetKind = GeneratedAsset['kind']
export type Shape = 'square' | 'landscape' | 'portrait'

export interface GenerateRequest {
  prompt: string
  /** A photo to take the style from; adapters without image input ignore it. */
  seedImagePath: string | null
  kind: AssetKind
  shape: Shape
  seed?: number
}

export interface GenerateResult {
  bytes: Buffer
  /** 'png' or 'webp' or 'jpeg'; what the provider returned. */
  format: 'png' | 'webp' | 'jpeg'
}

export interface Provider {
  readonly name: KeyedProvider
  /** Cost in USD for `n` images at the configured price. */
  estimate(n: number): number
  generate(req: GenerateRequest): Promise<GenerateResult>
  /** The cheapest real request that proves the key works. */
  test(): Promise<void>
}

export type ProviderErrorKind =
  'unauthorized' | 'payment' | 'rate-limited' | 'filtered' | 'network' | 'invalid' | 'other'

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null = null
  ) {
    super(message)
  }
}

export const PROVIDER_CONFIG = providersJson
export type ProvidersConfig = typeof providersJson

export interface AdapterOptions {
  key: string
  pricePerImageUsd: number
  config?: ProvidersConfig
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Reads a seed image from disk (tests inject one). */
  readFile?: (path: string) => Promise<Buffer>
}

export const MESSAGES = {
  rejected: 'The key was rejected. Check it in Settings.',
  payment: (label: string) => `The ${label} account has no credit left. Add credit on their site, then try again.`,
  rateLimited: (label: string) => `${label} is limiting requests right now. Wait a few minutes, then try again.`,
  filtered: 'The provider declined this image, so it was skipped.',
  network: (label: string) => `galleryLAB couldn’t reach ${label}. Check the connection, then try again.`,
  invalid: (label: string, detail: string) =>
    `${label} didn’t accept the request${detail ? ` (${detail})` : ''}. Check design/providers.json or report this.`,
  other: (label: string, status: number) => `${label} returned an error (${status}). Try again later.`
}

const FILTER_WORDS =
  /content[_ -]?(policy|filter|moderation)|safety system|moderation_blocked|CONTENT_FILTERED|flagged/i
const CREDIT_WORDS = /insufficient[_ ]?(credits?|balance|funds)|billing|quota|payment required/i

/** Maps an HTTP failure to a plain message. `body` is the response text (never the request). */
export function mapHttpError(label: string, status: number, body: string): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('unauthorized', MESSAGES.rejected, status)
  if (status === 402 || CREDIT_WORDS.test(body)) return new ProviderError('payment', MESSAGES.payment(label), status)
  if (status === 429) return new ProviderError('rate-limited', MESSAGES.rateLimited(label), status)
  if (FILTER_WORDS.test(body)) return new ProviderError('filtered', MESSAGES.filtered, status)
  if (status === 400 || status === 422) {
    const detail = shortDetail(body)
    return new ProviderError('invalid', MESSAGES.invalid(label, detail), status)
  }
  if (status >= 500) return new ProviderError('other', MESSAGES.other(label, status), status)
  return new ProviderError('other', MESSAGES.other(label, status), status)
}

/** A short, key-free excerpt of an error body for the "didn't accept the request" message. */
function shortDetail(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string; errors?: string[] }
    const m =
      (typeof j.error === 'object' && j.error?.message) ||
      (typeof j.error === 'string' && j.error) ||
      j.message ||
      j.errors?.[0]
    if (typeof m === 'string') return m.slice(0, 120)
  } catch {
    // not JSON
  }
  return ''
}

/** Runs a request, retrying 429 and 5xx with backoff; everything else maps once. */
export async function withRetry<T>(
  label: string,
  config: ProvidersConfig,
  sleep: (ms: number) => Promise<void>,
  attempt: () => Promise<Response>,
  decode: (res: Response) => Promise<T>
): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs } = config.retry
  let last: ProviderError | null = null
  for (let i = 0; i < attempts; i++) {
    let res: Response
    try {
      res = await attempt()
    } catch (err) {
      if (err instanceof ProviderError) throw err
      last = new ProviderError('network', MESSAGES.network(label))
      if (i < attempts - 1) await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** i))
      continue
    }
    if (res.ok) return decode(res)
    const body = await res.text().catch(() => '')
    const mapped = mapHttpError(label, res.status, body)
    if (mapped.kind !== 'rate-limited' && !(res.status >= 500)) throw mapped
    last = mapped
    if (i < attempts - 1) await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** i))
  }
  throw last ?? new ProviderError('other', MESSAGES.other(label, 0))
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Decodes a base64 image, sniffing its container. */
export function decodeBase64Image(b64: string): GenerateResult {
  const bytes = Buffer.from(b64, 'base64')
  return { bytes, format: sniff(bytes) }
}

export function sniff(bytes: Buffer): GenerateResult['format'] {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'png'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP')
    return 'webp'
  return 'jpeg'
}

export const ASPECT: Record<Shape, string> = { square: '1:1', landscape: '3:2', portrait: '2:3' }
