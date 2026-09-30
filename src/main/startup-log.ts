import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog } from 'electron'

/**
 * Synchronous startup log at <userData>/logs/startup.log. Written line by
 * line before anything else runs, so a launch that dies leaves its last step
 * behind. Fatal errors also get a visible message instead of a silent exit.
 */
const MAX_BYTES = 256 * 1024
let file: string | null = null

function target(): string | null {
  if (file) return file
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'startup.log')
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // No file yet.
    }
    return file
  } catch {
    return null
  }
}

export function startupLog(...parts: unknown[]): void {
  const text = parts
    .map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')
  console.log('[startup]', text)
  const f = target()
  if (!f) return
  try {
    appendFileSync(f, `${new Date().toISOString()} ${text}\n`)
  } catch {
    // Logging must never take the app down.
  }
}

export const startupLogPath = (): string => target() ?? '(no log folder)'

/** Log, tell the user what happened and where the log is, then exit. */
export function fatal(where: string, err: unknown): never {
  startupLog(`FATAL in ${where}:`, err)
  const message = err instanceof Error ? err.message : String(err)
  try {
    dialog.showErrorBox(
      'galleryLAB couldn’t start',
      `${message}\n\nDetails are in ${startupLogPath()}\n\nIf this keeps happening, reinstall galleryLAB from the releases page. Your Library and settings are kept.`
    )
  } catch {
    // Error boxes can fail very early; the log still has the reason.
  }
  app.exit(1)
  throw err
}
