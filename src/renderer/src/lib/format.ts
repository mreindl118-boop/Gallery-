import type { BuildProgress, BuildStage, GenerationEstimate, GeneratorProvider } from '@shared/build'
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

/** "0:05", "2:14", "1:02:14". Null when the length is unknown. */
export function durationLabel(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

/** "11 photos", "2 videos" or "11 photos and 2 videos": what a count of mixed media is made of. */
export function mediaCount(total: number, videos: number): string {
  const photos = total - videos
  if (videos <= 0) return plural(total, 'photo', 'photos')
  if (photos <= 0) return plural(videos, 'video', 'videos')
  return `${plural(photos, 'photo', 'photos')} and ${plural(videos, 'video', 'videos')}`
}

/** While a run is going, what the files are called: photos until a video turns up, then plain files. */
function fileNoun(p: ImportProgress, n: number): string {
  if (p.importedVideos <= 0) return plural(n, 'photo', 'photos')
  if (p.importedVideos >= p.imported) return plural(n, 'video', 'videos')
  return plural(n, 'file', 'files')
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
      return `Importing ${done} of ${fileNoun(p, p.total)} found so far.`
    case 'importing': {
      const left = timeLeftLine(p.secondsLeft)
      return `Importing ${done} of ${fileNoun(p, p.total)}.${left ? ` ${left}` : ''}`
    }
    case 'paused':
      return `Paused at ${done} of ${fileNoun(p, p.total)}.`
    case 'done':
      if (p.imported > 0) return `${mediaCount(p.imported, p.importedVideos)} imported.`
      if (p.total > 0) return 'No new photos imported.'
      return p.photos > 0 ? `${mediaCount(p.photos, p.videos)} in this project.` : 'No photos found in what you added.'
    case 'idle':
      return p.photos > 0 ? `${mediaCount(p.photos, p.videos)} in this project.` : 'No photos yet.'
  }
}

/** Quiet second lines under the headline: throughput, duplicates, failures. */
export function importDetails(p: ImportProgress): string[] {
  const lines: string[] = []
  // Throughput only matters for batches big enough to wait for.
  if (isImporting(p) && p.filesPerSecond >= 1 && p.total >= 200) {
    lines.push(`${fileNoun(p, Math.round(p.filesPerSecond))} a second`)
  }
  if (p.duplicates > 0) lines.push(`${plural(p.duplicates, 'duplicate', 'duplicates')} skipped`)
  if (p.failed > 0) lines.push(`${plural(p.failed, 'file', 'files')} couldn’t be imported`)
  if (p.state === 'done' && p.imported > 0 && p.photos > p.imported) {
    lines.push(`${mediaCount(p.photos, p.videos)} in this project`)
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

/* Build */

export const PROVIDER_NAMES: Record<GeneratorProvider, string> = {
  none: 'None',
  stability: 'Stability AI',
  openai: 'OpenAI',
  xai: 'xAI'
}

export const BUILD_STAGES: Array<{ value: BuildStage; label: string }> = [
  { value: 'reading', label: 'Reading' },
  { value: 'theming', label: 'Theming' },
  { value: 'generating', label: 'Making assets' }
]

export const isBuilding = (b: BuildProgress | null | undefined): boolean =>
  b?.state === 'waiting' || b?.state === 'running'

/** Share of the build that is finished, 0–99 while work remains. */
export function buildPercent(b: BuildProgress): number {
  return Math.max(0, Math.min(99, Math.floor(b.fraction * 100)))
}

/** The Library card's second line while a project builds, or null when it isn't. */
export function cardBuildLine(b: BuildProgress | null | undefined): string | null {
  if (!b) return null
  if (isBuilding(b)) return `Building ${buildPercent(b)}%`
  if (b.state === 'paused') return `Build paused at ${buildPercent(b)}%`
  return null
}

/** "$0.48", "$5", "$12.50": money without noise. */
export function usd(n: number): string {
  const whole = Number.isInteger(n) || Math.abs(n - Math.round(n)) < 0.005
  return `$${whole ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** What the next generating run will cost, before it starts. */
export function estimateLine(e: GenerationEstimate, capUsd: number): string {
  if (e.provider === 'none' || e.images <= 0) return 'No images will be made.'
  const name = PROVIDER_NAMES[e.provider]
  const head = `Will make ${plural(e.images, 'image', 'images')} with ${name}, about ${usd(e.totalUsd)}.`
  return e.withinCap
    ? `${head} Your cap is ${usd(capUsd)}.`
    : `${head} That is over your cap of ${usd(capUsd)}, so nothing will be made until you raise it or lower the images per build.`
}
