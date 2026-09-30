import { useEffect } from 'react'
import { Notices } from './components/Notices'
import { SettingsDialog } from './components/SettingsDialog'
import { FirstRunScreen } from './screens/FirstRunScreen'
import { LibraryScreen } from './screens/LibraryScreen'
import { useApp } from './state/store'

/** Photo import arrives in M1; until then a drop gets a plain answer instead of silence. */
function useDropNotice() {
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      useApp
        .getState()
        .notify('Adding photos isn’t in this version yet. It arrives in the next update.', 'info', { key: 'drop' })
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
}

export function App() {
  useDropNotice()
  const booted = useApp((s) => s.booted)
  const status = useApp((s) => s.status)
  const bootError = useApp((s) => s.bootError)

  if (bootError) {
    return (
      <main className="boot-error">
        <h1 className="display">galleryLAB couldn’t start</h1>
        <p>{bootError}</p>
        <p>Quit and open galleryLAB again. If this keeps happening, restart Windows.</p>
      </main>
    )
  }
  if (!booted || !status) return null
  return (
    <>
      {status.state === 'ready' ? <LibraryScreen /> : <FirstRunScreen status={status} />}
      <SettingsDialog />
      <Notices />
    </>
  )
}
