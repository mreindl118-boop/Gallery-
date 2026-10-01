import { useEffect, useRef, useState } from 'react'
import type { GenerationEstimate } from '@shared/build'
import { controlBuild, readEstimate } from '../lib/bridge'
import { BUILD_STAGES, buildPercent, estimateLine, isBuilding } from '../lib/format'
import { useApp } from '../state/store'
import { Button } from './Button'
import './build-panel.css'

/**
 * The automatic build that follows an import: one status sentence, a hairline that fills, the three stages
 * as quiet steps, and only the controls that apply now. Everything shown comes from BuildProgress.
 */
export function BuildPanel({ projectId }: { projectId: string }) {
  const build = useApp((s) => s.builds[projectId])
  const generator = useApp((s) => s.generator)
  const [estimate, setEstimate] = useState<GenerationEstimate | null>(null)
  const configured = !!generator && generator.provider !== 'none'
  const state = build?.state
  const stage = build?.stage
  const busy = isBuilding(build)
  const paused = state === 'paused'
  const failed = state === 'failed'
  const canStart = state === 'idle' || state === 'done' || failed

  // The estimate is read when the generating stage is announced, and before a run starts (below).
  const token = useRef(0)
  const refreshEstimate = async () => {
    const t = ++token.current
    const e = await readEstimate(projectId)
    if (t === token.current) setEstimate(e)
  }
  useEffect(() => {
    if (configured) void refreshEstimate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, configured, generator?.imagesPerBuild, generator?.spendCapUsd, stage === 'generating'])

  if (!build) return null

  const generating = stage === 'generating' && busy
  const showEstimate = configured && estimate && !generating && !build.completed.includes('generating')
  const start = async () => {
    if (configured) await refreshEstimate()
    await controlBuild(projectId, 'build.start')
  }

  return (
    <section className="build-panel" aria-label="Build">
      <h2 className="build-title">Building</h2>
      <p className="build-status" aria-live="polite">
        {failed && build.message ? build.message : build.status}
      </p>
      {paused && build.message && build.message !== build.status && <p className="build-detail">{build.message}</p>}
      <div
        className="build-bar"
        role="progressbar"
        aria-label="Build progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={state === 'done' ? 100 : buildPercent(build)}
      >
        <div className="build-bar-fill" style={{ width: `${state === 'done' ? 100 : build.fraction * 100}%` }} />
      </div>
      <ol className="build-stages">
        {BUILD_STAGES.map((s) => {
          const done = build.completed.includes(s.value)
          const current = !done && stage === s.value && (busy || paused)
          return (
            <li
              key={s.value}
              className="build-stage"
              data-done={done || undefined}
              data-current={current || undefined}
              aria-current={current ? 'step' : undefined}
            >
              {s.label}
              {done && <span className="visually-hidden"> (done)</span>}
            </li>
          )
        })}
      </ol>
      {showEstimate && generator && <p className="build-estimate">{estimateLine(estimate, generator.spendCapUsd)}</p>}
      <div className="build-actions">
        {busy && <Button onClick={() => controlBuild(projectId, 'build.pause')}>Pause</Button>}
        {paused && (
          <Button variant="primary" onClick={() => controlBuild(projectId, 'build.resume')}>
            Resume
          </Button>
        )}
        {(busy || paused) && <Button onClick={() => controlBuild(projectId, 'build.cancel')}>Cancel</Button>}
        {canStart && (
          <Button variant={failed ? 'primary' : 'quiet'} onClick={start}>
            {failed ? 'Try again' : 'Build now'}
          </Button>
        )}
      </div>
    </section>
  )
}
