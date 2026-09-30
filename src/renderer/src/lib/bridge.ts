import { useApp } from '../state/store'

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
    }
  })

  const [info, settings, status] = await Promise.all([
    g.invoke('app.info'),
    g.invoke('settings.get'),
    g.invoke('library.status')
  ])
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
