import { existsSync, mkdtempSync, promises as fs, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library } from '../src/main/library'
import { LibraryHost } from '../src/main/library-host'
import { writeJsonAtomic } from '@shared/node/atomic-json'

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gl-host-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const host = (forbidden: string[] = [], platform: NodeJS.Platform = 'linux') =>
  new LibraryHost({
    trash: async (p) => fs.rm(p, { recursive: true }),
    forbiddenRoots: () => forbidden,
    onChanged: () => undefined,
    platform
  })

describe('LibraryHost', () => {
  it('reports a missing Library instead of recreating it', async () => {
    const h = host()
    const gone = join(base, 'Moved away')
    expect(await h.open(gone, false)).toEqual({ ok: false, problem: 'missing' })
    expect(existsSync(gone)).toBe(false)
    expect(h.library).toBeNull()
  })

  it('creates a Library folder only when asked (first run, picked folder)', async () => {
    const h = host()
    const fresh = join(base, 'Pictures', 'galleryLAB')
    expect(await h.open(fresh, true)).toEqual({ ok: true })
    expect(existsSync(join(fresh, 'library.json'))).toBe(true)
    expect(h.library?.root).toBe(fresh)
  })

  it('keeps the current Library open when switching to an unusable folder fails', async () => {
    const h = host()
    const good = join(base, 'Good')
    await h.open(good, true)
    const file = join(base, 'not-a-folder.txt')
    writeFileSync(file, 'x')
    expect(await h.open(file, true)).toEqual({ ok: false, problem: 'unwritable' })
    expect(await h.open(join(base, 'nope'), false)).toEqual({ ok: false, problem: 'missing' })
    expect(h.library?.root).toBe(good)
  })

  it('refuses a Library inside the program folder, case-insensitively on Windows', async () => {
    const program = join(base, 'Programs', 'galleryLAB')
    await fs.mkdir(program, { recursive: true })
    const h = host([program], 'win32')
    expect(await h.open(program, true)).toEqual({ ok: false, problem: 'inside-app' })
    expect(await h.open(join(program, 'Library'), true)).toEqual({ ok: false, problem: 'inside-app' })
    expect(await h.open(join(base, 'PROGRAMS', 'GALLERYLAB', 'x'), true)).toEqual({ ok: false, problem: 'inside-app' })
    expect(await h.open(join(base, 'Programs', 'galleryLAB-sibling'), true)).toEqual({ ok: true })
  })

  it('leaves no write-test files behind', async () => {
    const h = host()
    const dir = join(base, 'Lib')
    await h.open(dir, true)
    expect(readdirSync(dir).filter((n) => n.startsWith('.gallerylab-write-test'))).toEqual([])
  })
})

describe('Library safety', () => {
  const lib = async () => {
    const root = join(base, 'Library')
    const l = new Library(root, {
      trash: async () => {
        throw new Error('Failed to move item to trash')
      }
    })
    await l.rescan()
    return { l, root }
  }

  it('explains a failed Recycle Bin move and never deletes the project', async () => {
    const { l, root } = await lib()
    const p = await l.create('On a USB stick')
    await expect(l.trash(p.id)).rejects.toThrow(/Recycle Bin.*delete the folder “On a USB stick” in Explorer/s)
    expect(existsSync(join(root, 'On a USB stick', 'project.json'))).toBe(true)
    expect(l.list()).toHaveLength(1)
  })

  it('refuses to rename or delete when the folder on disk is no longer that project', async () => {
    const { l, root } = await lib()
    const a = await l.create('Alpha')
    // Someone swaps the folder's contents in Explorer.
    const pj = join(root, 'Alpha', 'project.json')
    const doc = JSON.parse(await fs.readFile(pj, 'utf8'))
    await writeJsonAtomic(pj, { ...doc, id: '11111111-2222-4333-8444-555555555555' })
    await expect(l.rename(a.id, 'Beta')).rejects.toThrow(/changed on disk/)
    expect(existsSync(join(root, 'Alpha'))).toBe(true)
    await expect(l.trash(a.id)).rejects.toThrow(/no longer in the Library/)
  })

  it('keeps an unreadable or newer library.json aside instead of overwriting it', async () => {
    const root = join(base, 'Library')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(join(root, 'library.json'), JSON.stringify({ schemaVersion: 7, future: true }))
    const l = new Library(root, { trash: async () => undefined })
    await l.rescan()
    const kept = readdirSync(root).filter((n) => n.startsWith('library.unreadable-'))
    expect(kept).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(join(root, kept[0]!), 'utf8'))).toEqual({ schemaVersion: 7, future: true })
    expect(JSON.parse(await fs.readFile(join(root, 'library.json'), 'utf8')).schemaVersion).toBe(1)
  })
})
