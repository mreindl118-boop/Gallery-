import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  ENGINE_PORT_CHANNEL,
  EngineEventBatch,
  EVENT_CHANNEL,
  MainEvent,
  RPC_CHANNEL,
  rpcContract,
  type EngineEvent,
  type RpcMethod,
  type RpcResult
} from '@shared/rpc'
import type { GalleryApi } from './api'

/**
 * The only door between the renderer and the rest of the app. Inputs are
 * validated here for early, readable errors and again in main, which is the
 * real trust boundary. Events are parsed before they reach page code.
 */
const mainListeners = new Set<(e: MainEvent) => void>()
const engineListeners = new Set<(batch: EngineEvent[]) => void>()

ipcRenderer.on(EVENT_CHANNEL, (_e, raw: unknown) => {
  const parsed = MainEvent.safeParse(raw)
  if (!parsed.success) return
  for (const fn of mainListeners) fn(parsed.data)
})

ipcRenderer.on(ENGINE_PORT_CHANNEL, (e) => {
  const port = e.ports[0]
  if (!port) return
  port.onmessage = (msg: { data: unknown }) => {
    const parsed = EngineEventBatch.safeParse(msg.data)
    if (!parsed.success) return
    for (const fn of engineListeners) fn(parsed.data)
  }
  port.start()
})

async function invoke(method: RpcMethod, input?: unknown): Promise<unknown> {
  const spec = rpcContract[method]
  const checked = spec.input.safeParse(input)
  if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'Invalid input')
  const res = (await ipcRenderer.invoke(RPC_CHANNEL, method, checked.data)) as RpcResult<unknown>
  if (res.ok) return res.value
  const err = new Error(res.error.message)
  err.name = res.error.code
  throw err
}

const api: GalleryApi = {
  invoke: invoke as GalleryApi['invoke'],
  onEvent(fn) {
    mainListeners.add(fn)
    return () => mainListeners.delete(fn)
  },
  onEngineEvents(fn) {
    engineListeners.add(fn)
    return () => engineListeners.delete(fn)
  },
  pathForFile(file) {
    return webUtils.getPathForFile(file)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('gallery', api)
