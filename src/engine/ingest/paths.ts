import { basename, extname, isAbsolute, relative, sep, toNamespacedPath } from 'node:path'

/**
 * Pure path helpers for ingest: what to skip while walking, where a dropped
 * file lands under originals/, and collision-safe names.
 */

/** Folders that belong to the system, sync tools or other apps, never to the photographer. */
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '__macosx', '@eadir', 'recycler', 'lost+found'])
/** Files that operating systems scatter around. */
const SKIP_FILES = new Set(['thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', 'desktop.ini', 'icon\r', 'folder.jpg.lnk'])
/** Sidecars written next to photos by editors and phones; they carry no pixels. */
const SIDECARS = new Set(['.xmp', '.aae', '.thm', '.lrv', '.pp3', '.dop', '.on1'])

export function isSkippedDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase())
}

export function isSkippedFile(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('~$')) return true
  const lower = name.toLowerCase()
  return SKIP_FILES.has(lower) || SIDECARS.has(extname(lower))
}

/** Forward-slash form of a relative path (what the database and gallery:// URLs use). */
export const toPosix = (p: string): string => p.split(sep).join('/').replace(/\\/g, '/')

/** Join relative posix segments, ignoring empty ones. */
export const joinPosix = (...parts: string[]): string => parts.filter((p) => p !== '').join('/')

/** Name a dropped folder keeps under originals/ (a drive root has no basename). */
export function droppedFolderName(dir: string): string {
  const name = basename(dir.replace(/[\\/]+$/, ''))
  if (name && name !== '.' && !/^[a-z]:$/i.test(name)) return name
  const drive = /^([a-z]):/i.exec(dir)
  return drive ? `Drive ${drive[1]!.toUpperCase()}` : 'Dropped folder'
}

/** True when `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** "IMG_1.jpg" → "IMG_1 (2).jpg". */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name
  const ext = extname(name)
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name
  return `${stem} (${n})${ext && ext !== name ? ext : ''}`
}

/**
 * Candidate relative targets for a file, in order: "dir/name", "dir/name (2)", ...
 * The caller checks each against the disk and the names it already reserved.
 */
export function* targetCandidates(relDir: string, name: string): Generator<string> {
  for (let n = 1; ; n++) yield joinPosix(relDir, numberedName(name, n))
}

/** Windows paths longer than MAX_PATH need the \\?\ prefix for native libraries (libvips). */
export function nativePath(p: string): string {
  return process.platform === 'win32' && p.length >= 240 ? toNamespacedPath(p) : p
}
