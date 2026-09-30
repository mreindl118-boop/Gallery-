import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { z } from 'zod'
import { IngestMethods, type ImportProgress, type ImportStatus, type PhotoSummary } from '@shared/ingest'
import type { EngineEvent } from '@shared/rpc'
import { DB_FILE } from './db'
import { WeightedPool } from './pool'
import { defaultFreeBytes, ProjectQueue, type QueueContext } from './queue'

export type Handler = (params: unknown) => unknown
export type Broadcast = (event: EngineEvent) => void

export interface IngestOptions extends Partial<Omit<QueueContext, 'broadcast' | 'pool'>> {
  /** Decode/resize workers (default min(4, cpus - 1)). */
  workers?: number
  /** Megapixels allowed to decode at once across all projects. */
  megapixelBudget?: number
}

/**
 * The ingest service: one queue per project, one shared decode pool. Import
 * requests return at once with the current progress; the work and its
 * events follow.
 */
export class Ingest {
  private readonly queues = new Map<string, ProjectQueue>()
  private readonly ctx: QueueContext

  constructor(broadcast: Broadcast, opts: IngestOptions = {}) {
    const workers = opts.workers ?? Math.max(1, Math.min(4, cpus().length - 1))
    this.ctx = {
      broadcast,
      pool: new WeightedPool(workers, opts.megapixelBudget ?? 300),
      jobsInFlight: opts.jobsInFlight ?? workers + 2,
      minFreeBytes: opts.minFreeBytes ?? 1024 ** 3,
      freeBytes: opts.freeBytes ?? defaultFreeBytes,
      progressIntervalMs: opts.progressIntervalMs ?? 200,
      idleCloseMs: opts.idleCloseMs ?? 3000,
      now: opts.now ?? Date.now,
      beforeStage: opts.beforeStage,
      log: opts.log ?? ((m) => console.warn(`[ingest] ${m}`))
    }
  }

  private queue(projectId: string, root: string): ProjectQueue {
    let q = this.queues.get(projectId)
    if (q && q.root !== root) {
      // The project folder moved (renamed in the Library). Follow it once the old queue is quiet.
      if (!q.busy) {
        q.dispose()
        q = undefined
      }
    }
    if (!q) {
      q = new ProjectQueue(projectId, root, this.ctx)
      this.queues.set(projectId, q)
    }
    return q
  }

  add(p: { projectId: string; root: string; paths: string[] }): ImportProgress {
    return this.queue(p.projectId, p.root).add(p.paths)
  }
  pause(p: { projectId: string; root: string }): ImportProgress {
    return this.queue(p.projectId, p.root).pause()
  }
  resume(p: { projectId: string; root: string }): ImportProgress {
    return this.queue(p.projectId, p.root).resume()
  }
  cancel(p: { projectId: string; root: string }): ImportProgress {
    return this.queue(p.projectId, p.root).cancel()
  }
  retry(p: { projectId: string; root: string; issueIds?: number[] }): ImportProgress {
    return this.queue(p.projectId, p.root).retry(p.issueIds)
  }
  status(p: { projectId: string; root: string }): ImportStatus {
    return this.queue(p.projectId, p.root).status()
  }
  issues(p: { projectId: string; root: string }): ImportStatus['issues'] {
    return this.queue(p.projectId, p.root).issues()
  }
  photos(p: { projectId: string; root: string; offset: number; limit: number }): PhotoSummary[] {
    return this.queue(p.projectId, p.root).photos(p.offset, p.limit)
  }

  /** Resumes unfinished imports. Projects that never imported have no database and are left alone. */
  resumeAll(p: { projects: { projectId: string; root: string }[] }): { resumed: string[] } {
    const resumed: string[] = []
    for (const { projectId, root } of p.projects) {
      if (!existsSync(join(root, DB_FILE))) continue
      try {
        if (this.queue(projectId, root).resumeUnfinished()) resumed.push(projectId)
      } catch (err) {
        this.ctx.log(`Could not resume ${projectId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { resumed }
  }

  /** Stops everything and closes databases (tests; the engine process just exits). */
  dispose(): void {
    for (const q of this.queues.values()) q.dispose()
    this.queues.clear()
  }

  handlers(): Record<string, Handler> {
    type M = typeof IngestMethods
    const bind =
      <K extends keyof M>(name: K, fn: (p: z.output<M[K]>) => unknown): Handler =>
      (params) =>
        fn(IngestMethods[name].parse(params) as z.output<M[K]>)
    return {
      add: bind('add', (p) => this.add(p)),
      pause: bind('pause', (p) => this.pause(p)),
      resume: bind('resume', (p) => this.resume(p)),
      cancel: bind('cancel', (p) => this.cancel(p)),
      retry: bind('retry', (p) => this.retry(p)),
      status: bind('status', (p) => this.status(p)),
      issues: bind('issues', (p) => this.issues(p)),
      photos: bind('photos', (p) => this.photos(p)),
      resumeAll: bind('resumeAll', (p) => this.resumeAll(p))
    }
  }
}

/**
 * Ingest handlers for the engine, registered under 'ingest.<method>' (see
 * IngestMethods in src/shared/ingest.ts). Params are validated here.
 */
export function createIngest(broadcast: Broadcast, opts?: IngestOptions): Record<string, Handler> {
  return new Ingest(broadcast, opts).handlers()
}
