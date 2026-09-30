import type { EngineEvent, MainEvent, RpcInput, RpcMethod, RpcOutput } from '../shared/rpc'

type NoInput<K extends RpcMethod> = undefined extends RpcInput<K> ? K : never
type WithInput<K extends RpcMethod> = undefined extends RpcInput<K> ? never : K

export interface GalleryApi {
  invoke: {
    <K extends RpcMethod>(method: NoInput<K>): Promise<RpcOutput<K>>
    <K extends RpcMethod>(method: WithInput<K>, input: RpcInput<K>): Promise<RpcOutput<K>>
  }
  onEvent(fn: (event: MainEvent) => void): () => void
  onEngineEvents(fn: (batch: EngineEvent[]) => void): () => void
  /** Turns a dropped File into its path; the renderer never reads file bytes. */
  pathForFile(file: File): string
  platform: string
}

declare global {
  interface Window {
    gallery: GalleryApi
  }
}
