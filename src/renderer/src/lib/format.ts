/** Plain-language facts for cards and panels. Sentence case, no dot-separated strings. */

export function photoCountLine(count: number): string {
  if (count === 0) return 'No photos yet'
  return `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'}`
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
