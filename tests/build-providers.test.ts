import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createProvider, MESSAGES, PROVIDER_CONFIG, ProviderError, testProvider } from '../src/engine/build/providers'
import { mapHttpError } from '../src/engine/build/providers/types'

/**
 * Adapters against a scripted fetch: request shape, auth header, decoding,
 * error mapping and retry. The real hosts are never contacted.
 */

const PRICES = { stability: 0.04, openai: 0.04, xai: 0.07 }
const KEY = 'sk-test-secret-key'

type Call = { url: string; init: RequestInit }
type Script = (call: Call, n: number) => Response | Promise<Response>

function fakeFetch(script: Script) {
  const calls: Call[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return script(call, calls.length)
  }) as typeof fetch
  return { calls, fetchFn }
}

const png = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
    .png()
    .toBuffer()
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sleeps: number[] = []
const deps = (fetchFn: typeof fetch) => ({
  fetch: fetchFn,
  sleep: async (ms: number) => {
    sleeps.push(ms)
  },
  readFile: async () => png()
})

const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name]

describe('stability', () => {
  it('posts multipart to the style endpoint with the seed image and decodes JSON base64', async () => {
    const bytes = await png()
    const { calls, fetchFn } = fakeFetch(() =>
      json({ image: bytes.toString('base64'), finish_reason: 'SUCCESS', seed: 1 })
    )
    const p = createProvider('stability', KEY, PRICES, deps(fetchFn))
    const out = await p.generate({
      prompt: 'a wall',
      seedImagePath: '/x/seed.webp',
      kind: 'companion',
      shape: 'landscape',
      seed: 5
    })
    expect(out.format).toBe('png')
    expect(out.bytes.equals(bytes)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(PROVIDER_CONFIG.stability.styleUrl)
    expect(header(calls[0]!, 'Authorization')).toBe(`Bearer ${KEY}`)
    const form = calls[0]!.init.body as FormData
    expect(form.get('prompt')).toBe('a wall')
    expect(form.get('aspect_ratio')).toBe('3:2')
    expect(form.get('seed')).toBe('5')
    expect(form.get('output_format')).toBe('png')
    expect((form.get('image') as Blob).size).toBe(bytes.length)
    expect(p.estimate(3)).toBeCloseTo(0.12)
  })

  it('uses the core endpoint without a seed image and reads raw image bytes', async () => {
    const bytes = await png()
    const { calls, fetchFn } = fakeFetch(
      () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
    )
    const out = await createProvider('stability', KEY, PRICES, deps(fetchFn)).generate({
      prompt: 'a wall',
      seedImagePath: null,
      kind: 'texture',
      shape: 'square'
    })
    expect(out.format).toBe('png')
    expect(calls[0]!.url).toBe(PROVIDER_CONFIG.stability.generateUrl)
    expect((calls[0]!.init.body as FormData).has('image')).toBe(false)
  })

  it('treats a non-SUCCESS finish reason as filtered', async () => {
    const { fetchFn } = fakeFetch(() => json({ image: '', finish_reason: 'CONTENT_FILTERED' }))
    await expect(
      createProvider('stability', KEY, PRICES, deps(fetchFn)).generate({
        prompt: 'x',
        seedImagePath: null,
        kind: 'backdrop',
        shape: 'landscape'
      })
    ).rejects.toMatchObject({ kind: 'filtered', message: MESSAGES.filtered })
  })
})

describe('openai', () => {
  it('posts JSON generations and decodes data[0].b64_json', async () => {
    const bytes = await png()
    const { calls, fetchFn } = fakeFetch(() => json({ data: [{ b64_json: bytes.toString('base64') }] }))
    const out = await createProvider('openai', KEY, PRICES, deps(fetchFn)).generate({
      prompt: 'a view',
      seedImagePath: null,
      kind: 'backdrop',
      shape: 'landscape'
    })
    expect(out.bytes.equals(bytes)).toBe(true)
    expect(calls[0]!.url).toBe(PROVIDER_CONFIG.openai.generateUrl)
    expect(header(calls[0]!, 'Authorization')).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body).toMatchObject({ model: 'gpt-image-1', prompt: 'a view', n: 1, size: '1536x1024' })
  })

  it('posts multipart edits with image[] when seeded', async () => {
    const bytes = await png()
    const { calls, fetchFn } = fakeFetch(() => json({ data: [{ b64_json: bytes.toString('base64') }] }))
    await createProvider('openai', KEY, PRICES, deps(fetchFn)).generate({
      prompt: 'like this',
      seedImagePath: '/x/seed.webp',
      kind: 'companion',
      shape: 'portrait'
    })
    expect(calls[0]!.url).toBe(PROVIDER_CONFIG.openai.editUrl)
    const form = calls[0]!.init.body as FormData
    expect(form.getAll('image[]')).toHaveLength(1)
    expect(form.get('size')).toBe('1024x1536')
  })

  it('maps 401 to the rejected-key message without retrying', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ error: { message: 'Incorrect API key provided: sk-***' } }, 401))
    const r = await testProvider('openai', KEY, PRICES, deps(fetchFn))
    expect(r).toEqual({ ok: false, message: MESSAGES.rejected })
    expect(calls).toHaveLength(1)
    expect(r.message).not.toContain(KEY)
  })

  it('retries 429 with backoff, then succeeds', async () => {
    sleeps.length = 0
    const bytes = await png()
    const { calls, fetchFn } = fakeFetch((_c, n) =>
      n < 3 ? json({ error: { message: 'Rate limit' } }, 429) : json({ data: [{ b64_json: bytes.toString('base64') }] })
    )
    const r = await testProvider('openai', KEY, PRICES, deps(fetchFn))
    expect(r.ok).toBe(true)
    expect(r.message).toContain('works')
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([1500, 3000])
  })

  it('gives up on a persistent 429 with a plain message', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({}, 429))
    const r = await testProvider('openai', KEY, PRICES, deps(fetchFn))
    expect(r).toEqual({ ok: false, message: MESSAGES.rateLimited('OpenAI') })
    expect(calls).toHaveLength(PROVIDER_CONFIG.retry.attempts)
  })

  it('maps content moderation to filtered and billing to payment', async () => {
    const filtered = fakeFetch(() =>
      json({ error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }, 400)
    )
    await expect(
      createProvider('openai', KEY, PRICES, deps(filtered.fetchFn)).generate({
        prompt: 'x',
        seedImagePath: null,
        kind: 'backdrop',
        shape: 'square'
      })
    ).rejects.toMatchObject({ kind: 'filtered' })
    const billing = fakeFetch(() =>
      json({ error: { code: 'billing_hard_limit_reached', message: 'Billing hard limit' } }, 400)
    )
    const r = await testProvider('openai', KEY, PRICES, deps(billing.fetchFn))
    expect(r).toEqual({ ok: false, message: MESSAGES.payment('OpenAI') })
  })

  it('reports an unreachable host plainly', async () => {
    const { fetchFn } = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })
    const r = await testProvider('openai', KEY, PRICES, deps(fetchFn))
    expect(r).toEqual({ ok: false, message: MESSAGES.network('OpenAI') })
  })
})

describe('xai', () => {
  it('posts JSON with b64_json response format and decodes it', async () => {
    const bytes = await png()
    const { calls, fetchFn } = fakeFetch(() => json({ data: [{ b64_json: bytes.toString('base64') }] }))
    const out = await createProvider('xai', KEY, PRICES, deps(fetchFn)).generate({
      prompt: 'a calm scene',
      seedImagePath: '/ignored.webp',
      kind: 'companion',
      shape: 'landscape'
    })
    expect(out.bytes.equals(bytes)).toBe(true)
    expect(calls[0]!.url).toBe(PROVIDER_CONFIG.xai.generateUrl)
    expect(header(calls[0]!, 'Authorization')).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: 'grok-2-image',
      prompt: 'a calm scene',
      n: 1,
      response_format: 'b64_json'
    })
  })

  it('402 is a credit problem', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'Payment required' }, 402))
    const r = await testProvider('xai', KEY, PRICES, deps(fetchFn))
    expect(r).toEqual({ ok: false, message: MESSAGES.payment('xAI') })
  })
})

describe('error mapping', () => {
  it('covers every status family', () => {
    expect(mapHttpError('P', 403, '').kind).toBe('unauthorized')
    expect(mapHttpError('P', 400, '{"message":"insufficient_credits"}').kind).toBe('payment')
    expect(mapHttpError('P', 500, '').kind).toBe('other')
    expect(mapHttpError('P', 422, '{"errors":["aspect_ratio is invalid"]}')).toMatchObject({
      kind: 'invalid',
      message: 'P didn’t accept the request (aspect_ratio is invalid). Check design/providers.json or report this.'
    })
    expect(new ProviderError('other', 'm')).toBeInstanceOf(Error)
  })
})
