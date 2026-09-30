import { useState } from 'react'
import type { LibraryStatus } from '@shared/schemas'
import { Button } from '../components/Button'
import { Plinth } from '../components/Plinth'
import { TitleBar } from '../components/TitleBar'
import { reportError, useApp } from '../state/store'
import './first-run.css'

/** Choosing (or re-finding) the Library folder. */
export function FirstRunScreen({ status }: { status: Exclude<LibraryStatus, { state: 'ready' }> }) {
  const set = useApp((s) => s.set)
  const [busy, setBusy] = useState(false)
  const suggested = status.state === 'missing' ? status.path : status.defaultPath

  const openAt = async (path: string) => {
    setBusy(true)
    try {
      const next = await window.gallery.invoke('library.setLocation', { path })
      const projects = next.state === 'ready' ? await window.gallery.invoke('projects.list') : []
      set({ status: next, projects })
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(false)
    }
  }

  const choose = async () => {
    try {
      const path = await window.gallery.invoke('library.pickFolder')
      if (path) await openAt(path)
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <div className="screen first-run">
      <TitleBar />
      <main className="first-run-main">
        <div className="first-run-text">
          {status.state === 'unset' ? (
            <>
              <h1 className="first-run-title display">Where should your Library live?</h1>
              <p className="first-run-body">
                The Library is a folder of project folders. Each project keeps its photos, its exhibition and everything
                you change, so you can move it or back it up like any other folder.
              </p>
            </>
          ) : (
            <>
              <h1 className="first-run-title display">Your Library folder isn’t available</h1>
              <p className="first-run-body">
                galleryLAB can’t find or write to this folder. Reconnect the drive it lives on and try again, or choose
                another folder.
              </p>
            </>
          )}
          <p className="first-run-path" title={suggested}>
            {suggested}
          </p>
          <div className="first-run-actions">
            <Button variant="primary" disabled={busy} onClick={() => openAt(suggested)}>
              {status.state === 'unset' ? 'Use this folder' : 'Try again'}
            </Button>
            <Button disabled={busy} onClick={choose}>
              Choose another folder
            </Button>
          </div>
        </div>
        <Plinth className="first-run-plinth" size={170} height={26} />
      </main>
    </div>
  )
}
