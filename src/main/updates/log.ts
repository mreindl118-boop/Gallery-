import { appendFile, rename, stat } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * A small rotating log for the updater at <userData>/logs/updates.log, so a
 * failed update can be diagnosed on a user's machine (and in CI). Never
 * contains anything but versions, paths and error messages.
 */
const MAX_BYTES = 512 * 1024
let file: string | null = null
let chain: Promise<void> = Promise.resolve()

function target(): string {
  if (!file) {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'updates.log')
  }
  return file
}

export function updateLog(level: 'info' | 'warn' | 'error', ...parts: unknown[]): void {
  const text = parts
    .map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')
  console[level]('[updates]', text)
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`
  chain = chain
    .then(async () => {
      const f = target()
      const size = await stat(f).then(
        (s) => s.size,
        () => 0
      )
      if (size > MAX_BYTES) await rename(f, `${f}.1`).catch(() => undefined)
      await appendFile(f, line)
    })
    .catch(() => undefined)
}

export const updateLogPath = (): string => target()
