import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  GalleryError,
  RPC_CHANNEL,
  rpcContract,
  type RpcInput,
  type RpcMethod,
  type RpcOutput,
  type RpcResult
} from '@shared/rpc'

export type RpcImpl = {
  [K in RpcMethod]: (
    input: z.output<(typeof rpcContract)[K]['input']>,
    event: IpcMainInvokeEvent
  ) => Promise<RpcOutput<K>> | RpcOutput<K>
}

/**
 * One IPC channel for every method. Main is the trust boundary: the sender
 * must be one of our own frames and every input is parsed with its schema
 * before an implementation sees it. Errors come back as values because
 * Electron strips custom fields from thrown errors.
 */
export function registerRpc(impl: RpcImpl, isTrustedSender: (e: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle(RPC_CHANNEL, async (event, method: unknown, input: unknown): Promise<RpcResult<unknown>> => {
    if (!isTrustedSender(event)) return fail('forbidden', 'Request from an unknown frame.')
    if (typeof method !== 'string' || !(method in rpcContract))
      return fail('unknown-method', `Unknown method ${String(method)}`)
    const key = method as RpcMethod
    const spec = rpcContract[key]
    const parsed = spec.input.safeParse(input)
    if (!parsed.success) return fail('invalid-input', z.prettifyError(parsed.error))
    try {
      const fn = impl[key] as (i: unknown, e: IpcMainInvokeEvent) => unknown
      const value = await fn(parsed.data, event)
      return { ok: true, value }
    } catch (err) {
      if (err instanceof GalleryError) return fail(err.code, err.message)
      console.error(`[rpc] ${key} failed`, err)
      return fail('internal', err instanceof Error ? err.message : String(err))
    }
  })
}

function fail(code: string, message: string): RpcResult<never> {
  return { ok: false, error: { code, message } }
}

export type { RpcInput }
