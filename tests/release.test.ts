import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareVersions, portableFeedUrls, PortableFeed, RELEASES_REPO } from '@shared/release'
import { AppSettings } from '@shared/schemas'

describe('compareVersions', () => {
  it('orders releases and prereleases', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('99.0.0', '0.1.1')).toBeGreaterThan(0)
  })

  it('is antisymmetric (property)', () => {
    const v = fc
      .tuple(fc.nat(30), fc.nat(30), fc.nat(30), fc.option(fc.constantFrom('alpha', 'beta.1', 'beta.2', 'rc.1')))
      .map(([a, b, c, p]) => `${a}.${b}.${c}${p ? `-${p}` : ''}`)
    fc.assert(
      fc.property(v, v, (a, b) => {
        expect(Math.sign(compareVersions(a, b))).toBe(-Math.sign(compareVersions(b, a)))
      }),
      { numRuns: 2000 }
    )
  })
})

describe('update feeds', () => {
  it('points at the public releases repo configured for electron-builder', () => {
    const yml = readFileSync(resolve(__dirname, '../electron-builder.yml'), 'utf8')
    const publish = yml.slice(yml.indexOf('publish:'))
    expect(publish).toMatch(new RegExp(`owner:\\s*${RELEASES_REPO.owner}\\b`))
    expect(publish).toMatch(new RegExp(`repo:\\s*${RELEASES_REPO.repo}\\b`))
    expect(publish).toMatch(/provider:\s*github/)
  })

  it('builds GitHub and test-feed URLs', () => {
    expect(portableFeedUrls(null, '0.1.1', 'galleryLAB-0.1.1-portable.exe')).toEqual({
      feed: 'https://github.com/mreindl118-boop/galleryLAB-releases/releases/latest/download/latest-portable.json',
      asset:
        'https://github.com/mreindl118-boop/galleryLAB-releases/releases/download/v0.1.1/galleryLAB-0.1.1-portable.exe'
    })
    expect(portableFeedUrls('http://127.0.0.1:8765', '9.0.0', 'a b.exe')).toEqual({
      feed: 'http://127.0.0.1:8765/latest-portable.json',
      asset: 'http://127.0.0.1:8765/a%20b.exe'
    })
  })

  it('rejects feeds that name a path instead of a file', () => {
    const base = { version: '1.0.0', size: 10, sha512: 'x'.repeat(88), releaseDate: 'now' }
    expect(PortableFeed.safeParse({ ...base, file: 'galleryLAB.exe' }).success).toBe(true)
    expect(PortableFeed.safeParse({ ...base, file: '..\\evil.exe' }).success).toBe(false)
    expect(PortableFeed.safeParse({ ...base, file: 'C:evil.exe' }).success).toBe(false)
    expect(PortableFeed.safeParse({ ...base, file: 'notes.txt' }).success).toBe(false)
  })
})

describe('settings', () => {
  it('reads 0.1.0 settings files without autoUpdate and turns updates on', () => {
    const old = {
      schemaVersion: 1,
      libraryPath: 'C:\\Users\\a\\Pictures\\galleryLAB',
      theme: 'system',
      defaultImportMode: 'copy',
      units: 'auto',
      centerlineCm: 145
    }
    expect(AppSettings.parse(old).autoUpdate).toBe(true)
  })
})
