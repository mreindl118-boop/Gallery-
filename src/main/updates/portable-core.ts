import { createHash } from 'node:crypto'
import { createWriteStream, promises as fs, renameSync, rmSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { PortableFeed, type PortableFeed as Feed } from '@shared/release'

/**
 * The portable build updates itself in place: the new exe is downloaded next
 * to the running one, verified, and swapped in at exactly the same path, so
 * shortcuts, pins and the folder the user keeps it in all stay valid.
 *
 * Windows lets a running executable be renamed (not overwritten or deleted),
 * which is what makes the swap possible while the portable launcher is still
 * running. Electron-free so it can be tested with plain Node.
 */

export type FetchLike = (url: string) => Promise<Response>

/** Sidecar file names, all in the exe's own folder so every rename stays on one volume. */
export function sidecars(exePath: string) {
  const dir = dirname(exePath)
  const name = basename(exePath)
  return {
    partial: join(dir, `${name}.update-partial`),
    ready: join(dir, `${name}.update`),
    readyMeta: join(dir, `${name}.update.json`),
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
 * Swap the verified update into place. Synchronous so it can run inside
 * `will-quit`. Order: running exe → .old, ready → exe path. If the second
 * rename fails the first is undone, so the exe path always holds a working
 * build. Returns true when the new build is in place.
 */
export function swapInPlace(exePath: string): boolean {
  const { ready, readyMeta, old } = sidecars(exePath)
  if (!existsSync(ready)) return false
  try {
    rmSync(old, { force: true })
  } catch {
    // A previous .old still held by an exiting launcher; the rename below will fail and we retry next quit.
  }
  try {
    renameSync(exePath, old)
  } catch {
    return false
  }
  try {
    renameSync(ready, exePath)
  } catch {
    try {
      renameSync(old, exePath)
    } catch {
      // Leave .old in place; cleanupLeftovers restores it on the next launch.
    }
    return false
  }
  try {
    rmSync(readyMeta, { force: true })
  } catch {
    // Harmless: readyVersion also requires the ready file.
  }
  return true
}

/**
 * Tidy up after an earlier update: remove the previous build (.old) once
 * nothing holds it, and stale partial downloads. If the exe itself is missing
 * but .old exists (a swap interrupted between its two renames), restore it.
 */
export async function cleanupLeftovers(exePath: string): Promise<void> {
  const { partial, old } = sidecars(exePath)
  if (!existsSync(exePath) && existsSync(old)) {
    await fs.rename(old, exePath).catch(() => undefined)
    return
  }
  await fs.rm(partial, { force: true }).catch(() => undefined)
  await fs.rm(old, { force: true }).catch(() => undefined)
}
