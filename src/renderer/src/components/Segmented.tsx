/** A radiogroup of plain text segments on Plaster; arrows move between them. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  labelledBy
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  labelledBy: string
}) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-labelledby={labelledBy}
      onKeyDown={(e) => {
        const step =
          e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
        if (!step) return
        e.preventDefault()
        const i = options.findIndex((o) => o.value === value)
        const next = options[(i + step + options.length) % options.length]!
        onChange(next.value)
        const group = e.currentTarget
        requestAnimationFrame(() =>
          (group.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus()
        )
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          data-value={o.value}
          tabIndex={value === o.value ? 0 : -1}
          aria-checked={value === o.value}
          className="segment"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
