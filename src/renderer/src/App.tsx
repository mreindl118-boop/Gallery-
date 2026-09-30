import { useEffect } from 'react'
import { useWindowDrop } from './components/DropTarget'
import { Notices } from './components/Notices'
import { SettingsDialog } from './components/SettingsDialog'
import { UpdatingOverlay } from './components/UpdatingOverlay'
import { FirstRunScreen } from './screens/FirstRunScreen'
import { LibraryScreen } from './screens/LibraryScreen'
import { ProjectScreen } from './screens/ProjectScreen'
import { closeProject } from './lib/bridge'
import { useApp } from './state/store'

export function App() {
  useWindowDrop()
  const booted = useApp((s) => s.booted)
  const status = useApp((s) => s.status)
  const bootError = useApp((s) => s.bootError)
  const project = useApp((s) => (s.openProject ? s.projects.find((p) => p.id === s.openProject) : undefined))
  const openId = useApp((s) => s.openProject)
  const ready = status?.state === 'ready'

  // The open project went away (moved to the Recycle Bin, removed in Explorer, Library unavailable): back to the Library.
  useEffect(() => {
    if (openId && (!project || !ready)) closeProject()
  }, [openId, project, ready])

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
      {!ready ? (
        <FirstRunScreen status={status} />
      ) : project ? (
        <ProjectScreen key={project.id} project={project} />
      ) : (
        <LibraryScreen />
      )}
      <SettingsDialog />
      <Notices />
      <UpdatingOverlay />
    </>
  )
}
