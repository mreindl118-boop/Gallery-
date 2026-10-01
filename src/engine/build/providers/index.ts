import type { GeneratorPrices, KeyedProvider } from '@shared/build'
import { OpenAiProvider } from './openai'
import { StabilityProvider } from './stability'
import { PROVIDER_CONFIG, ProviderError, type AdapterOptions, type Provider } from './types'
import { XaiProvider } from './xai'

export { ProviderError, MESSAGES, PROVIDER_CONFIG } from './types'
export type { Provider, GenerateRequest, GenerateResult, AssetKind, Shape, AdapterOptions } from './types'

export type ProviderDeps = Pick<AdapterOptions, 'config' | 'fetch' | 'sleep' | 'readFile'>

export function createProvider(
  name: KeyedProvider,
  key: string,
  prices: GeneratorPrices,
  deps: ProviderDeps = {}
): Provider {
  const opts: AdapterOptions = { key, pricePerImageUsd: prices[name], ...deps }
  switch (name) {
    case 'stability':
      return new StabilityProvider(opts)
    case 'openai':
      return new OpenAiProvider(opts)
    case 'xai':
      return new XaiProvider(opts)
  }
}

export const providerLabel = (name: KeyedProvider, config = PROVIDER_CONFIG): string => config[name].label

/** Proves a key with the cheapest real call; the message is for the Settings screen. */
export async function testProvider(
  name: KeyedProvider,
  key: string,
  prices: GeneratorPrices,
  deps: ProviderDeps = {}
): Promise<{ ok: boolean; message: string }> {
  const label = providerLabel(name, deps.config)
  try {
    await createProvider(name, key, prices, deps).test()
    const price = prices[name]
    return {
      ok: true,
      message: `The ${label} key works. One test image was made (about $${price.toFixed(2)}).`
    }
  } catch (err) {
    if (err instanceof ProviderError) return { ok: false, message: err.message }
    return { ok: false, message: `Checking the ${label} key failed. Try again in a moment.` }
  }
}
