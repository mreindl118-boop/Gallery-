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
 * The swap can't happen while galleryLAB runs: the portable launcher keeps
 * its own exe open (without delete sharing) to read the packed app. The helper
 * therefore waits for galleryLAB to exit, then retries until the launcher has
 * let go. Electron-free so it can be tested with plain Node.
 */

export type FetchLike = (url: string) => Promise<Response>

/** Sidecar file names, in the exe's own folder so the final move stays on one volume. */
export function sidecars(exePath: string) {
  const dir = dirname(exePath)
  const name = basename(exePath)
  return {
    partial: join(dir, `${name}.update-partial`),
    ready: join(dir, `${name}.update`),
    readyMeta: join(dir, `${name}.update.json`),
    /** The previous build, briefly, while the helper's File.Replace completes. */
    old: join(dir, `${name}.old`)
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
  const { partial, ready, readyMeta, old } = sidecars(exePath)
  await fs.rm(partial, { force: true }).catch(() => undefined)
  if (existsSync(exePath)) await fs.rm(old, { force: true }).catch(() => undefined)
  const waiting = await readyVersion(exePath)
  if (waiting === null || compareVersions(waiting, currentVersion) <= 0) {
    await fs.rm(ready, { force: true }).catch(() => undefined)
    await fs.rm(readyMeta, { force: true }).catch(() => undefined)
  }
}

/**
 * The helper that finishes a portable update after galleryLAB quits: a short
 * Windows PowerShell script, started fully detached (a non-detached child is
 * killed with galleryLAB) with no window, and every path passed through the
 * environment so nothing needs quoting and any Unicode path works.
 *
 *   GLAB_APP_PID     galleryLAB's main process, waited for first
 *   GLAB_LAUNCHER_PID  the portable launcher (galleryLAB's parent), which holds the exe until it exits
 *   GLAB_LOG         the updater log to append progress to
 *   GLAB_READY       the verified new exe
 *   GLAB_READY_META  its version file, removed once the swap succeeds
 *   GLAB_EXE         the path to replace (the exe the user runs)
 *   GLAB_RELAUNCH    1 to start the new build afterwards
 *
 * The swap uses File.Replace (ReplaceFile), which swaps in the new file in
 * one step, retried while the portable launcher still holds the old one.
 */
export const HELPER_SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  'function Log([string]$m) {',
  '  if ($env:GLAB_LOG) {',
  "    try { Add-Content -LiteralPath $env:GLAB_LOG -Value ((Get-Date).ToUniversalTime().ToString('o') + ' HELPER ' + $m) } catch { }",
  '  }',
  '}',
  '$ready = $env:GLAB_READY',
  '$exe = $env:GLAB_EXE',
  "$old = $exe + '.old'",
  'Log ("started for " + $exe + " (app " + $env:GLAB_APP_PID + ", launcher " + $env:GLAB_LAUNCHER_PID + ")")',
  'foreach ($p in @($env:GLAB_APP_PID, $env:GLAB_LAUNCHER_PID)) {',
  '  if ($p -and [int]$p -gt 0) {',
  '    try { Wait-Process -Id ([int]$p) -Timeout 120 -ErrorAction Stop } catch { }',
  '  }',
  '}',
  'Log "galleryLAB and its launcher have exited"',
  '$done = $false',
  'for ($i = 0; $i -lt 120; $i++) {',
  '  if (-not (Test-Path -LiteralPath $ready)) { $done = $true; break }',
  '  try {',
  '    [System.IO.File]::Replace($ready, $exe, $old)',
  '    $done = $true',
  '    Log ("replaced on attempt " + ($i + 1))',
  '    break',
  '  } catch {',
  '    if ($i -lt 3 -or $i % 20 -eq 0) { Log ("attempt " + ($i + 1) + " failed: " + $_.Exception.Message) }',
  '    Start-Sleep -Seconds 1',
  '  }',
  '}',
  'if ($done) {',
  '  Remove-Item -LiteralPath $env:GLAB_READY_META -Force -ErrorAction SilentlyContinue',
  '  for ($j = 0; $j -lt 30 -and (Test-Path -LiteralPath $old); $j++) {',
  '    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue',
  '    if (Test-Path -LiteralPath $old) { Start-Sleep -Seconds 1 }',
  '  }',
  "  if ($env:GLAB_RELAUNCH -eq '1') {",
  '    Log "starting the new build"',
  '    Start-Process -FilePath $exe',
  '  }',
  '} else {',
  '  Log "gave up: the old build stayed in place"',
  '}',
  ''
].join('\r\n')

/** HELPER_SCRIPT as a PowerShell -EncodedCommand argument (base64 of UTF-16LE). */
export const encodedHelper = (): string => Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64')

export function helperEnv(
  exePath: string,
  appPid: number,
  relaunch: boolean,
  extra: { launcherPid?: number; log?: string } = {}
): Record<string, string> {
  const { ready, readyMeta } = sidecars(exePath)
  return {
    GLAB_APP_PID: String(appPid),
    GLAB_LAUNCHER_PID: String(extra.launcherPid ?? 0),
    GLAB_LOG: extra.log ?? '',
    GLAB_READY: ready,
    GLAB_READY_META: readyMeta,
    GLAB_EXE: exePath,
    GLAB_RELAUNCH: relaunch ? '1' : '0'
  }
}

/** Times the helper has been started for the waiting update; after two failures, stop offering it. */
export async function recordAttempt(exePath: string): Promise<number> {
  const { readyMeta } = sidecars(exePath)
  try {
    const meta = JSON.parse(await fs.readFile(readyMeta, 'utf8')) as Record<string, unknown>
    const attempts = (typeof meta['attempts'] === 'number' ? meta['attempts'] : 0) + 1
    await fs.writeFile(readyMeta, JSON.stringify({ ...meta, attempts }))
    return attempts
  } catch {
    return 1
  }
}

export async function attemptsSoFar(exePath: string): Promise<number> {
  try {
    const meta = JSON.parse(await fs.readFile(sidecars(exePath).readyMeta, 'utf8')) as Record<string, unknown>
    return typeof meta['attempts'] === 'number' ? meta['attempts'] : 0
  } catch {
    return 0
  }
}

export const hasReadyUpdate = (exePath: string): boolean => existsSync(sidecars(exePath).ready)
