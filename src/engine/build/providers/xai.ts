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
 * xAI image generation (grok-2-image). No image input and no size choice:
 * the prompt carries the palette and subject, which the prompt builder
 * already does.
 */
export class XaiProvider implements Provider {
  readonly name = 'xai' as const
  private readonly cfg: AdapterOptions['config'] & object
  private readonly fetchFn: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: AdapterOptions) {
    this.cfg = opts.config ?? PROVIDER_CONFIG
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.sleep = opts.sleep ?? defaultSleep
  }

  private get label(): string {
    return this.cfg.xai.label
  }

  estimate(n: number): number {
    return n * this.opts.pricePerImageUsd
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.post(req.prompt)
  }

  async test(): Promise<void> {
    await this.post('a plain matte grey wall')
  }

  private post(prompt: string): Promise<GenerateResult> {
    const c = this.cfg.xai
    return withRetry(
      this.label,
      this.cfg,
      this.sleep,
      () =>
        this.fetchFn(c.generateUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.opts.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: c.model, prompt, n: 1, response_format: c.responseFormat }),
          signal: AbortSignal.timeout(this.cfg.timeoutMs)
        }),
      async (res) => {
        const j = (await res.json()) as { data?: { b64_json?: string }[] }
        const b64 = j.data?.[0]?.b64_json
        if (!b64) throw new ProviderError('invalid', MESSAGES.invalid(this.label, 'no image in the reply'))
        return decodeBase64Image(b64)
      }
    )
  }
}
