import { join } from 'node:path'
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { EngineMessage, ENGINE_ATTACH_PORT, type EngineRequest } from '@shared/engine-protocol'
import { ENGINE_PORT_CHANNEL, GalleryError } from '@shared/rpc'
import type { EngineState } from '@shared/schemas'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Owns the engine utility process: spawns it, restarts it after a crash
 * (with backoff, giving up after repeated crashes), routes request/response
 * pairs, and gives every renderer a direct MessagePort to it for
 * high-volume events.
 */
export class EngineHost {
  private child: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private crashes: number[] = []
  private stopping = false
  private readonly renderers = new Set<WebContents>()
  state: EngineState = 'starting'

  constructor(private readonly onState: (s: EngineState) => void) {}

  start(): void {
    this.stopping = false
    this.spawn()
  }

  private setState(s: EngineState): void {
    this.state = s
    this.onState(s)
  }

  private spawn(): void {
    const child = utilityProcess.fork(join(__dirname, 'engine.js'), [], {
      serviceName: 'galleryLAB engine',
      stdio: 'inherit'
    })
    this.child = child
    child.on('message', (raw: unknown) => {
      const parsed = EngineMessage.safeParse(raw)
      if (!parsed.success) return
      const msg = parsed.data
      if (msg.kind === 'ready') {
        this.setState('ready')
        for (const wc of this.renderers) this.attach(wc)
      } else if (msg.kind === 'response') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.value)
        else p.reject(new GalleryError(msg.error?.code ?? 'engine', msg.error?.message ?? 'The engine failed.'))
      } else if (msg.kind === 'log') {
        console[msg.level](`[engine] ${msg.message}`)
      }
    })
    child.on('exit', (code) => {
      if (this.child === child) this.child = null
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new GalleryError('engine-restart', 'The engine restarted. Try again in a moment.'))
      }
      this.pending.clear()
      if (this.stopping) return
      const now = Date.now()
      this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now]
      if (this.crashes.length > 5) {
        console.error(`[engine] exited with ${code}; giving up after repeated crashes`)
        this.setState('failed')
        return
      }
      this.setState('restarting')
      const delay = Math.min(250 * 2 ** (this.crashes.length - 1), 4000)
      setTimeout(() => !this.stopping && this.spawn(), delay)
    })
  }

  /** Give a renderer its own port to the engine; re-sent after each restart. */
  connectRenderer(wc: WebContents): void {
    this.renderers.add(wc)
    wc.once('destroyed', () => this.renderers.delete(wc))
    if (this.state === 'ready') this.attach(wc)
  }

  private attach(wc: WebContents): void {
    if (!this.child || wc.isDestroyed()) return
    const { port1, port2 } = new MessageChannelMain()
    this.child.postMessage({ kind: ENGINE_ATTACH_PORT }, [port1])
    wc.postMessage(ENGINE_PORT_CHANNEL, null, [port2])
  }

  request<T = unknown>(method: string, params: unknown = null, timeoutMs = 30_000): Promise<T> {
    const child = this.child
    if (!child || this.state !== 'ready') {
      return Promise.reject(new GalleryError('engine-unavailable', 'The engine is starting. Try again in a moment.'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new GalleryError('engine-timeout', 'The engine did not answer in time.'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      const msg: EngineRequest = { kind: 'request', id, method, params }
      child.postMessage(msg)
    })
  }

  stop(): void {
    this.stopping = true
    this.child?.kill()
    this.child = null
  }
}
