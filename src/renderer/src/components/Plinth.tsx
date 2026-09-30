import { useId } from 'react'

/**
 * A white-card plinth drawn in isometric projection. An empty project shows
 * its site: the plinth with the outline of the ground its gallery will
 * occupy. From M5 the generated model stands on it.
 */
const COS = Math.cos(Math.PI / 6)
const SIN = 0.5

type P3 = [number, number, number]

function project([x, y, z]: P3, cx: number, cy: number): [number, number] {
  return [cx + (x - y) * COS, cy + (x + y) * SIN - z]
}

function poly(points: P3[], cx: number, cy: number): string {
  return points
    .map((p) => project(p, cx, cy))
    .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ')
}

export interface PlinthProps {
  /** Plinth side in model units. */
  size?: number
  height?: number
  className?: string
  title?: string
}

export function Plinth({ size = 150, height = 22, className, title }: PlinthProps) {
  const uid = useId().replace(/:/g, '')
  const a = size
  const b = size
  const h = height
  const w = (a + b) * COS
  const pad = 24
  const cx = w / 2 + pad
  const cy = pad + h
  const vbW = w + pad * 2
  const vbH = (a + b) * SIN + h + pad * 2 + 10

  const top: P3[] = [
    [0, 0, h],
    [a, 0, h],
    [a, b, h],
    [0, b, h]
  ]
  const left: P3[] = [
    [0, b, h],
    [a, b, h],
    [a, b, 0],
    [0, b, 0]
  ]
  const right: P3[] = [
    [a, 0, h],
    [a, b, h],
    [a, b, 0],
    [a, 0, 0]
  ]
  // The site: an inset outline on the plinth top, with a quiet module grid.
  const inset = size * 0.16
  const site: P3[] = [
    [inset, inset, h],
    [a - inset, inset, h],
    [a - inset, b - inset, h],
    [inset, b - inset, h]
  ]
  const grid: Array<[P3, P3]> = []
  const steps = 6
  for (let i = 1; i < steps; i++) {
    const t = inset + ((a - inset * 2) * i) / steps
    grid.push([
      [t, inset, h],
      [t, b - inset, h]
    ])
    grid.push([
      [inset, t, h],
      [a - inset, t, h]
    ])
  }
  const shadow: P3[] = [
    [-4, -4, 0],
    [a + 10, -2, 0],
    [a + 16, b + 16, 0],
    [-2, b + 10, 0]
  ]

  return (
    <svg
      className={className}
      viewBox={`0 0 ${vbW.toFixed(1)} ${vbH.toFixed(1)}`}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <defs>
        <filter id={`soft-${uid}`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <linearGradient id={`top-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--card-top)" />
          <stop offset="1" stopColor="var(--card-top)" stopOpacity="0.92" />
        </linearGradient>
      </defs>
      <polygon points={poly(shadow, cx, cy + 6)} fill="var(--card-shadow)" filter={`url(#soft-${uid})`} />
      <polygon points={poly(left, cx, cy)} fill="var(--card-left)" />
      <polygon points={poly(right, cx, cy)} fill="var(--card-right)" />
      <polygon points={poly(top, cx, cy)} fill={`url(#top-${uid})`} />
      <g stroke="var(--card-line)" strokeWidth="0.6" opacity="0.45">
        {grid.map(([p, q], i) => {
          const [x1, y1] = project(p, cx, cy)
          const [x2, y2] = project(q, cx, cy)
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
        })}
      </g>
      <polygon
        points={poly(site, cx, cy)}
        fill="none"
        stroke="var(--card-line)"
        strokeWidth="1"
        strokeDasharray="4 3"
      />
      <polyline
        points={poly([top[3]!, top[2]!, top[1]!], cx, cy)}
        fill="none"
        stroke="var(--card-edge)"
        strokeWidth="0.75"
        strokeOpacity="0.6"
      />
    </svg>
  )
}
