import * as CM from '@radix-ui/react-context-menu'
import { forwardRef, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ProjectSummary } from '@shared/schemas'
import { editedLine, photoCountLine } from '../lib/format'
import { Plinth } from './Plinth'
import './project-card.css'

export interface ProjectCardProps {
  project: ProjectSummary
  renaming: boolean
  tabIndex: number
  onStartRename: () => void
  onRename: (name: string | null) => void
  onTrash: () => void
  onReveal: () => void
  onKeyNav: (e: KeyboardEvent<HTMLElement>) => void
  onFocus: () => void
}

export const ProjectCard = forwardRef<HTMLElement, ProjectCardProps>(function ProjectCard(
  { project, renaming, tabIndex, onStartRename, onRename, onTrash, onReveal, onKeyNav, onFocus },
  ref
) {
  const revealLabel = window.gallery.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer'

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (renaming || e.target !== e.currentTarget) return
    if (e.key === 'F2') {
      e.preventDefault()
      onStartRename()
    } else if (e.key === 'Delete') {
      e.preventDefault()
      onTrash()
    } else {
      onKeyNav(e)
    }
  }

  return (
    <CM.Root>
      <CM.Trigger asChild disabled={renaming}>
        <article
          ref={ref}
          className="project-card"
          tabIndex={tabIndex}
          aria-label={project.name}
          data-project-id={project.id}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
        >
          <div className="project-model">
            <Plinth className="project-plinth" />
          </div>
          {renaming ? (
            <RenameField initial={project.name} onDone={onRename} />
          ) : (
            <h2 className="project-title display" onDoubleClick={onStartRename}>
              {project.name}
            </h2>
          )}
          <p className="project-fact">{photoCountLine(project.photoCount)}</p>
          <p className="project-fact">{editedLine(project.updated, project.created)}</p>
        </article>
      </CM.Trigger>
      <CM.Portal>
        <CM.Content
          className="menu"
          // Focus moves to whatever the chosen item opens (the rename field), not back to the card.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <CM.Item className="menu-item" onSelect={onStartRename}>
            Rename
            <span className="menu-key">F2</span>
          </CM.Item>
          <CM.Item className="menu-item" onSelect={onReveal}>
            {revealLabel}
          </CM.Item>
          <CM.Separator className="menu-rule" />
          <CM.Item className="menu-item menu-item-danger" onSelect={onTrash}>
            Move to Recycle Bin
            <span className="menu-key">Del</span>
          </CM.Item>
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  )
})

function RenameField({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    // After a menu closes, focus may still be settling; take it on the next frame too.
    const take = () => {
      input.current?.focus()
      input.current?.select()
    }
    take()
    const raf = requestAnimationFrame(take)
    return () => cancelAnimationFrame(raf)
  }, [])

  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    const trimmed = name?.replace(/\s+/g, ' ').trim() ?? null
    onDone(trimmed && trimmed !== initial ? trimmed : null)
  }

  return (
    <input
      ref={input}
      className="project-title-input display"
      aria-label="Project name"
      value={value}
      maxLength={120}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(value)
        else if (e.key === 'Escape') finish(null)
      }}
    />
  )
}
