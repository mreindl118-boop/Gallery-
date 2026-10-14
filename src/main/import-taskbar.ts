import type { ImportProgress } from '@shared/ingest'

export interface TaskbarState {
  value: number
  mode: 'none' | 'normal' | 'indeterminate' | 'paused'
}

/** Import queues keep running when their project is not on screen. Show all
 * active queues, rather than letting the last project's event hide another. */
export class ImportTaskbar {
  private readonly queues = new Map<string, ImportProgress>()

  update(progress: ImportProgress): TaskbarState {
    if (progress.state === 'idle' || progress.state === 'done') this.queues.delete(progress.projectId)
    else this.queues.set(progress.projectId, progress)
    return this.current()
  }

  clear(): TaskbarState {
    this.queues.clear()
    return this.current()
  }

  current(): TaskbarState {
    const queues = [...this.queues.values()]
    if (!queues.length) return { value: -1, mode: 'none' }
    const running = queues.filter((q) => q.state !== 'paused')
    if (running.some((q) => q.state === 'discovering' || q.total === 0)) {
      return { value: 2, mode: 'indeterminate' }
    }
    const shown = running.length ? running : queues
    const total = shown.reduce((sum, q) => sum + q.total, 0)
    const done = shown.reduce((sum, q) => sum + Math.min(q.done, q.total), 0)
    return { value: total ? done / total : 0, mode: running.length ? 'normal' : 'paused' }
  }
}
