import type { UpdateStatus } from '@shared/schemas'
import { reportError, useApp } from '../state/store'

/** Wire main-process and engine events into the store. Called once at startup. */
export async function boot(): Promise<void> {
  const g = window.gallery
  const { set } = useApp.getState()

  g.onEvent((e) => {
    switch (e.type) {
      case 'library.changed':
        set({ projects: e.projects })
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
        set({ engine: e.state })
        break
      case 'updates.status':
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
  onUpdateStatus(updates)
  applyTheme(info.resolvedTheme)
  const projects = status.state === 'ready' ? await g.invoke('projects.list') : []
  set({
    version: info.version,
    engine: info.engine,
    themePreference: settings.theme,
    status,
    projects,
    booted: true
  })
}

export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset['theme'] = theme
  useApp.getState().set({ theme })
}

let announced: string | null = null

/** Keep the store current and say once, quietly, when an update is ready to install. */
function onUpdateStatus(status: UpdateStatus): void {
  const { set, notify } = useApp.getState()
  set({ updates: status })
  if (status.phase === 'ready' && status.version && announced !== status.version) {
    announced = status.version
    notify(`galleryLAB ${status.version} is ready. It installs when you quit.`, 'info', {
      key: 'update-ready',
      action: {
        label: 'Restart to update',
        run: () => void window.gallery.invoke('updates.install').catch(reportError)
      }
    })
  }
}
