import { describe, expect, it, vi } from 'vitest'
import { EventBatcher } from '@shared/batcher'
import { migrate, SchemaVersionError } from '@shared/migrate'

describe('migrate', () => {
  it('walks each step and stamps the version', () => {
    const out = migrate({ schemaVersion: 1, a: 1 }, 3, {
      1: (d) => ({ ...d, b: 2 }),
      2: (d) => ({ ...d, c: 3 })
    })
    expect(out).toEqual({ schemaVersion: 3, a: 1, b: 2, c: 3 })
  })
  it('refuses documents from a newer app', () => {
    expect(() => migrate({ schemaVersion: 9 }, 1)).toThrow(SchemaVersionError)
  })
  it('refuses a missing step and non-objects', () => {
    expect(() => migrate({ schemaVersion: 1 }, 2)).toThrow(/No migration/)
    expect(() => migrate([], 1)).toThrow(TypeError)
  })
})

describe('EventBatcher', () => {
  it('coalesces events into one flush per interval', () => {
    vi.useFakeTimers()
    const flushes: number[][] = []
    const b = new EventBatcher<number>((batch) => flushes.push(batch), 100)
    for (let i = 0; i < 500; i++) b.push(i)
    expect(flushes).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(flushes).toHaveLength(1)
    expect(flushes[0]).toHaveLength(500)
    b.push(1)
    vi.advanceTimersByTime(99)
    expect(flushes).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(flushes).toHaveLength(2)
    vi.useRealTimers()
  })
  it('flushes early when a batch gets large', () => {
    const flushes: number[][] = []
    const b = new EventBatcher<number>((batch) => flushes.push(batch), 100, 10)
    for (let i = 0; i < 25; i++) b.push(i)
    expect(flushes.map((f) => f.length)).toEqual([10, 10])
    b.dispose()
  })
})
