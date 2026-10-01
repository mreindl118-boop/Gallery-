import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import {
  DEFAULT_PRICES,
  GeneratorPrices,
  GeneratorSettings,
  type GeneratorProvider,
  type KeyedProvider
} from '@shared/build'
import { GalleryError } from '@shared/rpc'
import { readJsonVersioned, writeJsonAtomic } from '@shared/node/atomic-json'
import { z } from 'zod'

const StoredFile = z.object({
  schemaVersion: z.literal(1),
  provider: GeneratorSettings.shape.provider,
  imagesPerBuild: GeneratorSettings.shape.imagesPerBuild,
  spendCapUsd: GeneratorSettings.shape.spendCapUsd,
  /** Keys encrypted with Electron safeStorage (DPAPI on Windows), base64. */
  keys: z
    .object({ stability: z.string().optional(), openai: z.string().optional(), xai: z.string().optional() })
    .default({})
})
type Stored = z.infer<typeof StoredFile>

/**
 * Generator provider choice, limits and API keys, in userData only. Keys are
 * encrypted at rest with the OS keychain and never leave main except inside
 * the request the engine makes on the user's behalf.
 */
export class GeneratorStore {
  private readonly file = join(app.getPath('userData'), 'generator.json')
  private readonly pricesFile = join(app.getPath('userData'), 'generator-prices.json')
  private state: Stored = { schemaVersion: 1, provider: 'none', imagesPerBuild: 12, spendCapUsd: 5, keys: {} }

  async load(): Promise<void> {
    try {
      this.state = (await readJsonVersioned(this.file, StoredFile, 1)) ?? this.state
    } catch {
      // A damaged file means starting over with no provider; keys would be unreadable anyway.
    }
  }

  settings(): GeneratorSettings {
    return {
      provider: this.state.provider,
      hasKey: {
        stability: !!this.state.keys.stability,
        openai: !!this.state.keys.openai,
        xai: !!this.state.keys.xai
      },
      imagesPerBuild: this.state.imagesPerBuild,
      spendCapUsd: this.state.spendCapUsd
    }
  }

  private async save(): Promise<GeneratorSettings> {
    await writeJsonAtomic(this.file, this.state)
    return this.settings()
  }

  setProvider(provider: GeneratorProvider): Promise<GeneratorSettings> {
    this.state = { ...this.state, provider }
    return this.save()
  }

  setLimits(imagesPerBuild: number, spendCapUsd: number): Promise<GeneratorSettings> {
    this.state = { ...this.state, imagesPerBuild, spendCapUsd }
    return this.save()
  }

  setKey(provider: KeyedProvider, key: string): Promise<GeneratorSettings> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new GalleryError(
        'no-keychain',
        'Windows couldn’t encrypt the key for storage, so it wasn’t saved. Sign in to a Windows account with a password and try again.'
      )
    }
    const sealed = safeStorage.encryptString(key.trim()).toString('base64')
    this.state = { ...this.state, keys: { ...this.state.keys, [provider]: sealed } }
    return this.save()
  }

  clearKey(provider: KeyedProvider): Promise<GeneratorSettings> {
    const keys = { ...this.state.keys }
    delete keys[provider]
    this.state = { ...this.state, keys }
    return this.save()
  }

  /** The plain key for one request; null when none is stored. */
  key(provider: KeyedProvider): string | null {
    const sealed = this.state.keys[provider]
    if (!sealed) return null
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
    } catch {
      return null
    }
  }

  async prices(): Promise<GeneratorPrices> {
    try {
      const raw = JSON.parse(await fs.readFile(this.pricesFile, 'utf8')) as unknown
      return GeneratorPrices.parse({ ...DEFAULT_PRICES, ...(raw as object) })
    } catch {
      await writeJsonAtomic(this.pricesFile, DEFAULT_PRICES).catch(() => undefined)
      return DEFAULT_PRICES
    }
  }
}
