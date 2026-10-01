import type { GenerationEstimate, GeneratorSettings } from '@shared/build'
import type { ProjectSummary, UpdateStatus } from '@shared/schemas'
import { whenInstalled } from '../components/UpdatesSection'
import { emptyPhotoList, reportError, useApp } from '../state/store'

/** Wire main-process and engine events into the store. Called once at startup. */
export async function boot(): Promise<void> {
  const g = window.gallery
  const { set } = useApp.getState()
  let engineFromEvent = false
  let updatesFromEvent = false

  g.onEngineEvents((batch) => useApp.getState().applyEngineEvents(batch))

  g.onEvent((e) => {
    switch (e.type) {
      case 'library.changed':
        set({ projects: e.projects })
        readNewStatuses(e.projects)
        break
      case 'library.status':
        set({ status: e.status })
        break
      case 'theme.changed':
        applyTheme(e.resolved)
        break
      case 'settings.changed':
        set({ themePreference: e.settings.theme })
        break
      case 'engine.state':
        engineFromEvent = true
        set({ engine: e.state })
        // A (re)started engine may have resumed work: read every project's import state again.
        if (e.state === 'ready') refreshAfterEngineStart()
        break
      case 'updates.status':
        updatesFromEvent = true
        onUpdateStatus(e.status)
        break
    }
  })

  const [info, settings, status, updates] = await Promise.all([
    g.invoke('app.info'),
    g.invoke('settings.get'),
    g.invoke('library.status'),
    g.invoke('updates.status')
  ])
  // An update event that arrived while booting is newer than this snapshot.
  if (!updatesFromEvent) onUpdateStatus(updates)
  applyTheme(info.resolvedTheme)
  const projects = status.state === 'ready' ? await g.invoke('projects.list') : []
  set({
    version: info.version,
    // An engine event that arrived while booting is newer than the app.info snapshot.
    ...(engineFromEvent ? {} : { engine: info.engine }),
    themePreference: settings.theme,
    status,
    projects,
    booted: true
  })
  readNewStatuses(projects)
  void loadGenerator()
}

/* Import */

/** Read a project's import progress and issues into the store. Failures leave `null` (shown as the saved count). */
export async function readStatus(id: string): Promise<void> {
  try {
    useApp.getState().setStatus(id, await window.gallery.invoke('import.status', { id }))
  } catch {
    const { progress, set } = useApp.getState()
    if (progress[id] === undefined) set({ progress: { ...progress, [id]: null } })
  }
}

/** Read the status of projects the store knows nothing about yet (after boot, when projects appear). */
function readNewStatuses(projects: ProjectSummary[]): void {
  const { progress, builds } = useApp.getState()
  for (const p of projects) {
    if (progress[p.id] === undefined) void readStatus(p.id)
    if (builds[p.id] === undefined) void readBuild(p.id)
  }
}

function refreshAfterEngineStart(): void {
  const { projects, openProject } = useApp.getState()
  for (const p of projects) {
    void readStatus(p.id)
    void readBuild(p.id)
  }
  if (openProject) {
    void loadPhotos(openProject)
    void loadAssets(openProject)
  }
}

const PAGE = 5000
let loadToken = 0

/** Read every photo of a project page by page into its (fresh) list; events arriving meanwhile merge in. */
export async function loadPhotos(id: string): Promise<void> {
  const token = ++loadToken
  const { set, photos } = useApp.getState()
  if (!photos[id]) set({ photos: { ...photos, [id]: emptyPhotoList() } })
  void readStatus(id)
  try {
    for (let offset = 0; ; offset += PAGE) {
      const page = await window.gallery.invoke('photos.list', { id, offset, limit: PAGE })
      // The project was closed (or opened again) meanwhile: stop.
      if (token !== loadToken || !useApp.getState().photos[id]) return
      const last = page.length < PAGE
      useApp.getState().mergePhotos(id, page, last)
      if (last) return
    }
  } catch (err) {
    if (token !== loadToken || !useApp.getState().photos[id]) return
    useApp.getState().mergePhotos(id, [], true)
    reportError(err)
  }
}

/** Open a project's screen. */
export function openProject(id: string): void {
  const { set } = useApp.getState()
  set({ openProject: id, returnFocus: id, dragging: false, dropProject: null })
  void loadPhotos(id)
  void readBuild(id)
  void loadAssets(id)
}

/** Back to the Library; the project's photos are dropped so memory stays flat. */
export function closeProject(): void {
  const { openProject: id, photos, set } = useApp.getState()
  if (!id) return
  loadToken++
  const next = { ...photos }
  delete next[id]
  const assets = { ...useApp.getState().assets }
  delete assets[id]
  set({ openProject: null, photos: next, assets, dragging: false, dropProject: null })
}

/** Start importing paths into a project; progress then arrives as engine events. */
export async function importPaths(id: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  try {
    useApp.getState().setProgress(await window.gallery.invoke('import.add', { id, paths }))
  } catch (err) {
    reportError(err)
  }
}

export async function pickAndImport(id: string, kind: 'files' | 'folder'): Promise<void> {
  try {
    const paths = await window.gallery.invoke(kind === 'files' ? 'import.pickFiles' : 'import.pickFolder')
    await importPaths(id, paths)
  } catch (err) {
    reportError(err)
  }
}

type Control = 'import.pause' | 'import.resume' | 'import.cancel'

export async function controlImport(id: string, method: Control): Promise<void> {
  try {
    useApp.getState().setProgress(await window.gallery.invoke(method, { id }))
  } catch (err) {
    reportError(err)
  }
}

/** Retry some (or all retryable) issues. Retried issues leave the list; ones that fail again come back as events. */
export async function retryIssues(id: string, issueIds?: number[]): Promise<void> {
  try {
    const progress = await window.gallery.invoke('import.retry', issueIds ? { id, issueIds } : { id })
    useApp.getState().setProgress(progress)
    await readStatus(id)
  } catch (err) {
    reportError(err)
  }
}

/* Build */

/** Read a project's build progress into the store. Failures leave `null` (the panel then shows nothing). */
export async function readBuild(id: string): Promise<void> {
  try {
    useApp.getState().setBuild(await window.gallery.invoke('build.status', { id }))
  } catch {
    const { builds, set } = useApp.getState()
    if (builds[id] === undefined) set({ builds: { ...builds, [id]: null } })
  }
}

type BuildControl = 'build.start' | 'build.pause' | 'build.resume' | 'build.cancel'

export async function controlBuild(id: string, method: BuildControl): Promise<void> {
  try {
    useApp.getState().setBuild(await window.gallery.invoke(method, { id }))
  } catch (err) {
    reportError(err)
  }
}

/** Read an open project's generated assets; ones that arrive as events meanwhile merge in. */
export async function loadAssets(id: string): Promise<void> {
  try {
    const assets = await window.gallery.invoke('build.assets', { id })
    if (useApp.getState().openProject === id) useApp.getState().setAssets(id, assets)
  } catch {
    // The strip simply stays empty; the next build event or open reads again.
  }
}

/** What the next generating run will cost; null when it can't be read (no project, engine busy). */
export async function readEstimate(id: string): Promise<GenerationEstimate | null> {
  try {
    return await window.gallery.invoke('generator.estimate', { id })
  } catch {
    return null
  }
}

/* Generator */

export async function loadGenerator(): Promise<void> {
  try {
    useApp.getState().set({ generator: await window.gallery.invoke('generator.settings') })
  } catch (err) {
    reportError(err)
  }
}

/** Run a generator call and keep the store's settings current. */
export async function updateGenerator(call: Promise<GeneratorSettings>): Promise<boolean> {
  try {
    useApp.getState().set({ generator: await call })
    // Each status request carries the current provider key to the engine, so a
    // build that is waiting to generate can carry on with the new settings.
    for (const p of useApp.getState().projects) void readBuild(p.id)
    return true
  } catch (err) {
    reportError(err)
    return false
  }
}

export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset['theme'] = theme
  useApp.getState().set({ theme })
}

let announced: string | null = null

/** Keep the store current and say once, quietly, when an update is ready to install. */
function onUpdateStatus(status: UpdateStatus): void {
  const { set, notify, notices, dismiss } = useApp.getState()
  set({ updates: status })
  if (status.phase !== 'ready') {
    // The update stopped being installable (installed, failed, or removed): drop its notice.
    for (const n of notices) if (n.key === 'update-ready') dismiss(n.id)
    if (status.phase !== 'checking' && status.phase !== 'downloading') announced = null
  }
  if (status.phase === 'ready' && status.version && announced !== status.version) {
    announced = status.version
    notify(`galleryLAB ${status.version} is ready. ${whenInstalled(status)}`, 'info', {
      key: 'update-ready',
      action: {
        label: 'Restart to update',
        run: () => void window.gallery.invoke('updates.install').catch(reportError)
      }
    })
  }
}
