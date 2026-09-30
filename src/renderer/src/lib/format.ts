import type { ImportProgress } from '@shared/ingest'

/** Plain-language facts for cards and panels. Sentence case, no dot-separated strings. */

/** "1 photo", "1,204 photos". */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export function photoCountLine(count: number): string {
  if (count === 0) return 'No photos yet'
  return plural(count, 'photo', 'photos')
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function editedLine(iso: string, created: string, now = new Date()): string {
  const d = new Date(iso)
  const verb = iso === created ? 'Created' : 'Edited'
  if (Number.isNaN(d.getTime())) return verb
  if (sameDay(d, now)) return `${verb} today`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return `${verb} yesterday`
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' }
  return `${verb} ${d.toLocaleDateString(undefined, opts)}`
}

/* Import */

export const isImporting = (p: ImportProgress | null | undefined): boolean =>
  p?.state === 'discovering' || p?.state === 'importing'

/** Share of the current run that is finished, 0–99 while work remains (100 only reads as done). */
export function importPercent(p: ImportProgress): number {
  if (p.total <= 0) return 0
  return Math.max(0, Math.min(99, Math.floor((p.done / p.total) * 100)))
}

/** The Library card's second line while a project is importing, or null when it isn't. */
export function cardImportLine(p: ImportProgress | null | undefined): string | null {
  if (!p) return null
  if (isImporting(p)) return `Importing ${importPercent(p)}%`
  if (p.state === 'paused') return `Import paused at ${importPercent(p)}%`
  return null
}

export function timeLeftLine(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null
  if (seconds < 5) return 'Almost done.'
  if (seconds < 15) return 'A few seconds left.'
  if (seconds < 60) return 'Less than a minute left.'
  const minutes = Math.round(seconds / 60)
  if (minutes < 2) return 'About a minute left.'
  if (minutes < 60) return `About ${minutes} minutes left.`
  const hours = Math.round(seconds / 3600)
  if (hours < 2) return 'About an hour left.'
  return `About ${hours.toLocaleString()} hours left.`
}

/** The one calm line at the top of the import panel. */
export function importHeadline(p: ImportProgress): string {
  const done = p.done.toLocaleString()
  switch (p.state) {
    case 'discovering':
      if (p.done === 0) {
        return p.total > 0
          ? `Looking for photos. ${plural(p.total, 'file', 'files')} found so far.`
          : 'Looking for photos.'
      }
      return `Importing ${done} of ${plural(p.total, 'photo', 'photos')} found so far.`
    case 'importing': {
      const left = timeLeftLine(p.secondsLeft)
      return `Importing ${done} of ${plural(p.total, 'photo', 'photos')}.${left ? ` ${left}` : ''}`
    }
    case 'paused':
      return `Paused at ${done} of ${plural(p.total, 'photo', 'photos')}.`
    case 'done':
      if (p.imported > 0) return `${plural(p.imported, 'photo', 'photos')} imported.`
      if (p.total > 0) return 'No new photos imported.'
      return p.photos > 0
        ? `${plural(p.photos, 'photo', 'photos')} in this project.`
        : 'No photos found in what you added.'
    case 'idle':
      return p.photos > 0 ? `${plural(p.photos, 'photo', 'photos')} in this project.` : 'No photos yet.'
  }
}

/** Quiet second lines under the headline: throughput, duplicates, failures. */
export function importDetails(p: ImportProgress): string[] {
  const lines: string[] = []
  // Throughput only matters for batches big enough to wait for.
  if (isImporting(p) && p.filesPerSecond >= 1 && p.total >= 200) {
    lines.push(`${plural(Math.round(p.filesPerSecond), 'photo', 'photos')} a second`)
  }
  if (p.duplicates > 0) lines.push(`${plural(p.duplicates, 'duplicate', 'duplicates')} skipped`)
  if (p.failed > 0) lines.push(`${plural(p.failed, 'file', 'files')} couldn’t be imported`)
  if (p.state === 'done' && p.imported > 0 && p.photos > p.imported) {
    lines.push(`${plural(p.photos, 'photo', 'photos')} in this project`)
  }
  return lines
}

/** Split an absolute path (Windows or POSIX) into the file name and its folder. */
export function splitPath(path: string): { name: string; folder: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? { name: path, folder: '' } : { name: path.slice(i + 1), folder: path.slice(0, i) }
}

/** "C:\Users\ana\Pictures\2024\Trip\Day 2" → "C:\…\Trip\Day 2": the root and the nearest folders that fit. */
export function shortenFolder(folder: string, max = 44): string {
  if (folder.length <= max) return folder
  const sep = folder.includes('\\') ? '\\' : '/'
  const parts = folder.split(/[\\/]/)
  const head = parts[0] ?? ''
  let tail = parts[parts.length - 1] ?? ''
  if (head.length + tail.length + 3 > max) return `…${tail.slice(-(max - 1))}`
  for (let i = parts.length - 2; i > 0; i--) {
    const next = `${parts[i]}${sep}${tail}`
    if (head.length + next.length + 3 > max) break
    tail = next
  }
  return `${head}${sep}…${sep}${tail}`
}
