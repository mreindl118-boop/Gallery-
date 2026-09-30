import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { droppedFolderName, isInside, isSkippedDir, isSkippedFile, joinPosix } from './paths'

/**
 * Streaming discovery of dropped files and folders. Each directory is read on
 * its own and its files are yielded before descending, so the first file comes
 * out right away and memory stays at one directory listing plus the pending
 * folder stack. Symlinks and junctions inside the tree are never followed.
 */

export interface Discovered {
  /** Absolute path of the file as dropped. */
  source: string
  /** Folder under originals/ it lands in, relative with forward slashes ('' for a loose file). */
  relDir: string
}

export interface WalkOptions {
  /** Absolute folders never to enter (the project's own originals/ and .gallery/). */
  exclude?: string[]
  /** Checked between directories; stops the walk when true. */
  aborted?: () => boolean
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export async function* walk(paths: Iterable<string>, opts: WalkOptions = {}): AsyncGenerator<Discovered> {
  const exclude = opts.exclude ?? []
  const excluded = (p: string) => exclude.some((e) => isInside(e, p))
  for (const input of paths) {
    if (opts.aborted?.()) return
    if (excluded(input)) continue
    let stat
    try {
      // A dropped shortcut is followed once, on purpose; links inside folders are not.
      stat = await fs.stat(input)
    } catch {
      yield { source: input, relDir: '' } // fails later as an unreadable file, with a reason
      continue
    }
    if (stat.isFile()) {
      if (!isSkippedFile(basename(input))) yield { source: input, relDir: '' }
    } else if (stat.isDirectory()) {
      yield* walkDir(input, droppedFolderName(input), excluded, opts)
    }
  }
}

async function* walkDir(
  top: string,
  topRel: string,
  excluded: (p: string) => boolean,
  opts: WalkOptions
): AsyncGenerator<Discovered> {
  const stack: { dir: string; rel: string }[] = [{ dir: top, rel: topRel }]
  while (stack.length > 0) {
    if (opts.aborted?.()) return
    const { dir, rel } = stack.pop()!
    const files: string[] = []
    const dirs: string[] = []
    try {
      const handle = await fs.opendir(dir, { bufferSize: 256 })
      for await (const entry of handle) {
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (!isSkippedDir(entry.name)) dirs.push(entry.name)
        } else if (entry.isFile()) {
          if (!isSkippedFile(entry.name)) files.push(entry.name)
        }
      }
    } catch {
      // Unreadable folder (permissions, removed meanwhile): skip it and keep going.
      continue
    }
    files.sort(collator.compare)
    for (const name of files) yield { source: join(dir, name), relDir: rel }
    dirs.sort(collator.compare)
    for (let i = dirs.length - 1; i >= 0; i--) {
      const name = dirs[i]!
      const path = join(dir, name)
      if (!excluded(path)) stack.push({ dir: path, rel: joinPosix(rel, name) })
    }
  }
}
