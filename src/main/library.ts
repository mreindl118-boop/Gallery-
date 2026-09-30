import { randomInt, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { folderNameFor, uniqueFolderName } from '@shared/names'
import {
  LIBRARY_SCHEMA_VERSION,
  LibraryFile,
  PROJECT_SCHEMA_VERSION,
  ProjectFile,
  type ImportMode,
  type ProjectSummary
} from '@shared/schemas'
import { GalleryError } from '@shared/rpc'
import { readJsonVersioned, writeJsonAtomic } from '@shared/node/atomic-json'

export const LIBRARY_FILE = 'library.json'
export const PROJECT_FILE = 'project.json'

/** Folders every project has. `.gallery/` is derived and rebuilt on demand. */
export const PROJECT_DIRS = ['originals', 'exhibition', 'exhibition/history', '.gallery', 'exports'] as const

interface Entry {
  folder: string
  project: ProjectFile
}

export interface LibraryDeps {
  /** Moves a folder to the Recycle Bin (shell.trashItem in the app). */
  trash: (path: string) => Promise<void>
  now?: () => Date
}

/**
 * The Library is a folder of project folders. library.json only holds the
 * order and the id → folder registry; the project folders are the truth and
 * a rescan rebuilds the registry from them.
 *
 * All mutations are serialized through one queue so concurrent RPCs (or a
 * watcher-triggered rescan) never interleave filesystem work.
 */
export class Library {
  private entries = new Map<string, Entry>()
  private order: string[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private lastPersisted = ''

  constructor(
    readonly root: string,
    private readonly deps: LibraryDeps
  ) {}

  private get now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  projectRoot(id: string): string | null {
    const e = this.entries.get(id)
    return e ? join(this.root, e.folder) : null
  }

  list(): ProjectSummary[] {
    return this.order.flatMap((id) => {
      const e = this.entries.get(id)
      return e ? [summary(e)] : []
    })
  }

  /** Rebuild the registry from the folders on disk. */
  rescan(): Promise<ProjectSummary[]> {
    return this.serial(() => this.rescanNow())
  }

  private async rescanNow(): Promise<ProjectSummary[]> {
    await fs.mkdir(this.root, { recursive: true })
    const stored = await readJsonVersioned(join(this.root, LIBRARY_FILE), LibraryFile, LIBRARY_SCHEMA_VERSION).catch(
      () => null
    )

    const dirents = await fs.readdir(this.root, { withFileTypes: true })
    const folders = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))

    const found = new Map<string, Entry>()
    for (const folder of folders) {
      const file = join(this.root, folder, PROJECT_FILE)
      let project: ProjectFile | null
      try {
        project = await readJsonVersioned(file, ProjectFile, PROJECT_SCHEMA_VERSION)
      } catch {
        continue // Unreadable project.json: not ours to touch.
      }
      if (!project) continue
      const clash = found.get(project.id)
      if (clash) {
        // A copied project folder inside the same Library. The folder the
        // registry already knows keeps the id; the copy gets a fresh one.
        const registered = stored?.projects[project.id]?.folder
        const [keeper, copy] = registered === folder ? [{ folder, project }, clash] : [clash, { folder, project }]
        const renewed: ProjectFile = { ...copy.project, id: randomUUID() }
        await writeJsonAtomic(join(this.root, copy.folder, PROJECT_FILE), renewed)
        found.set(keeper.project.id, keeper)
        found.set(renewed.id, { folder: copy.folder, project: renewed })
        continue
      }
      found.set(project.id, { folder, project })
    }

    const kept = (stored?.order ?? []).filter((id) => found.has(id))
    const keptSet = new Set(kept)
    const added = [...found.keys()]
      .filter((id) => !keptSet.has(id))
      .sort((a, b) => found.get(a)!.project.created.localeCompare(found.get(b)!.project.created))

    this.entries = found
    this.order = [...kept, ...added]
    await this.persist()
    return this.list()
  }

  create(name: string, importMode: ImportMode = 'copy'): Promise<ProjectSummary> {
    return this.serial(async () => {
      const folder = uniqueFolderName(folderNameFor(name), await this.folderNames())
      const dir = join(this.root, folder)
      const stamp = this.now.toISOString()
      const project: ProjectFile = {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: randomUUID(),
        name,
        created: stamp,
        updated: stamp,
        seed: randomInt(0, 0xffffffff),
        settings: { centerlineCm: 145 },
        importMode
      }
      await fs.mkdir(dir, { recursive: false }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST')
          throw new GalleryError('exists', `A folder named “${folder}” appeared just now. Try again.`)
        throw err
      })
      for (const sub of PROJECT_DIRS) await fs.mkdir(join(dir, sub), { recursive: true })
      await writeJsonAtomic(join(dir, PROJECT_FILE), project)
      const entry = { folder, project }
      this.entries.set(project.id, entry)
      this.order = [project.id, ...this.order]
      await this.persist()
      return summary(entry)
    })
  }

  rename(id: string, name: string): Promise<ProjectSummary> {
    return this.serial(async () => {
      const entry = this.require(id)
      const target = uniqueFolderName(folderNameFor(name), await this.folderNames(), entry.folder)
      const from = join(this.root, entry.folder)
      if (target !== entry.folder) {
        const to = join(this.root, target)
        if (target.toLowerCase() === entry.folder.toLowerCase()) {
          // Case-only rename: NTFS needs a hop through a temporary name.
          const hop = join(this.root, `.${target}.${randomUUID().slice(0, 8)}.renaming`)
          await renameFolder(from, hop)
          await renameFolder(hop, to)
        } else {
          await renameFolder(from, to)
        }
      }
      const project: ProjectFile = { ...entry.project, name, updated: this.now.toISOString() }
      await writeJsonAtomic(join(this.root, target, PROJECT_FILE), project)
      const next = { folder: target, project }
      this.entries.set(id, next)
      await this.persist()
      return summary(next)
    })
  }

  trash(id: string): Promise<void> {
    return this.serial(async () => {
      const entry = this.require(id)
      await this.deps.trash(join(this.root, entry.folder))
      this.entries.delete(id)
      this.order = this.order.filter((x) => x !== id)
      await this.persist()
    })
  }

  reorder(ids: string[]): Promise<ProjectSummary[]> {
    return this.serial(async () => {
      const known = ids.filter((id) => this.entries.has(id))
      const rest = this.order.filter((id) => !known.includes(id))
      this.order = [...new Set([...known, ...rest])]
      await this.persist()
      return this.list()
    })
  }

  private require(id: string): Entry {
    const e = this.entries.get(id)
    if (!e)
      throw new GalleryError(
        'not-found',
        'That project is no longer in the Library. It may have been moved or deleted outside galleryLAB.'
      )
    return e
  }

  private async folderNames(): Promise<string[]> {
    const dirents = await fs.readdir(this.root, { withFileTypes: true })
    return dirents.map((d) => d.name)
  }

  private async persist(): Promise<void> {
    const doc: LibraryFile = {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      order: this.order,
      projects: Object.fromEntries([...this.entries].map(([id, e]) => [id, { folder: e.folder }]))
    }
    // Skip identical writes so a folder watcher reacting to our own write settles.
    const key = JSON.stringify(doc)
    if (key === this.lastPersisted) return
    await writeJsonAtomic(join(this.root, LIBRARY_FILE), doc)
    this.lastPersisted = key
  }
}

function summary({ folder, project }: Entry): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    folder,
    created: project.created,
    updated: project.updated,
    importMode: project.importMode,
    photoCount: 0
  }
}

async function renameFolder(from: string, to: string): Promise<void> {
  let delay = 50
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 5) {
        await new Promise((r) => setTimeout(r, delay))
        delay *= 2
        continue
      }
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        throw new GalleryError(
          'busy',
          'Windows is holding a file in this project open, so it can’t be renamed right now. Close any Explorer windows or apps using it and try again.'
        )
      }
      throw err
    }
  }
}
