/**
 * Turning a project name into a Windows-safe folder name, and picking a
 * free one. Pure so it can be property-tested; the filesystem is passed in
 * as the set of names already taken.
 */

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g
export const MAX_FOLDER_LENGTH = 80

export function folderNameFor(name: string): string {
  let s = name.normalize('NFC').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim()
  // Windows strips trailing dots and spaces; a leading dot would hide the folder.
  s = s.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '')
  if (s.length > MAX_FOLDER_LENGTH) s = trimToLength(s, MAX_FOLDER_LENGTH)
  if (s === '') s = 'Untitled project'
  if (RESERVED.test(s)) s = `${s} project`
  return s
}

/** Cut at a code-point boundary and clean up the new tail. */
function trimToLength(s: string, max: number): string {
  const chars = Array.from(s)
  return chars
    .slice(0, max)
    .join('')
    .replace(/[. ]+$/g, '')
}

/**
 * First free variant of `base` ("Name", "Name 2", "Name 3", ...), compared
 * case-insensitively the way NTFS does. `own` is the folder currently used by
 * the project being renamed, which never counts as a collision.
 */
export function uniqueFolderName(base: string, taken: Iterable<string>, own?: string): string {
  const lower = new Set<string>()
  for (const t of taken) lower.add(t.toLowerCase())
  if (own) lower.delete(own.toLowerCase())
  if (!lower.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`
    const stem = Array.from(base)
      .slice(0, MAX_FOLDER_LENGTH - suffix.length)
      .join('')
      .replace(/[. ]+$/g, '')
    const candidate = `${stem}${suffix}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}
