import type { EngineEvent } from '@shared/rpc'
import { BuildProgress } from '@shared/build'

export type Handler = (params: unknown) => unknown
export type Broadcast = (event: EngineEvent) => void

/** Placeholder until the build pipeline lands: every project reports idle. */
export function createBuild(_broadcast: Broadcast): Record<string, Handler> {
  const idle = (params: unknown): BuildProgress =>
    BuildProgress.parse({
      projectId: (params as { projectId: string }).projectId,
      state: 'idle',
      stage: null,
      stageFraction: 0,
      fraction: 0,
      status: 'Not built yet.',
      message: null,
      completed: [],
      startedAt: null,
      finishedAt: null
    })
  return {
    status: idle,
    start: idle,
    pause: idle,
    resume: idle,
    cancel: idle,
    reading: () => null,
    assets: () => [],
    estimate: (params) => {
      const p = params as {
        credentials: {
          provider: string
          prices: Record<string, number>
          limits: { imagesPerBuild: number; spendCapUsd: number }
        } | null
      }
      if (!p.credentials) return { provider: 'none', images: 0, pricePerImageUsd: 0, totalUsd: 0, withinCap: true }
      const price = p.credentials.prices[p.credentials.provider] ?? 0
      const total = price * p.credentials.limits.imagesPerBuild
      return {
        provider: p.credentials.provider,
        images: p.credentials.limits.imagesPerBuild,
        pricePerImageUsd: price,
        totalUsd: total,
        withinCap: total <= p.credentials.limits.spendCapUsd
      }
    },
    testProvider: () => ({ ok: false, message: 'Checking a key isn’t available in this version yet.' })
  }
}
