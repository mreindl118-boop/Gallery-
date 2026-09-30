import type { UpdateStatus } from '@shared/schemas'
import { reportError, useApp } from '../state/store'
import { Button } from './Button'

function checkedLine(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return sameDay
    ? `Last checked today at ${time}.`
    : `Last checked ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}.`
}

function describe(s: UpdateStatus): string {
  switch (s.phase) {
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return `galleryLAB ${s.current} is up to date.`
    case 'available':
      return `galleryLAB ${s.version} is available.`
    case 'downloading':
      return `Downloading galleryLAB ${s.version}.`
    case 'ready':
      return `galleryLAB ${s.version} is ready. It installs when you quit.`
    case 'error':
      return s.message ?? 'galleryLAB couldn’t check for updates. Try again later.'
    default:
      return `You have galleryLAB ${s.current}.`
  }
}

/** Settings → Updates: what the updater is doing, one action at a time. */
export function UpdatesSection() {
  const s = useApp((st) => st.updates)
  const set = useApp((st) => st.set)
  if (!s) return null

  const call = (p: Promise<UpdateStatus | void>) => p.then((next) => next && set({ updates: next }), reportError)

  if (s.kind === 'none') {
    return (
      <p className="settings-note settings-note-flush">
        Updates are checked by the installed app. This copy of galleryLAB is a development build.
      </p>
    )
  }

  const where =
    s.kind === 'portable'
      ? 'galleryLAB replaces itself where it is, so shortcuts keep working.'
      : 'galleryLAB stays in the folder you installed it to.'

  return (
    <>
      <p className="updates-line" aria-live="polite">
        {describe(s)}
      </p>
      {s.phase === 'downloading' && (
        <div
          className="updates-progress"
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={s.percent ?? 0}
        >
          <div className="updates-progress-fill" style={{ width: `${s.percent ?? 0}%` }} />
        </div>
      )}
      {s.phase === 'available' && s.message && <p className="settings-note settings-note-flush">{s.message}</p>}
      {s.phase !== 'checking' && s.phase !== 'downloading' && checkedLine(s.lastChecked) && (
        <p className="settings-note settings-note-flush">{checkedLine(s.lastChecked)}</p>
      )}

      <div className="settings-row updates-actions">
        {s.phase === 'ready' ? (
          <Button variant="primary" onClick={() => call(window.gallery.invoke('updates.install'))}>
            Restart to update
          </Button>
        ) : s.phase === 'available' ? (
          <Button variant="primary" onClick={() => call(window.gallery.invoke('updates.download'))}>
            Download
          </Button>
        ) : (
          <Button
            disabled={s.phase === 'checking' || s.phase === 'downloading'}
            onClick={() => call(window.gallery.invoke('updates.check'))}
          >
            {s.phase === 'error' ? 'Try again' : 'Check for updates'}
          </Button>
        )}
        <Button onClick={() => call(window.gallery.invoke('updates.openReleases'))}>See all releases</Button>
      </div>

      <label className="updates-auto">
        <input
          type="checkbox"
          checked={s.auto}
          onChange={(e) => {
            const auto = e.target.checked
            set({ updates: { ...s, auto } })
            window.gallery.invoke('updates.setAuto', { auto }).then(
              (next) => set({ updates: next }),
              (err: unknown) => {
                // Saving failed: show the setting as it really is.
                const current = useApp.getState().updates
                if (current) set({ updates: { ...current, auto: !auto } })
                reportError(err)
              }
            )
          }}
        />
        <span>
          <span className="updates-auto-label">Update automatically</span>
          <span className="settings-note settings-note-flush">
            Download new versions in the background and install them when you quit. {where}
          </span>
        </span>
      </label>
    </>
  )
}
