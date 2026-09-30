import { existsSync, mkdtempSync, promises as fs, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library, PROJECT_DIRS } from '../src/main/library'
import { writeJsonAtomic } from '@shared/node/atomic-json'

let root: string
let trashed: string[]
const deps = () => ({
  trash: async (p: string) => {
    trashed.push(p)
    await fs.rm(p, { recursive: true })
  }
})

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'gl-lib-')), 'Library')
  trashed = []
})
afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }))

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

describe('Library', () => {
  it('creates self-contained project folders', async () => {
    const lib = new Library(root, deps())
    await lib.rescan()
    const p = await lib.create('Kyoto, winter')
    expect(p.folder).toBe('Kyoto, winter')
    for (const d of PROJECT_DIRS) expect(existsSync(join(root, p.folder, d))).toBe(true)
    const pj = read(join(root, p.folder, 'project.json'))
    expect(pj).toMatchObject({ schemaVersion: 1, id: p.id, name: 'Kyoto, winter', importMode: 'copy' })
    expect(pj.seed).toBeGreaterThanOrEqual(0)
    expect(read(join(root, 'library.json')).order).toEqual([p.id])
  })

  it('puts new projects first and keeps a stored order across rescans', async () => {
    const lib = new Library(root, deps())
    await lib.rescan()
    const a = await lib.create('A')
    const b = await lib.create('B')
    expect(lib.list().map((p) => p.name)).toEqual(['B', 'A'])
    await lib.reorder([a.id, b.id])
    const again = new Library(root, deps())
    expect((await again.rescan()).map((p) => p.name)).toEqual(['A', 'B'])
  })

  it('renames the folder, collision-safe and case-only', async () => {
    const lib = new Library(root, deps())
    await lib.rescan()
    const a = await lib.create('Night shifts')
    await lib.create('Coast')
    const r1 = await lib.rename(a.id, 'Coast')
    expect(r1.folder).toBe('Coast 2')
    const r2 = await lib.rename(a.id, 'coast 2')
    expect(r2.folder).toBe('coast 2')
    expect(r2.name).toBe('coast 2')
    const names = (await fs.readdir(root)).filter((n) => !n.endsWith('.json'))
    expect(names.sort()).toEqual(['Coast', 'coast 2'])
    expect(read(join(root, 'coast 2', 'project.json')).name).toBe('coast 2')
  })

  it('serializes concurrent creates without folder collisions', async () => {
    const lib = new Library(root, deps())
    await lib.rescan()
    const made = await Promise.all(Array.from({ length: 12 }, () => lib.create('Untitled project')))
    expect(new Set(made.map((p) => p.folder.toLowerCase())).size).toBe(12)
  })

  it('trashes through the injected Recycle Bin', async () => {
    const lib = new Library(root, deps())
    await lib.rescan()
    const a = await lib.create('Gone')
    await lib.trash(a.id)
    expect(trashed).toEqual([join(root, 'Gone')])
    expect(lib.list()).toEqual([])
    expect(read(join(root, 'library.json')).order).toEqual([])
  })

  it('rebuilds the registry from folders and ignores foreign ones', async () => {
    const lib = new Library(root, deps())
    await lib.rescan()
    const a = await lib.create('Keep')
    await fs.mkdir(join(root, 'Holiday snaps'))
    await fs.writeFile(join(root, 'library.json'), '{ broken')
    const again = new Library(root, deps())
    const list = await again.rescan()
    expect(list.map((p) => p.id)).toEqual([a.id])
    expect(read(join(root, 'library.json')).projects[a.id].folder).toBe('Keep')
  })

  it('gives a copied project folder its own id', async () => {
    const lib = new Library(root, deps())
    await lib.rescan()
    const a = await lib.create('Original')
    await fs.cp(join(root, 'Original'), join(root, 'Original copy'), { recursive: true })
    const list = await lib.rescan()
    expect(list).toHaveLength(2)
    const orig = list.find((p) => p.folder === 'Original')!
    const copy = list.find((p) => p.folder === 'Original copy')!
    expect(orig.id).toBe(a.id)
    expect(copy.id).not.toBe(a.id)
    expect(read(join(root, 'Original copy', 'project.json')).id).toBe(copy.id)
  })

  it('refuses project files from a newer schema instead of rewriting them', async () => {
    await fs.mkdir(join(root, 'Future'), { recursive: true })
    await writeJsonAtomic(join(root, 'Future', 'project.json'), { schemaVersion: 99, name: 'Future' })
    const lib = new Library(root, deps())
    expect(await lib.rescan()).toEqual([])
    expect(read(join(root, 'Future', 'project.json')).schemaVersion).toBe(99)
  })
})

describe('writeJsonAtomic', () => {
  it('leaves no temp files and writes complete documents', async () => {
    await fs.mkdir(root, { recursive: true })
    const f = join(root, 'x.json')
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(f, { i, pad: 'x'.repeat(10_000) })))
    expect(read(f).pad).toHaveLength(10_000)
    expect((await fs.readdir(root)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})
