/**
 * A small pool for decode/resize work: at most `slots` tasks at once, and at
 * most `capacity` units of weight (megapixels) in flight, so several huge
 * TIFFs never decode together. Lower priority numbers go first (thumbnails
 * before display sizes); within a priority, first come first served. A task
 * heavier than the whole capacity runs alone.
 */
export class WeightedPool {
  private running = 0
  private weight = 0
  private seq = 0
  private readonly waiting: { weight: number; priority: number; seq: number; start: () => void }[] = []

  constructor(
    readonly slots: number,
    readonly capacity: number
  ) {}

  get active(): number {
    return this.running
  }

  get inFlightWeight(): number {
    return this.weight
  }

  async run<T>(weight: number, priority: number, task: () => Promise<T>): Promise<T> {
    const w = Math.min(Math.max(weight, 0), this.capacity)
    await new Promise<void>((resolve) => {
      this.waiting.push({ weight: w, priority, seq: this.seq++, start: resolve })
      this.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
      this.pump()
    })
    try {
      return await task()
    } finally {
      this.running--
      this.weight -= w
      this.pump()
    }
  }

  private pump(): void {
    while (this.waiting.length > 0) {
      const next = this.waiting[0]!
      const fits = this.running === 0 || (this.running < this.slots && this.weight + next.weight <= this.capacity)
      if (!fits) return
      this.waiting.shift()
      this.running++
      this.weight += next.weight
      next.start()
    }
  }
}
