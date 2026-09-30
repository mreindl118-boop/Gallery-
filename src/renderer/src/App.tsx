import { Notices } from './components/Notices'
import { SettingsDialog } from './components/SettingsDialog'
import { FirstRunScreen } from './screens/FirstRunScreen'
import { LibraryScreen } from './screens/LibraryScreen'
import { useApp } from './state/store'

export function App() {
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
