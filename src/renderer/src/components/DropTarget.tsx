import { useEffect } from 'react'
import { importPaths } from '../lib/bridge'
import { useApp } from '../state/store'
import './drop-target.css'

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

/** The project card under a point, if any (cards carry data-project-id). */
function cardAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>('[data-project-id]')?.dataset['projectId'] ?? null
}

/**
 * Window-wide drop handling. On a project's screen a drop anywhere imports into it; on the Library a drop
 * onto a project card imports into that project, and a drop elsewhere says what to do instead. The renderer
 * only turns dropped files into paths; the engine reads them.
 */
export function useWindowDrop(): void {
  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      clearTimeout(idle)
      const { dragging, dropProject, set } = useApp.getState()
      if (dragging || dropProject) set({ dragging: false, dropProject: null })
    }

    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const { openProject, dragging, dropProject, set, status } = useApp.getState()
      const ready = status?.state === 'ready'
      const target = ready && !openProject ? cardAt(e.target) : null
      if (e.dataTransfer) e.dataTransfer.dropEffect = ready && (openProject || target) ? 'copy' : 'none'
      if (!dragging || dropProject !== target) set({ dragging: true, dropProject: target })
      // Dragover repeats while the drag stays over the window; when it stops, the drag has left.
      clearTimeout(idle)
      idle = setTimeout(clear, 350)
    }

    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) clear()
    }

    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      clear()
      const { openProject, status, notify } = useApp.getState()
      if (status?.state !== 'ready') return
      const id = openProject ?? cardAt(e.target)
      if (!id) {
        notify('Open a project, then drop photos or folders into it.', 'info', { key: 'drop' })
        return
      }
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.gallery.pathForFile(f)).filter(Boolean)
      if (!paths.length) {
        notify('Those items aren’t files on this computer. Drop photos or folders from File Explorer.', 'info', {
          key: 'drop'
        })
        return
      }
      void importPaths(id, paths)
    }

    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      clearTimeout(idle)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])
}

/** A restrained overlay while files are dragged over a project's screen: an accent inset outline and one line. */
export function DropOverlay({ projectName }: { projectName: string }) {
  const dragging = useApp((s) => s.dragging)
  if (!dragging) return null
  return (
    <div className="drop-overlay" aria-hidden="true">
      <p className="drop-overlay-text">Drop to import into {projectName}</p>
    </div>
  )
}
