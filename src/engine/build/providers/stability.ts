import { promises as fs } from 'node:fs'
import {
  ASPECT,
  decodeBase64Image,
  defaultSleep,
  MESSAGES,
  PROVIDER_CONFIG,
  ProviderError,
  sniff,
  withRetry,
  type AdapterOptions,
  type GenerateRequest,
  type GenerateResult,
  type Provider
} from './types'

/**
 * Stability AI, v2beta Stable Image. Style control (multipart with the seed
 * image) when a seed photo is given, Core generation otherwise. Multipart
 * fields and URLs come from design/providers.json.
 */
export class StabilityProvider implements Provider {
  readonly name = 'stability' as const
  private readonly cfg: AdapterOptions['config'] & object
  private readonly fetchFn: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly readFile: (p: string) => Promise<Buffer>

  constructor(private readonly opts: AdapterOptions) {
    this.cfg = opts.config ?? PROVIDER_CONFIG
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.sleep = opts.sleep ?? defaultSleep
    this.readFile = opts.readFile ?? ((p) => fs.readFile(p))
  }

  private get label(): string {
    return this.cfg.stability.label
  }

  estimate(n: number): number {
    return n * this.opts.pricePerImageUsd
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.key}`, Accept: this.cfg.stability.accept }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const c = this.cfg.stability
    const form = new FormData()
    form.set('prompt', req.prompt)
    form.set('output_format', c.outputFormat)
    form.set('aspect_ratio', ASPECT[req.shape])
    if (req.seed !== undefined) form.set('seed', String(req.seed))
    form.set('negative_prompt', 'text, watermark, logo, frame, border, people, faces')
    let url = c.generateUrl
    if (req.seedImagePath) {
      const bytes = await this.readFile(req.seedImagePath)
      form.set('image', new Blob([new Uint8Array(bytes)], { type: 'image/webp' }), 'seed.webp')
      url = c.styleUrl
    }
    return this.post(url, form)
  }

  async test(): Promise<void> {
    const c = this.cfg.stability
    const form = new FormData()
    form.set('prompt', 'a plain matte grey wall')
    form.set('output_format', 'jpeg')
    form.set('aspect_ratio', c.testAspectRatio)
    await this.post(c.generateUrl, form)
  }

  private post(url: string, form: FormData): Promise<GenerateResult> {
    return withRetry(
      this.label,
      this.cfg,
      this.sleep,
      () =>
        this.fetchFn(url, {
          method: 'POST',
          headers: this.headers(),
          body: form,
          signal: AbortSignal.timeout(this.cfg.timeoutMs)
        }),
      async (res) => {
        const type = res.headers.get('content-type') ?? ''
        if (type.includes('application/json')) {
          const j = (await res.json()) as { image?: string; finish_reason?: string; errors?: string[] }
          if (j.finish_reason && j.finish_reason !== 'SUCCESS')
            throw new ProviderError('filtered', MESSAGES.filtered, res.status)
          if (!j.image) throw new ProviderError('invalid', MESSAGES.invalid(this.label, 'no image in the reply'))
          return decodeBase64Image(j.image)
        }
        const bytes = Buffer.from(await res.arrayBuffer())
        if (res.headers.get('finish-reason') === 'CONTENT_FILTERED')
          throw new ProviderError('filtered', MESSAGES.filtered, res.status)
        return { bytes, format: sniff(bytes) }
      }
    )
  }
}
