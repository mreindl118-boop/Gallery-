import type { ImportProgress } from '@shared/ingest'
import type { WeightedPool } from '../ingest/pool'

/**
 * The seam between the import queue and the build: the queue registers its
 * decode pool (so readings share it at a lower priority) and announces when
 * an import settles; the build subscribes. Nothing here holds state about a
 * project, so either side can come and go.
 */

export interface ImportDone {
  projectId: string
  root: string
  progress: ImportProgress
}

type Listener = (done: ImportDone) => void

let decodePool: WeightedPool | null = null
const listeners = new Set<Listener>()

export function registerDecodePool(pool: WeightedPool): void {
  decodePool = pool
}

export function sharedDecodePool(): WeightedPool | null {
  return decodePool
}

export function onImportDone(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notifyImportDone(done: ImportDone): void {
  for (const fn of listeners) {
    try {
      fn(done)
    } catch {
      // A build that fails to start must never break the import that finished.
    }
  }
}
