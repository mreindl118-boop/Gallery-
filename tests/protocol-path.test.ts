import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { galleryUrl, isInside, resolveInsideRoot } from '../src/main/protocol-path'

const root = resolve('/lib/Project')

describe('resolveInsideRoot', () => {
  it('resolves ordinary paths inside the project', () => {
    expect(resolveInsideRoot(root, '/.gallery/derivatives/thumb-512/a.webp')).toBe(
      join(root, '.gallery', 'derivatives', 'thumb-512', 'a.webp')
    )
    expect(resolveInsideRoot(root, '/originals/Caf%C3%A9%20%E6%9D%B1%E4%BA%AC/1.jpg')).toBe(
      join(root, 'originals', 'Café 東京', '1.jpg')
    )
  })

  it('refuses traversal, drive letters, streams and malformed escapes', () => {
    for (const p of [
      '/../x',
      '/a/../../x',
      '/..%2F..%2Fx',
      '/%2e%2e/x',
      '/C:%5CWindows',
      '/a:stream',
      '/%zz',
      '/',
      '/%00',
      '/a%5C..%5C..%5Cx'
    ]) {
      expect(resolveInsideRoot(root, p), p).toBeNull()
    }
  })

  it('never resolves outside the root (property)', () => {
    const segment = fc.oneof(
      fc.constantFrom('..', '.', '%2e%2e', '%2E%2E', '..%5C', '%5C', '%2F', 'C:', '\\', '/', ''),
      fc.string({ maxLength: 8 })
    )
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 8 }), (parts) => {
        const r = resolveInsideRoot(root, `/${parts.join('/')}`)
        if (r !== null) expect(isInside(root, r)).toBe(true)
      }),
      { numRuns: 5000 }
    )
  })

  it('round-trips galleryUrl', () => {
    const url = new URL(galleryUrl('3f1c8a52-0000-4000-8000-000000000000', 'originals/Café #1/a b.jpg'))
    expect(url.hostname).toBe('3f1c8a52-0000-4000-8000-000000000000')
    expect(resolveInsideRoot(root, url.pathname)).toBe(join(root, 'originals', 'Café #1', 'a b.jpg'))
  })
})

describe('isInside with real symlinks', () => {
  const base = mkdtempSync(join(tmpdir(), 'gl-proto-'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  it('flags a link that escapes once resolved', async () => {
    const proj = join(base, 'proj')
    const outside = join(base, 'outside')
    mkdirSync(proj)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'x')
    try {
      symlinkSync(outside, join(proj, 'link'), 'junction')
    } catch {
      return // Symlinks unavailable (unprivileged Windows): nothing to test.
    }
    const { realpathSync } = await import('node:fs')
    const target = resolveInsideRoot(proj, '/link/secret.txt')!
    expect(isInside(proj, target)).toBe(true) // lexically inside…
    expect(isInside(realpathSync(proj), realpathSync(target))).toBe(false) // …but not really.
  })
})
