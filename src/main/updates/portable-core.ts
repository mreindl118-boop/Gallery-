import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { compareVersions, PortableFeed, type PortableFeed as Feed } from '@shared/release'

/**
 * The portable build updates itself in place: the new exe is downloaded next
 * to the running one and verified, then a small helper moves it onto exactly
 * the same path once galleryLAB has quit, so shortcuts, pins and the folder
 * the user keeps it in all stay valid.
 *
 * The move can't happen while galleryLAB runs: the portable launcher keeps
 * its own exe open (without delete sharing) to read the packed app. The helper
 * therefore waits for galleryLAB to exit, then retries the move until the
 * launcher has let go. Electron-free so it can be tested with plain Node.
 */

export type FetchLike = (url: string) => Promise<Response>

/** Sidecar file names, in the exe's own folder so the final move stays on one volume. */
export function sidecars(exePath: string) {
  const dir = dirname(exePath)
  const name = basename(exePath)
  return {
    partial: join(dir, `${name}.update-partial`),
    ready: join(dir, `${name}.update`),
    readyMeta: join(dir, `${name}.update.json`)
  }
}

export async function fetchFeed(fetchFn: FetchLike, url: string): Promise<Feed> {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`The update feed answered ${res.status}.`)
  return PortableFeed.parse(await res.json())
}

/** True when the folder holding the exe can take new files (not read-only media or Program Files). */
export async function canWriteBeside(exePath: string): Promise<boolean> {
  const probe = join(dirname(exePath), `.gallerylab-write-test-${process.pid}`)
  try {
    await fs.writeFile(probe, '')
    await fs.rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Download the new exe to a partial file, hashing as it streams, then verify
 * size and SHA-512 before promoting it to the ready file. A download that
 * fails verification is deleted; the running exe is never touched here.
 */
export async function downloadVerified(
  fetchFn: FetchLike,
  url: string,
  feed: Feed,
  exePath: string,
  onProgress: (percent: number) => void
): Promise<string> {
  const { partial, ready, readyMeta } = sidecars(exePath)
  await fs.rm(partial, { force: true })
  const res = await fetchFn(url)
  if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}.`)
  const hash = createHash('sha512')
  let received = 0
  let lastReported = -1
  const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk)
      received += chunk.length
      const pct = Math.min(100, Math.floor((received / feed.size) * 100))
      if (pct !== lastReported) {
        lastReported = pct
        onProgress(pct)
      }
      done(null, chunk)
    }
  })
  try {
    await pipeline(source, meter, createWriteStream(partial))
    if (received !== feed.size) {
      throw new Error(`The download was ${received} bytes; the release says ${feed.size}.`)
    }
    const digest = hash.digest('base64')
    if (digest !== feed.sha512) throw new Error('The download does not match the release checksum.')
    await fs.rm(ready, { force: true })
    await fs.rename(partial, ready)
    await fs.writeFile(readyMeta, JSON.stringify({ version: feed.version, sha512: feed.sha512 }))
    return ready
  } catch (err) {
    await fs.rm(partial, { force: true })
    throw err
  }
}

/** The version of a verified update waiting beside the exe, if any. */
export async function readyVersion(exePath: string): Promise<string | null> {
  const { ready, readyMeta } = sidecars(exePath)
  try {
    const meta = JSON.parse(await fs.readFile(readyMeta, 'utf8')) as { version?: unknown }
    await fs.access(ready)
    return typeof meta.version === 'string' ? meta.version : null
  } catch {
    return null
  }
}

/**
 * Tidy up at startup: drop partial downloads, and a ready update that is not
 * newer than the running build (already applied, or left over from a
 * downgrade). A newer ready update is kept so it can be installed.
 */
export async function cleanupLeftovers(exePath: string, currentVersion: string): Promise<void> {
  const { partial, ready, readyMeta } = sidecars(exePath)
  await fs.rm(partial, { force: true }).catch(() => undefined)
  const waiting = await readyVersion(exePath)
  if (waiting === null || compareVersions(waiting, currentVersion) <= 0) {
    await fs.rm(ready, { force: true }).catch(() => undefined)
    await fs.rm(readyMeta, { force: true }).catch(() => undefined)
  }
}

/**
 * The helper that finishes a portable update after galleryLAB quits. It is
 * run by cmd.exe with every path passed through the environment, so the
 * script itself is plain ASCII and paths with spaces, non-Latin letters or
 * characters like & and % are safe.
 *
 *   GLAB_APP_PID     galleryLAB's main process, waited for first
 *   GLAB_READY       the verified new exe
 *   GLAB_READY_META  its version file, removed once the move succeeds
 *   GLAB_EXE         the path to replace (the exe the user runs)
 *   GLAB_RELAUNCH    1 to start the new build afterwards
 */
export const HELPER_SCRIPT = [
  '@echo off',
  'setlocal EnableExtensions DisableDelayedExpansion',
  'rem galleryLAB portable update helper (paths come from the environment)',
  'set /a GLAB_WAITS=0',
  ':waitapp',
  'tasklist /FI "PID eq %GLAB_APP_PID%" /NH 2>nul | find " %GLAB_APP_PID% " >nul',
  'if errorlevel 1 goto swap',
  'set /a GLAB_WAITS+=1',
  'if %GLAB_WAITS% geq 120 goto swap',
  'ping -n 2 127.0.0.1 >nul',
  'goto waitapp',
  ':swap',
  'set /a GLAB_TRIES=0',
  ':tryswap',
  'rem once the verified download is gone from beside the exe, the move has happened',
  'if not exist "%GLAB_READY%" goto moved',
  'move /y "%GLAB_READY%" "%GLAB_EXE%" >nul 2>&1',
  'if not errorlevel 1 goto moved',
  'set /a GLAB_TRIES+=1',
  'if %GLAB_TRIES% geq 120 goto done',
  'ping -n 2 127.0.0.1 >nul',
  'goto tryswap',
  ':moved',
  'del /f /q "%GLAB_READY_META%" >nul 2>&1',
  'if "%GLAB_RELAUNCH%"=="1" start "" "%GLAB_EXE%"',
  ':done',
  '(goto) 2>nul & del /f /q "%~f0"',
  ''
].join('\r\n')

export function helperEnv(exePath: string, appPid: number, relaunch: boolean): Record<string, string> {
  const { ready, readyMeta } = sidecars(exePath)
  return {
    GLAB_APP_PID: String(appPid),
    GLAB_READY: ready,
    GLAB_READY_META: readyMeta,
    GLAB_EXE: exePath,
    GLAB_RELAUNCH: relaunch ? '1' : '0'
  }
}

export const hasReadyUpdate = (exePath: string): boolean => existsSync(sidecars(exePath).ready)
