import type { EngineEvent } from '@shared/rpc'

export type Handler = (params: unknown) => unknown
export type Broadcast = (event: EngineEvent) => void

/**
 * Ingest handlers for the engine, registered under 'ingest.<method>' (see
 * IngestMethods in src/shared/ingest.ts). Placeholder until the pipeline lands.
 */
export function createIngest(_broadcast: Broadcast): Record<string, Handler> {
  return {}
}
