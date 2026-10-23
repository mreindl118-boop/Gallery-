import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn() },
  MessageChannelMain: vi.fn()
}))
vi.mock('../src/main/startup-log', () => ({ startupLog: vi.fn() }))

import { utilityProcess } from 'electron'
import { EngineHost } from '../src/main/engine-host'
import { ImportTaskbar } from '../src/main/import-taskbar'

afterEach(() => vi.restoreAllMocks())

describe('engine import progress delivery', () => {
  it('updates native progress without a renderer and ignores invalid progress', () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as ReturnType<typeof utilityProcess.fork>)
    const taskbar = new ImportTaskbar()
    const applied = vi.fn()
    const engine = new EngineHost(
      (state) => {
        if (state !== 'ready') applied(taskbar.clear())
      },
      (progress) => applied(taskbar.update(progress))
    )
    engine.start()
    const progress = {
      projectId: '9b7aa33c-5acf-4b2b-8b80-257e82563fd9',
      state: 'importing',
      total: 10,
      done: 3,
      imported: 3,
      duplicates: 0,
      failed: 0,
      photos: 3,
      filesPerSecond: 1,
      secondsLeft: 7
    }
    child.emit('message', { kind: 'import-progress', progress })
    expect(applied).toHaveBeenLastCalledWith({ value: 0.3, mode: 'normal' })
    child.emit('message', { kind: 'import-progress', progress: { ...progress, done: -1 } })
    expect(applied).toHaveBeenCalledTimes(1)
    child.emit('message', { kind: 'import-progress', progress: { ...progress, state: 'done' } })
    expect(applied).toHaveBeenLastCalledWith({ value: -1, mode: 'none' })
    engine.stop()
  })
})
