import { watch, type FSWatcher, promises as fs } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import type { LibraryProblem, ProjectSummary } from '@shared/schemas'
import { Library, type LibraryDeps } from './library'

export type OpenResult = { ok: true } | { ok: false; problem: LibraryProblem }

export interface LibraryHostDeps extends LibraryDeps {
  /** Folders a Library must never live in (the app's own install folder: updates replace it). */
  forbiddenRoots: () => string[]
  onChanged: (projects: ProjectSummary[]) => void
  platform?: NodeJS.Platform
}

/**
 * Owns which Library is open. A folder is checked before anything switches
 * to it, so a failed Change location keeps the current Library open, and a
 * Library that went missing is reported instead of being recreated empty.
 * Electron-free so it can be unit-tested.
 */
export class LibraryHost {
  library: Library | null = null
  private watcher: FSWatcher | null = null
  private opening: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: LibraryHostDeps) {}

  /** Resolves once any open in progress has finished (for RPCs arriving during startup). */
  settled(): Promise<void> {
    return this.opening.then(
      () => undefined,
      () => undefined
    )
  }

  private insideForbidden(path: string): boolean {
    const win = (this.deps.platform ?? process.platform) === 'win32'
    const norm = (p: string) => (win ? resolve(p).toLowerCase() : resolve(p))
    const target = norm(path)
    return this.deps.forbiddenRoots().some((root) => {
      const rel = relative(norm(root), target)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
  }

  /** Check a folder can hold a Library, creating it only when asked. Never changes what is open. */
  async check(path: string, create: boolean): Promise<OpenResult> {
    if (this.insideForbidden(path)) return { ok: false, problem: 'inside-app' }
    try {
      const st = await fs.stat(path)
      if (!st.isDirectory()) return { ok: false, problem: 'unwritable' }
    } catch {
      if (!create) return { ok: false, problem: 'missing' }
      try {
        await fs.mkdir(path, { recursive: true })
      } catch {
        return { ok: false, problem: 'unwritable' }
      }
    }
    const probe = join(path, `.gallerylab-write-test-${process.pid}-${Date.now()}`)
    try {
      await fs.writeFile(probe, '')
    } catch {
      return { ok: false, problem: 'unwritable' }
    } finally {
      await fs.rm(probe, { force: true }).catch(() => undefined)
    }
    return { ok: true }
  }

  /** Check, scan, and only then switch to the folder. */
  open(path: string, create: boolean): Promise<OpenResult> {
    const run = this.opening.then(
      () => this.openNow(path, create),
      () => this.openNow(path, create)
    )
    this.opening = run
    return run
  }

  private async openNow(path: string, create: boolean): Promise<OpenResult> {
    const checked = await this.check(path, create)
    if (!checked.ok) return checked
    const lib = new Library(path, { trash: this.deps.trash, ...(this.deps.now ? { now: this.deps.now } : {}) })
    try {
      await lib.rescan()
    } catch {
      return { ok: false, problem: 'unreadable' }
    }
    this.close()
    this.library = lib
    this.watcher = this.watch(lib)
    return { ok: true }
  }

  /** Pick up projects renamed, added or removed in Explorer. */
  private watch(lib: Library): FSWatcher | null {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const w = watch(lib.root, { persistent: false }, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          if (this.library !== lib) return
          const before = JSON.stringify(lib.list())
          lib.rescan().then(
            (projects) => {
              if (this.library === lib && JSON.stringify(projects) !== before) this.deps.onChanged(projects)
            },
            () => undefined
          )
        }, 400)
      })
      w.on('error', () => undefined)
      return w
    } catch {
      return null
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    this.library = null
  }
}
