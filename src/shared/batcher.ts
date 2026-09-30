/**
 * Coalesces high-volume events (progress, thumbnail ready) into batches
 * flushed at a fixed rate, so the renderer sees about 10 updates a second
 * however fast the engine works.
 */
export class EventBatcher<T> {
  private queue: T[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly flushTo: (batch: T[]) => void,
    private readonly intervalMs = 100,
    private readonly maxBatch = 2000
  ) {}

  push(event: T): void {
    this.queue.push(event)
    if (this.queue.length >= this.maxBatch) {
      this.flush()
      return
    }
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    this.flushTo(batch)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
  }
}
