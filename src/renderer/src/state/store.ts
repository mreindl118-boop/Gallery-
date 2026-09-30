import { create } from 'zustand'
import type { ImportIssue, ImportProgress, ImportStatus, PhotoSummary } from '@shared/ingest'
import type { EngineEvent } from '@shared/rpc'
import type {
  EngineState,
  LibraryStatus,
  ProjectSummary,
  ResolvedTheme,
  ThemePreference,
  UpdateStatus
} from '@shared/schemas'

export interface Notice {
  id: number
  text: string
  tone: 'info' | 'error'
  /** One quiet button, e.g. "Restart to update". Notices with an action stay until used or dismissed. */
  action?: { label: string; run: () => void }
  /** Notices with the same key replace each other. */
  key?: string
}

/** The photos of an open project, in import order. */
export interface PhotoList {
  /** Sorted by `seq`. A new array on every change; unchanged photos keep their object identity. */
  items: PhotoSummary[]
  /** id → seq, to find a photo again when an update for it arrives. Owned by this list (mutated as it grows). */
  seqById: Map<string, number>
  /** The first full read through photos.list has finished. */
  loaded: boolean
}

interface AppState {
  booted: boolean
  bootError: string | null
  status: LibraryStatus | null
  projects: ProjectSummary[]
  theme: ResolvedTheme
  themePreference: ThemePreference
  engine: EngineState
  updates: UpdateStatus | null
  version: string
  /** Project whose title is being edited in place. */
  renaming: string | null
  notices: Notice[]
  settingsOpen: boolean
  /** The project whose screen is showing, or null for the Library. */
  openProject: string | null
  /** The card to focus when the Library comes back from a project. */
  returnFocus: string | null
  /** Import progress per project id. Missing: not read yet. null: couldn't be read. */
  progress: Record<string, ImportProgress | null>
  /** Photos of open projects only (read on open, dropped on close to keep memory flat). */
  photos: Record<string, PhotoList>
  /** Files that couldn't be imported, per project id. */
  issues: Record<string, ImportIssue[]>
  /** A drag carrying files is over the window. */
  dragging: boolean
  /** On the Library: the project card under that drag. */
  dropProject: string | null
  set: (patch: Partial<AppState>) => void
  notify: (text: string, tone?: Notice['tone'], extra?: Pick<Notice, 'action' | 'key'>) => void
  dismiss: (id: number) => void
  setProgress: (progress: ImportProgress) => void
  setStatus: (id: string, status: ImportStatus) => void
  /** Merge photos into an open project's list; `loaded` marks the first full read as finished. */
  mergePhotos: (id: string, photos: PhotoSummary[], loaded?: boolean) => void
  /** Apply one ~10 Hz batch of engine events in a single store update. */
  applyEngineEvents: (batch: EngineEvent[]) => void
}

let noticeId = 0

export const emptyPhotoList = (): PhotoList => ({ items: [], seqById: new Map(), loaded: false })

export const useApp = create<AppState>((set) => ({
  booted: false,
  bootError: null,
  status: null,
  projects: [],
  theme: 'light',
  themePreference: 'system',
  engine: 'starting',
  updates: null,
  version: '',
  renaming: null,
  notices: [],
  settingsOpen: false,
  openProject: null,
  returnFocus: null,
  progress: {},
  photos: {},
  issues: {},
  dragging: false,
  dropProject: null,
  set: (patch) => set(patch),
  notify: (text, tone = 'info', extra) =>
    set((s) => {
      const kept = extra?.key ? s.notices.filter((n) => n.key !== extra.key) : s.notices
      return { notices: [...kept.slice(-2), { id: ++noticeId, text, tone, ...extra }] }
    }),
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  setProgress: (progress) => set((s) => ({ progress: { ...s.progress, [progress.projectId]: progress } })),
  setStatus: (id, status) =>
    set((s) => ({
      progress: { ...s.progress, [id]: status.progress },
      issues: { ...s.issues, [id]: status.issues }
    })),
  mergePhotos: (id, photos, loaded) =>
    set((s) => {
      const list = s.photos[id]
      if (!list) return s
      const merged = mergePhotoList(list, photos)
      const next = loaded && !merged.loaded ? { ...merged, loaded: true } : merged
      return next === list ? s : { photos: { ...s.photos, [id]: next } }
    }),
  applyEngineEvents: (batch) => set((s) => reduceEngineEvents(s, batch))
}))

/** Engine events → one partial state (or the same state when nothing we keep changed). */
function reduceEngineEvents(s: AppState, batch: EngineEvent[]): AppState | Partial<AppState> {
  let progress = s.progress
  const photos = new Map<string, PhotoSummary[]>()
  const issues = new Map<string, ImportIssue[]>()
  for (const e of batch) {
    if (e.type === 'import.progress') {
      if (progress === s.progress) progress = { ...s.progress }
      progress[e.progress.projectId] = e.progress
    } else if (e.type === 'import.photos') {
      if (!s.photos[e.projectId]) continue
      const into = photos.get(e.projectId)
      if (into) into.push(...e.photos)
      else photos.set(e.projectId, [...e.photos])
    } else if (e.type === 'import.issue') {
      const into = issues.get(e.projectId)
      if (into) into.push(e.issue)
      else issues.set(e.projectId, [e.issue])
    }
  }
  const patch: Partial<AppState> = {}
  if (progress !== s.progress) patch.progress = progress
  if (photos.size) {
    const next = { ...s.photos }
    for (const [id, incoming] of photos) next[id] = mergePhotoList(next[id]!, incoming)
    patch.photos = next
  }
  if (issues.size) {
    const next = { ...s.issues }
    for (const [id, incoming] of issues) next[id] = mergeIssues(next[id] ?? [], incoming)
    patch.issues = next
  }
  return Object.keys(patch).length ? patch : s
}

/** Keep what we already know when an update arrives without it (e.g. a list page older than an event). */
function mergePhoto(old: PhotoSummary, p: PhotoSummary): PhotoSummary {
  const next: PhotoSummary = {
    ...p,
    lqip: p.lqip ?? old.lqip,
    thumb: p.thumb ?? old.thumb,
    display: p.display ?? old.display,
    takenAt: p.takenAt ?? old.takenAt
  }
  const same =
    next.seq === old.seq &&
    next.thumb === old.thumb &&
    next.lqip === old.lqip &&
    next.display === old.display &&
    next.width === old.width &&
    next.height === old.height &&
    next.name === old.name &&
    next.originalPath === old.originalPath &&
    next.takenAt === old.takenAt &&
    next.bytes === old.bytes &&
    next.format === old.format
  return same ? old : next
}

/** First index in `items` (sorted by seq) whose seq is ≥ `seq`. */
function lowerBound(items: PhotoSummary[], seq: number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (items[mid]!.seq < seq) lo = mid + 1
    else hi = mid
  }
  return lo
}

function indexOfPhoto(items: PhotoSummary[], id: string, seq: number): number {
  for (let i = lowerBound(items, seq); i < items.length && items[i]!.seq === seq; i++) {
    if (items[i]!.id === id) return i
  }
  return items.findIndex((p) => p.id === id)
}

function insertBySeq(items: PhotoSummary[], p: PhotoSummary): void {
  const last = items[items.length - 1]
  if (!last || last.seq <= p.seq) items.push(p)
  else items.splice(lowerBound(items, p.seq + 1), 0, p)
}

/**
 * Merge photos into a list by id, keeping import order. New photos almost
 * always come last, so this is an append plus one array copy per batch.
 */
export function mergePhotoList(list: PhotoList, incoming: PhotoSummary[]): PhotoList {
  if (!incoming.length) return list
  let items: PhotoSummary[] | null = null
  const seqById = list.seqById
  for (const p of incoming) {
    const seq = seqById.get(p.id)
    const arr = items ?? list.items
    const at = seq === undefined ? -1 : indexOfPhoto(arr, p.id, seq)
    const old = at >= 0 ? arr[at] : undefined
    if (old) {
      const next = mergePhoto(old, p)
      if (next === old) continue
      items ??= list.items.slice()
      if (next.seq === old.seq) {
        items[at] = next
      } else {
        items.splice(at, 1)
        insertBySeq(items, next)
      }
      seqById.set(p.id, next.seq)
    } else {
      items ??= list.items.slice()
      insertBySeq(items, p)
      seqById.set(p.id, p.seq)
    }
  }
  return items ? { ...list, items } : list
}

/** Merge issues by id; the newest report of an issue wins. */
export function mergeIssues(list: ImportIssue[], incoming: ImportIssue[]): ImportIssue[] {
  if (!incoming.length) return list
  const byId = new Map(list.map((i) => [i.id, i]))
  for (const i of incoming) byId.set(i.id, i)
  return [...byId.values()]
}

/** Surface an RPC failure in plain words. */
export function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  useApp.getState().notify(message, 'error')
}
