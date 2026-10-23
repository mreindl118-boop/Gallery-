import { describe, expect, it } from 'vitest'
import type { ImportProgress } from '@shared/ingest'
import { EngineMessage } from '@shared/engine-protocol'
import { ImportTaskbar } from '../src/main/import-taskbar'

const progress = (changes: Partial<ImportProgress> = {}): ImportProgress => ({
  projectId: '9b7aa33c-5acf-4b2b-8b80-257e82563fd9',
  state: 'importing',
  total: 10,
  done: 4,
  imported: 2,
  duplicates: 1,
  failed: 1,
  importedVideos: 0,
  photos: 2,
  videos: 0,
  filesPerSecond: 2,
  secondsLeft: 3,
  ...changes
})
const other = '2901e685-1ab2-4b96-97e9-e89bda389f87'

describe('import taskbar', () => {
  it('counts imported, duplicate and failed files as finished work', () => {
    expect(new ImportTaskbar().update(progress())).toEqual({ value: 0.4, mode: 'normal' })
  })
  it('shows unknown discovery totals as indeterminate', () => {
    const taskbar = new ImportTaskbar()
    expect(taskbar.update(progress({ state: 'discovering' }))).toEqual({ value: 2, mode: 'indeterminate' })
    expect(taskbar.update(progress({ total: 0, done: 0 }))).toEqual({ value: 2, mode: 'indeterminate' })
    expect(taskbar.update(progress())).toEqual({ value: 0.4, mode: 'normal' })
  })
  it('weights simultaneous queues by files and retains work when another queue finishes', () => {
    const taskbar = new ImportTaskbar()
    taskbar.update(progress())
    expect(taskbar.update(progress({ projectId: other, total: 30, done: 6 }))).toEqual({ value: 0.25, mode: 'normal' })
    expect(taskbar.update(progress({ projectId: other, state: 'done' }))).toEqual({ value: 0.4, mode: 'normal' })
    expect(taskbar.update(progress({ state: 'idle' }))).toEqual({ value: -1, mode: 'none' })
  })
  it('shows pause only when all remaining queues are paused', () => {
    const taskbar = new ImportTaskbar()
    expect(taskbar.update(progress({ state: 'paused' }))).toEqual({ value: 0.4, mode: 'paused' })
    expect(taskbar.update(progress({ projectId: other, done: 7 }))).toEqual({ value: 0.7, mode: 'normal' })
    expect(taskbar.update(progress({ projectId: other, state: 'done' }))).toEqual({ value: 0.4, mode: 'paused' })
    expect(taskbar.update(progress({ total: 0, done: 0, state: 'paused' }))).toEqual({ value: 0, mode: 'paused' })
  })
  it('replays current progress for a new window and clears stale progress after an engine restart', () => {
    const taskbar = new ImportTaskbar()
    taskbar.update(progress())
    expect(taskbar.current()).toEqual({ value: 0.4, mode: 'normal' })
    expect(taskbar.clear()).toEqual({ value: -1, mode: 'none' })
    expect(taskbar.current()).toEqual({ value: -1, mode: 'none' })
  })
  it('keeps inconsistent completion counts within the native progress range', () => {
    expect(new ImportTaskbar().update(progress({ done: 11 }))).toEqual({ value: 1, mode: 'normal' })
  })
  it('validates the engine-to-main progress message and rejects malformed counts', () => {
    expect(EngineMessage.safeParse({ kind: 'import-progress', progress: progress() }).success).toBe(true)
    expect(EngineMessage.safeParse({ kind: 'import-progress', progress: progress({ total: -1 }) }).success).toBe(false)
  })
})
