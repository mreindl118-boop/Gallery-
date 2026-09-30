/**
 * The engine: an Electron utilityProcess that does all heavy work (ingest,
 * image processing, analysis, ML, curator, export). It is crash-isolated
 * from main and restarts on failure; from M1 its job queue lives in SQLite
 * so a restart resumes where it stopped.
 */
import type { MessagePortMain } from 'electron'
import { EventBatcher } from '@shared/batcher'
import { EngineRequest, ENGINE_ATTACH_PORT, type EngineMessage } from '@shared/engine-protocol'
import type { EngineEvent } from '@shared/rpc'
import { createIngest } from './ingest'

const VERSION = '0.1.0'
const started = Date.now()
const parent = process.parentPort

function send(msg: EngineMessage): void {
  parent.postMessage(msg)
}

/** Renderer ports; events are batched to about 10 Hz per port. */
const ports = new Map<MessagePortMain, EventBatcher<EngineEvent>>()

export function broadcast(event: EngineEvent): void {
  for (const batcher of ports.values()) batcher.push(event)
}

type Handler = (params: unknown) => unknown
const handlers: Record<string, Handler> = {
  ping: () => ({ pid: process.pid, uptimeMs: Date.now() - started, version: VERSION })
}
for (const [name, fn] of Object.entries(createIngest(broadcast))) handlers[`ingest.${name}`] = fn

parent.on('message', (e: { data: unknown; ports: MessagePortMain[] }) => {
  const data = e.data as { kind?: string }
  if (data?.kind === ENGINE_ATTACH_PORT) {
    const port = e.ports[0]
    if (!port) return
    const batcher = new EventBatcher<EngineEvent>((batch) => port.postMessage(batch))
    ports.set(port, batcher)
    port.on('close', () => {
      batcher.dispose()
      ports.delete(port)
    })
    port.start()
    return
  }
  const req = EngineRequest.safeParse(e.data)
  if (!req.success) return
  const { id, method, params } = req.data
  const handler = handlers[method]
  if (!handler) {
    send({
      kind: 'response',
      id,
      ok: false,
      error: { code: 'unknown-method', message: `Unknown engine method ${method}` }
    })
    return
  }
  Promise.resolve()
    .then(() => handler(params))
    .then(
      (value) => send({ kind: 'response', id, ok: true, value }),
      (err: unknown) =>
        send({
          kind: 'response',
          id,
          ok: false,
          error: { code: 'engine', message: err instanceof Error ? err.message : String(err) }
        })
    )
})

setInterval(() => broadcast({ type: 'engine.heartbeat', uptimeMs: Date.now() - started }), 5000).unref()

process.on('uncaughtException', (err) => {
  send({ kind: 'log', level: 'error', message: err.stack ?? String(err) })
  process.exit(1)
})

send({ kind: 'ready', version: VERSION })
