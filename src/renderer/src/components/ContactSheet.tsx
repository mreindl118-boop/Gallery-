import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { PhotoSummary } from '@shared/ingest'
import './contact-sheet.css'

/** Cells aim for this size and stretch so a row fills the available width exactly. */
const TARGET_CELL = 184
const MIN_COLUMNS = 2

/** A px value of a space token (so gaps come from tokens.css, not from here). */
function tokenPx(el: HTMLElement, name: string, fallback: number): number {
  const v = parseFloat(getComputedStyle(el).getPropertyValue(name))
  return Number.isFinite(v) ? v : fallback
}

export const galleryUrl = (projectId: string, path: string): string =>
  `gallery://${projectId}/${path.split('/').map(encodeURIComponent).join('/')}`

/**
 * Every photo of a project in import order, as a virtualized grid of square cells. Each photo is fitted whole
 * inside its cell (never cropped, tinted or covered): the 32 px placeholder shows at once and the thumbnail
 * fades in over it once it exists.
 */
export const ContactSheet = memo(function ContactSheet({
  projectId,
  photos
}: {
  projectId: string
  photos: PhotoSummary[]
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({ width: 0, gap: 12 })

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const gap = tokenPx(el, '--space-3', 12)
    const measure = () => {
      const style = getComputedStyle(el)
      const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      setLayout((l) => (l.width === width && l.gap === gap ? l : { width, gap }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { width, gap } = layout
  const columns = Math.max(MIN_COLUMNS, Math.floor((width + gap) / (TARGET_CELL + gap)))
  const cell = width > 0 ? Math.floor((width - gap * (columns - 1)) / columns) : TARGET_CELL
  const rows = Math.ceil(photos.length / columns)

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller.current,
    estimateSize: () => cell + gap,
    overscan: 4
  })

  // Row height depends on the width; tell the virtualizer when it changes.
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [virtualizer, cell, gap])

  return (
    <div ref={scroller} className="contact-sheet" tabIndex={0} role="region" aria-label="Photos in this project">
      <div className="contact-sheet-inner" style={{ height: virtualizer.getTotalSize() }}>
        {width > 0 &&
          virtualizer.getVirtualItems().map((row) => {
            const start = row.index * columns
            return (
              <div
                key={row.key}
                className="contact-row"
                style={{ transform: `translateY(${row.start}px)`, height: cell, gap }}
              >
                {photos.slice(start, start + columns).map((p) => (
                  <Tile key={p.id} photo={p} cell={cell} projectId={projectId} />
                ))}
              </div>
            )
          })}
      </div>
    </div>
  )
})

/** One photo fitted whole inside a square cell. Memoized on the photo object, which the store keeps stable. */
const Tile = memo(function Tile({ photo, cell, projectId }: { photo: PhotoSummary; cell: number; projectId: string }) {
  const { width: w, height: h } = photo
  const ratio = w > 0 && h > 0 ? w / h : 1
  const bw = ratio >= 1 ? cell : Math.round(cell * ratio)
  const bh = ratio >= 1 ? Math.round(cell / ratio) : cell
  const [loaded, setLoaded] = useState<string | null>(null)
  const thumb = photo.thumb ? galleryUrl(projectId, photo.thumb) : null

  return (
    <div className="contact-cell" style={{ width: cell, height: cell }}>
      <div className="contact-photo" style={{ width: bw, height: bh }} data-empty={!photo.lqip || undefined}>
        {photo.lqip && <img className="contact-lqip" src={photo.lqip} alt="" draggable={false} />}
        {thumb && (
          <img
            className="contact-thumb"
            src={thumb}
            alt={photo.name}
            draggable={false}
            decoding="async"
            data-loaded={loaded === thumb || undefined}
            onLoad={() => setLoaded(thumb)}
          />
        )}
        {!thumb && <span className="visually-hidden">{photo.name}</span>}
      </div>
    </div>
  )
})
