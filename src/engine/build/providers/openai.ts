import { promises as fs } from 'node:fs'
import {
  decodeBase64Image,
  defaultSleep,
  MESSAGES,
  PROVIDER_CONFIG,
  ProviderError,
  withRetry,
  type AdapterOptions,
  type GenerateRequest,
  type GenerateResult,
  type Provider
} from './types'

/**
 * OpenAI Images (gpt-image-1): JSON generations, or multipart edits when a
 * seed photo is given. The reply carries base64 in data[0].b64_json.
 */
export class OpenAiProvider implements Provider {
  readonly name = 'openai' as const
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
    return this.cfg.openai.label
  }

  estimate(n: number): number {
    return n * this.opts.pricePerImageUsd
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const c = this.cfg.openai
    const size = c.sizes[req.shape]
    if (req.seedImagePath) {
      const form = new FormData()
      form.set('model', c.model)
      form.set('prompt', req.prompt)
      form.set('n', '1')
      form.set('size', size)
      form.set('quality', c.quality)
      const bytes = await this.readFile(req.seedImagePath)
      form.append('image[]', new Blob([new Uint8Array(bytes)], { type: 'image/webp' }), 'seed.webp')
      return this.post(c.editUrl, { Authorization: `Bearer ${this.opts.key}` }, form)
    }
    return this.post(
      c.generateUrl,
      { Authorization: `Bearer ${this.opts.key}`, 'Content-Type': 'application/json' },
      JSON.stringify({ model: c.model, prompt: req.prompt, n: 1, size, quality: c.quality })
    )
  }

  async test(): Promise<void> {
    const c = this.cfg.openai
    await this.post(
      c.generateUrl,
      { Authorization: `Bearer ${this.opts.key}`, 'Content-Type': 'application/json' },
      JSON.stringify({
        model: c.model,
        prompt: 'a plain matte grey wall',
        n: 1,
        size: c.sizes.square,
        quality: c.testQuality
      })
    )
  }

  private post(url: string, headers: Record<string, string>, body: FormData | string): Promise<GenerateResult> {
    return withRetry(
      this.label,
      this.cfg,
      this.sleep,
      () => this.fetchFn(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.cfg.timeoutMs) }),
      async (res) => {
        const j = (await res.json()) as { data?: { b64_json?: string }[] }
        const b64 = j.data?.[0]?.b64_json
        if (!b64) throw new ProviderError('invalid', MESSAGES.invalid(this.label, 'no image in the reply'))
        return decodeBase64Image(b64)
      }
    )
  }
}
