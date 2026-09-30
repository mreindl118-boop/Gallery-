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
  readyVersion,
  sidecars,
  swapInPlace
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
  it('downloads, verifies and swaps the new build in at the same path', async () => {
    const feed = await fetchFeed(fetch, `${base}/latest-portable.json`)
    const progress: number[] = []
    await downloadVerified(fetch, `${base}/${feed.file}`, feed, exe, (p) => progress.push(p))
    expect(progress.at(-1)).toBe(100)
    expect(readFileSync(exe, 'utf8')).toBe('old build') // untouched until the swap
    expect(await readyVersion(exe)).toBe('0.2.0')

    expect(swapInPlace(exe)).toBe(true)
    expect(readFileSync(exe).equals(NEW_BUILD)).toBe(true)
    expect(readFileSync(sidecars(exe).old, 'utf8')).toBe('old build')
    expect(await readyVersion(exe)).toBeNull()

    await cleanupLeftovers(exe)
    expect(existsSync(sidecars(exe).old)).toBe(false)
    expect(readFileSync(exe).equals(NEW_BUILD)).toBe(true)
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
    expect(existsSync(sidecars(exe).ready)).toBe(false)
  })

  it('does nothing when no verified update is waiting', () => {
    expect(swapInPlace(exe)).toBe(false)
    expect(readFileSync(exe, 'utf8')).toBe('old build')
  })

  it('restores the previous build if a swap was interrupted between its renames', async () => {
    const s = sidecars(exe)
    rmSync(exe)
    writeFileSync(s.old, 'old build')
    await cleanupLeftovers(exe)
    expect(readFileSync(exe, 'utf8')).toBe('old build')
  })

  it('fails cleanly on a missing feed', async () => {
    await expect(fetchFeed(fetch, `${base}/nope.json`)).rejects.toThrow(/404/)
  })
})
