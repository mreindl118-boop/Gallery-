import { useEffect } from 'react'
import type { GeneratedAsset } from '@shared/build'
import type { ImportIssue } from '@shared/ingest'
import type { ProjectSummary } from '@shared/schemas'
import { Button } from '../components/Button'
import { ContactSheet } from '../components/ContactSheet'
import { DropOverlay } from '../components/DropTarget'
import { GeneratedStrip } from '../components/GeneratedStrip'
import { ImportPanel } from '../components/ImportPanel'
import { TitleBar } from '../components/TitleBar'
import { closeProject, pickAndImport } from '../lib/bridge'
import { isImporting } from '../lib/format'
import { useApp } from '../state/store'
import './project.css'

const NO_ISSUES: ImportIssue[] = []
const NO_ASSETS: GeneratedAsset[] = []

/** A project's screen: a calm drop invitation while it is empty, then the contact sheet and the import panel. */
export function ProjectScreen({ project }: { project: ProjectSummary }) {
  const id = project.id
  const set = useApp((s) => s.set)
  const list = useApp((s) => s.photos[id])
  const progress = useApp((s) => s.progress[id])
  const issues = useApp((s) => s.issues[id] ?? NO_ISSUES)
  const assets = useApp((s) => s.assets[id] ?? NO_ASSETS)

  // Escape goes back to the Library, unless a dialog or menu is open or someone is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"]')
      const modal = document.querySelector('[role="dialog"], [role="menu"]')
      if (typing || modal) return
      e.preventDefault()
      closeProject()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const photos = list?.items ?? []
  const loaded = list?.loaded ?? false
  const working = isImporting(progress) || progress?.state === 'paused'
  const empty = loaded && photos.length === 0 && !working && issues.length === 0

  return (
    <div className="screen project-screen">
      <TitleBar>
        <Button onClick={() => set({ settingsOpen: true })}>Settings</Button>
      </TitleBar>

      <header className="project-header">
        <Button className="project-back" onClick={closeProject}>
          Library
        </Button>
        <h1 className="project-name display">{project.name}</h1>
      </header>

      {!loaded && photos.length === 0 ? (
        // First read still running: show nothing rather than flash the wrong view.
        <main className="project-import" aria-busy="true" />
      ) : empty ? (
        <main className="project-empty">
          <div className="project-empty-text">
            <p className="project-empty-line display">Drop photos or folders anywhere in the window.</p>
            <div className="project-empty-actions">
              <Button variant="primary" onClick={() => pickAndImport(id, 'files')}>
                Add photos
              </Button>
              <Button onClick={() => pickAndImport(id, 'folder')}>Add folder</Button>
            </div>
          </div>
        </main>
      ) : (
        <main className="project-import">
          <div className="project-sheet">
            <div className="project-sheet-grid">
              <ContactSheet projectId={id} photos={photos} />
            </div>
            <GeneratedStrip projectId={id} assets={assets} />
          </div>
          <ImportPanel projectId={id} progress={progress} issues={issues} />
        </main>
      )}

      <DropOverlay projectName={project.name} />
    </div>
  )
}
