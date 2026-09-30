import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanupLeftovers,
  downloadVerified,
  fetchFeed,
  attemptsSoFar,
  encodedHelper,
  hasReadyUpdate,
  HELPER_SCRIPT,
  helperEnv,
  readyVersion,
  recordAttempt,
  sidecars
} from '../src/main/updates/portable-core'

const NEW_BUILD = Buffer.alloc(3 * 1024 * 1024, 7)
const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('base64')

let server: Server
let base: string
let dir: string
let exe: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/latest-portable.json') {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          version: '0.2.0',
          file: 'galleryLAB-0.2.0-portable.exe',
          size: NEW_BUILD.length,
          sha512: sha512(NEW_BUILD),
          releaseDate: '2026-10-01T00:00:00Z'
        })
      )
    } else if (req.url === '/galleryLAB-0.2.0-portable.exe') {
      res.end(NEW_BUILD)
    } else if (req.url === '/truncated.exe') {
      res.end(NEW_BUILD.subarray(0, 1000))
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gl-portable-'))
  exe = join(dir, 'galleryLAB-0.1.1-portable.exe')
  writeFileSync(exe, 'old build')
  return () => rmSync(dir, { recursive: true, force: true })
})

describe('portable self-update', () => {
  it('downloads and verifies the new build beside the exe without touching the exe', async () => {
    const feed = await fetchFeed(fetch, `${base}/latest-portable.json`)
    const progress: number[] = []
    await downloadVerified(fetch, `${base}/${feed.file}`, feed, exe, (p) => progress.push(p))
    expect(progress.at(-1)).toBe(100)
    expect(readFileSync(exe, 'utf8')).toBe('old build')
    expect(readFileSync(sidecars(exe).ready).equals(NEW_BUILD)).toBe(true)
    expect(hasReadyUpdate(exe)).toBe(true)
    expect(await readyVersion(exe)).toBe('0.2.0')
    expect(existsSync(sidecars(exe).partial)).toBe(false)
  })

  it('rejects a download whose checksum does not match and leaves no files behind', async () => {
    const feed = await fetchFeed(fetch, `${base}/latest-portable.json`)
    const tampered = { ...feed, sha512: sha512(Buffer.from('something else')) }
    await expect(downloadVerified(fetch, `${base}/${feed.file}`, tampered, exe, () => undefined)).rejects.toThrow(
      /checksum/
    )
    const s = sidecars(exe)
    expect(existsSync(s.partial)).toBe(false)
    expect(existsSync(s.ready)).toBe(false)
    expect(readFileSync(exe, 'utf8')).toBe('old build')
  })

  it('rejects a truncated download', async () => {
    const feed = await fetchFeed(fetch, `${base}/latest-portable.json`)
    await expect(downloadVerified(fetch, `${base}/truncated.exe`, feed, exe, () => undefined)).rejects.toThrow(/bytes/)
    expect(hasReadyUpdate(exe)).toBe(false)
  })

  it('keeps a newer waiting update at startup and drops stale ones and partial downloads', async () => {
    const feed = await fetchFeed(fetch, `${base}/latest-portable.json`)
    await downloadVerified(fetch, `${base}/${feed.file}`, feed, exe, () => undefined)
    writeFileSync(sidecars(exe).partial, 'half')

    await cleanupLeftovers(exe, '0.1.1')
    expect(existsSync(sidecars(exe).partial)).toBe(false)
    expect(await readyVersion(exe)).toBe('0.2.0') // still newer than 0.1.1: kept for install

    await cleanupLeftovers(exe, '0.2.0') // already running 0.2.0: the waiting copy is stale
    expect(hasReadyUpdate(exe)).toBe(false)
    expect(existsSync(sidecars(exe).readyMeta)).toBe(false)
    expect(readFileSync(exe, 'utf8')).toBe('old build')
  })

  it('drops a ready file with no version record', async () => {
    writeFileSync(sidecars(exe).ready, 'orphan')
    await cleanupLeftovers(exe, '0.1.1')
    expect(hasReadyUpdate(exe)).toBe(false)
  })

  it('fails cleanly on a missing feed', async () => {
    await expect(fetchFeed(fetch, `${base}/nope.json`)).rejects.toThrow(/404/)
  })
})

describe('portable update helper', () => {
  it('is plain ASCII PowerShell with no paths of its own, passed as an encoded command', () => {
    expect([...HELPER_SCRIPT].every((c) => c.charCodeAt(0) < 128)).toBe(true)
    expect(HELPER_SCRIPT).not.toMatch(/[A-Za-z]:\\/)
    for (const v of ['GLAB_READY', 'GLAB_EXE', 'GLAB_READY_META', 'GLAB_APP_PID', 'GLAB_RELAUNCH']) {
      expect(HELPER_SCRIPT).toContain(`$env:${v}`)
    }
    // Paths are only ever used literally (no wildcard expansion of [ ] in folder names).
    for (const line of HELPER_SCRIPT.split('\r\n').filter((l) => /Test-Path|Remove-Item/.test(l))) {
      expect(line).toContain('-LiteralPath')
    }
    expect(HELPER_SCRIPT).toContain('[System.IO.File]::Replace($ready, $exe, $old)')
    expect(Buffer.from(encodedHelper(), 'base64').toString('utf16le')).toBe(HELPER_SCRIPT)
  })

  it('passes the exact exe path and its sidecars through the environment', () => {
    const odd = join(dir, 'Pfad mit Ümlaut & 100% [x]', 'galleryLAB-0.1.1-portable.exe')
    const env = helperEnv(odd, 4242, true)
    expect(env).toEqual({
      GLAB_APP_PID: '4242',
      GLAB_READY: `${odd}.update`,
      GLAB_READY_META: `${odd}.update.json`,
      GLAB_EXE: odd,
      GLAB_RELAUNCH: '1'
    })
    expect(helperEnv(odd, 1, false).GLAB_RELAUNCH).toBe('0')
  })

  it('counts attempts so a swap that never completes stops being offered', async () => {
    const feed = await fetchFeed(fetch, `${base}/latest-portable.json`)
    await downloadVerified(fetch, `${base}/${feed.file}`, feed, exe, () => undefined)
    expect(await attemptsSoFar(exe)).toBe(0)
    expect(await recordAttempt(exe)).toBe(1)
    expect(await recordAttempt(exe)).toBe(2)
    expect(await attemptsSoFar(exe)).toBe(2)
    expect(await readyVersion(exe)).toBe('0.2.0')
  })

  it('removes the previous build left beside the exe', async () => {
    writeFileSync(sidecars(exe).old, 'previous')
    await cleanupLeftovers(exe, '0.1.1')
    expect(existsSync(sidecars(exe).old)).toBe(false)
  })
})
