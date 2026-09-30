import type { ThemePreference } from '@shared/schemas'
import { useApp, reportError } from '../state/store'
import { Button } from './Button'
import { Dialog, DialogActions, DialogClose } from './Dialog'
import './settings.css'

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Follow Windows' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Darkroom' }
]

const ENGINE_WORDS = {
  starting: 'Starting',
  ready: 'Running',
  restarting: 'Restarting after a problem',
  failed: 'Stopped after repeated problems. Restart galleryLAB.'
} as const

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen)
  const set = useApp((s) => s.set)
  const pref = useApp((s) => s.themePreference)
  const status = useApp((s) => s.status)
  const version = useApp((s) => s.version)
  const engine = useApp((s) => s.engine)
  const isMac = window.gallery.platform === 'darwin'

  const chooseTheme = async (theme: ThemePreference) => {
    set({ themePreference: theme })
    try {
      await window.gallery.invoke('settings.setTheme', { theme })
    } catch (err) {
      reportError(err)
    }
  }

  const changeLibrary = async () => {
    try {
      const path = await window.gallery.invoke('library.pickFolder')
      if (!path) return
      const next = await window.gallery.invoke('library.setLocation', { path })
      const projects = await window.gallery.invoke('projects.list')
      set({ status: next, projects })
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => set({ settingsOpen: o })} title="Settings" width={520}>
      <section className="settings-section" aria-labelledby="set-appearance">
        <h3 id="set-appearance" className="settings-heading">
          Appearance
        </h3>
        <div
          className="segmented"
          role="radiogroup"
          aria-labelledby="set-appearance"
          onKeyDown={(e) => {
            const step =
              e.key === 'ArrowRight' || e.key === 'ArrowDown'
                ? 1
                : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                  ? -1
                  : 0
            if (!step) return
            e.preventDefault()
            const i = THEMES.findIndex((t) => t.value === pref)
            const next = THEMES[(i + step + THEMES.length) % THEMES.length]!
            void chooseTheme(next.value)
            requestAnimationFrame(() =>
              (e.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus()
            )
          }}
        >
          {THEMES.map((t) => (
            <button
              key={t.value}
              role="radio"
              data-value={t.value}
              tabIndex={pref === t.value ? 0 : -1}
              aria-checked={pref === t.value}
              className="segment"
              onClick={() => chooseTheme(t.value)}
            >
              {t.value === 'system' && isMac ? 'Follow macOS' : t.label}
            </button>
          ))}
        </div>
        <p className="settings-note">Darkroom is a neutral gray with no tint, for judging photos as in an editor.</p>
      </section>

      <section className="settings-section" aria-labelledby="set-library">
        <h3 id="set-library" className="settings-heading">
          Library
        </h3>
        <p className="settings-path">{status && 'path' in status ? status.path : 'Not chosen yet'}</p>
        <div className="settings-row">
          <Button onClick={() => window.gallery.invoke('library.reveal').catch(reportError)}>
            {isMac ? 'Show in Finder' : 'Show in Explorer'}
          </Button>
          <Button onClick={changeLibrary}>Change location</Button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="set-about">
        <h3 id="set-about" className="settings-heading">
          About
        </h3>
        <dl className="settings-facts">
          <dt>Version</dt>
          <dd>{version}</dd>
          <dt>Engine</dt>
          <dd>{ENGINE_WORDS[engine]}</dd>
        </dl>
      </section>

      <DialogActions>
        <DialogClose asChild>
          <Button variant="primary">Done</Button>
        </DialogClose>
      </DialogActions>
    </Dialog>
  )
}
