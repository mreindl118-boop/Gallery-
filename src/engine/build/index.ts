import { z } from 'zod'
import { BuildMethods, GeneratorPrices, GeneratorProvider, KeyedProvider } from '@shared/build'
import type { EngineEvent } from '@shared/rpc'
import { Build, type BuildOptions } from './orchestrator'
import { testProvider } from './providers'

export type Handler = (params: unknown) => unknown
export type Broadcast = (event: EngineEvent) => void

export { Build, type BuildOptions, type Credentials } from './orchestrator'

/** What main attaches to every build request: the chosen provider, its key (memory only), prices and limits. */
const Credentials = z
  .object({
    provider: GeneratorProvider,
    key: z.string().nullable(),
    prices: GeneratorPrices,
    limits: z.object({ imagesPerBuild: z.number().int().min(0), spendCapUsd: z.number().min(0) })
  })
  .nullable()
  .optional()

const Base = BuildMethods.status.extend({ credentials: Credentials })
const WithPhoto = BuildMethods.reading.extend({ credentials: Credentials })

/**
 * Build handlers for the engine, registered under 'build.<method>' (see
 * BuildMethods in src/shared/build.ts). Params are validated here.
 */
export function createBuild(broadcast: Broadcast, opts?: BuildOptions): Record<string, Handler> {
  return buildHandlers(new Build(broadcast, opts))
}

export function buildHandlers(build: Build): Record<string, Handler> {
  const project = (p: z.output<typeof Base>) =>
    build.project({ projectId: p.projectId, root: p.root, credentials: p.credentials ?? null })
  const bind =
    <S extends z.ZodType>(schema: S, fn: (p: z.output<S>) => unknown): Handler =>
    (params) =>
      fn(schema.parse(params))
  return {
    status: bind(Base, (p) => project(p).status()),
    start: bind(Base, (p) => project(p).start()),
    pause: bind(Base, (p) => project(p).pause()),
    resume: bind(Base, (p) => project(p).resume()),
    cancel: bind(Base, (p) => project(p).cancel()),
    reading: bind(WithPhoto, (p) => project(p).reading(p.photoId)),
    assets: bind(Base, (p) => project(p).assets()),
    estimate: bind(Base, (p) => project(p).estimate()),
    testProvider: bind(z.object({ provider: KeyedProvider, key: z.string().min(1), prices: GeneratorPrices }), (p) =>
      testProvider(p.provider, p.key, p.prices, build.providerDeps)
    )
  }
}
