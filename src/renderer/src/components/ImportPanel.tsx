import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useMemo, useRef } from 'react'
import type { ImportIssue, ImportProgress } from '@shared/ingest'
import { controlImport, pickAndImport, retryIssues } from '../lib/bridge'
import { importDetails, importHeadline, isImporting, plural, shortenFolder, splitPath } from '../lib/format'
import { Button } from './Button'
import './import-panel.css'

/** Duplicates are summed up in the progress lines; the Issues list is for files that need attention. */
const listed = (i: ImportIssue) => i.kind !== 'duplicate'

/**
 * The right third of the import view: one calm progress line, quiet detail lines, the plain controls that
 * apply now, and the files that couldn't be imported.
 */
export function ImportPanel({
  projectId,
  progress,
  issues
}: {
  projectId: string
  progress: ImportProgress | null | undefined
  issues: ImportIssue[]
}) {
  const shown = useMemo(() => issues.filter(listed), [issues])
  const retryable = useMemo(() => shown.filter((i) => i.retryable), [shown])
  const busy = isImporting(progress)
  const paused = progress?.state === 'paused'

  return (
    <aside className="import-panel" aria-label="Import">
      <section className="import-progress">
        <p className="import-headline">{progress ? importHeadline(progress) : 'Reading this project.'}</p>
        {progress &&
          importDetails(progress).map((line) => (
            <p key={line} className="import-detail">
              {line}
            </p>
          ))}
        {progress && (busy || paused) && (
          <div className="import-bar" aria-hidden="true">
            <div
              className="import-bar-fill"
              style={{ transform: `scaleX(${progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0})` }}
            />
          </div>
        )}
        <div className="import-actions">
          {busy && <Button onClick={() => controlImport(projectId, 'import.pause')}>Pause</Button>}
          {paused && (
            <Button variant="primary" onClick={() => controlImport(projectId, 'import.resume')}>
              Resume
            </Button>
          )}
          {(busy || paused) && <Button onClick={() => controlImport(projectId, 'import.cancel')}>Cancel</Button>}
          {!busy && !paused && (
            <>
              <Button onClick={() => pickAndImport(projectId, 'files')}>Add photos</Button>
              <Button onClick={() => pickAndImport(projectId, 'folder')}>Add folder</Button>
            </>
          )}
        </div>
      </section>

      {shown.length > 0 && (
        <section className="import-issues" aria-labelledby="import-issues-title">
          <div className="import-issues-head">
            <h2 id="import-issues-title" className="import-issues-title">
              Issues
            </h2>
            <span className="import-issues-count">{plural(shown.length, 'file', 'files')}</span>
            {retryable.length > 1 && (
              <Button
                className="import-retry-all"
                onClick={() =>
                  retryIssues(
                    projectId,
                    retryable.map((i) => i.id)
                  )
                }
              >
                Retry all
              </Button>
            )}
          </div>
          <IssueList projectId={projectId} issues={shown} />
        </section>
      )}
    </aside>
  )
}

/** Virtualized, so thousands of unreadable files stay cheap. */
function IssueList({ projectId, issues }: { projectId: string; issues: ImportIssue[] }) {
  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: issues.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 76,
    overscan: 8,
    getItemKey: (i) => issues[i]?.id ?? i
  })
  return (
    <div ref={scroller} className="import-issue-scroll">
      <ul className="import-issue-list" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const issue = issues[row.index]
          if (!issue) return null
          return (
            <li
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={row.index}
              className="import-issue"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <Issue projectId={projectId} issue={issue} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const Issue = memo(function Issue({ projectId, issue }: { projectId: string; issue: ImportIssue }) {
  const { name, folder } = splitPath(issue.source)
  return (
    <>
      <div className="import-issue-text">
        <p className="import-issue-name" title={issue.source}>
          {name}
        </p>
        {folder && <p className="import-issue-folder">{shortenFolder(folder)}</p>}
        <p className="import-issue-reason">{issue.reason}</p>
      </div>
      {issue.retryable && (
        <Button
          className="import-issue-retry"
          aria-label={`Retry ${name}`}
          onClick={() => retryIssues(projectId, [issue.id])}
        >
          Retry
        </Button>
      )}
    </>
  )
})
