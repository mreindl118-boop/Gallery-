import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ProjectSummary } from '@shared/schemas'
import { Button } from '../components/Button'
import { Dialog, DialogActions, DialogClose } from '../components/Dialog'
import { Plinth } from '../components/Plinth'
import { ProjectCard } from '../components/ProjectCard'
import { TitleBar } from '../components/TitleBar'
import { reportError, useApp } from '../state/store'
import './library.css'

export function LibraryScreen() {
  const projects = useApp((s) => s.projects)
  const renaming = useApp((s) => s.renaming)
  const set = useApp((s) => s.set)
  const [trashing, setTrashing] = useState<ProjectSummary | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const cards = useRef(new Map<string, HTMLElement>())
  const creating = useRef(false)

  const createProject = useCallback(async () => {
    if (creating.current) return
    creating.current = true
    try {
      const p = await window.gallery.invoke('projects.create', { name: 'Untitled project' })
      const list = await window.gallery.invoke('projects.list')
      set({ projects: list, renaming: p.id })
      setFocusIndex(list.findIndex((x) => x.id === p.id))
    } catch (err) {
      reportError(err)
    } finally {
      creating.current = false
    }
  }, [set])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"]')
      const modal = document.querySelector('[role="dialog"], [role="menu"]')
      if (typing || modal) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void createProject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [createProject])

  const safeIndex = Math.min(focusIndex, Math.max(projects.length - 1, 0))

  const focusCard = (index: number) => {
    const p = projects[index]
    if (!p) return
    setFocusIndex(index)
    cards.current.get(p.id)?.focus()
  }

  const onKeyNav = (e: KeyboardEvent<HTMLElement>, index: number) => {
    const rects = projects.map((p) => cards.current.get(p.id)?.getBoundingClientRect())
    const here = rects[index]
    if (!here) return
    let next = -1
    if (e.key === 'ArrowRight') next = index + 1
    else if (e.key === 'ArrowLeft') next = index - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = projects.length - 1
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const down = e.key === 'ArrowDown'
      let best = Infinity
      rects.forEach((r, i) => {
        if (!r) return
        const rowOk = down ? r.top > here.top + 4 : r.top < here.top - 4
        if (!rowOk) return
        const score = Math.abs(r.top - here.top) * 4 + Math.abs(r.left - here.left)
        if (score < best) {
          best = score
          next = i
        }
      })
    } else return
    e.preventDefault()
    if (next >= 0 && next < projects.length) focusCard(next)
  }

  const rename = async (project: ProjectSummary, name: string | null) => {
    set({ renaming: null })
    const card = cards.current.get(project.id)
    // Give focus back to the card only if it was lost (Enter/Escape), not when the user clicked elsewhere.
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (!active || active === document.body) card?.focus()
    })
    if (!name) return
    try {
      await window.gallery.invoke('projects.rename', { id: project.id, name })
      set({ projects: await window.gallery.invoke('projects.list') })
    } catch (err) {
      reportError(err)
    }
  }

  const confirmTrash = async () => {
    const p = trashing
    setTrashing(null)
    if (!p) return
    try {
      await window.gallery.invoke('projects.trash', { id: p.id })
      set({ projects: await window.gallery.invoke('projects.list') })
      useApp.getState().notify(`“${p.name}” is in the Recycle Bin.`)
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <div className="screen library-screen">
      <TitleBar>
        <Button onClick={() => set({ settingsOpen: true })}>Settings</Button>
        {projects.length > 0 && (
          <Button variant="primary" onClick={createProject}>
            New project
          </Button>
        )}
      </TitleBar>

      <main className="library-main">
        {projects.length === 0 ? (
          <section className="library-empty">
            <Plinth className="library-empty-plinth" size={170} height={26} />
            <div className="library-empty-text">
              <h1 className="library-empty-title display">Your Library is empty</h1>
              <p className="library-empty-body">Create a project to begin. Adding photos arrives in the next update.</p>
              <Button variant="primary" onClick={createProject}>
                New project
              </Button>
            </div>
          </section>
        ) : (
          <>
            <h1 className="library-heading display">Library</h1>
            <div className="library-grid" role="list" aria-label="Projects">
              {projects.map((p, i) => (
                <div role="listitem" key={p.id}>
                  <ProjectCard
                    ref={(el) => {
                      if (el) cards.current.set(p.id, el)
                      else cards.current.delete(p.id)
                    }}
                    project={p}
                    renaming={renaming === p.id}
                    tabIndex={i === safeIndex ? 0 : -1}
                    onFocus={() => setFocusIndex(i)}
                    onStartRename={() => set({ renaming: p.id })}
                    onRename={(name) => rename(p, name)}
                    onTrash={() => setTrashing(p)}
                    onReveal={() => window.gallery.invoke('projects.reveal', { id: p.id }).catch(reportError)}
                    onKeyNav={(e) => onKeyNav(e, i)}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      <Dialog
        open={trashing !== null}
        onOpenChange={(o) => !o && setTrashing(null)}
        title={trashing ? `Move “${trashing.name}” to the Recycle Bin?` : ''}
        description="The project folder and everything in it goes to the Recycle Bin. You can restore it from there."
      >
        <DialogActions>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="danger" onClick={confirmTrash}>
            Move to Recycle Bin
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  )
}
