import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect } from 'react'
import { useApp } from '../state/store'
import './notices.css'

/** Quiet, text-only notices at the bottom left. Errors stay until dismissed. */
export function Notices() {
  const notices = useApp((s) => s.notices)
  const dismiss = useApp((s) => s.dismiss)
  const reduced = useReducedMotion()

  useEffect(() => {
    const timers = notices
      .filter((n) => n.tone === 'info' && !n.action)
      .map((n) => setTimeout(() => dismiss(n.id), 5000))
    return () => timers.forEach(clearTimeout)
  }, [notices, dismiss])

  return (
    <div className="notices" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {notices.map((n) => (
          <motion.div
            key={n.id}
            layout={!reduced}
            className={`notice notice-${n.tone}`}
            initial={{ opacity: 0, y: reduced ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 520, damping: 46, mass: 1 }}
          >
            <p>{n.text}</p>
            {n.action && (
              <button
                className="notice-action"
                onClick={() => {
                  dismiss(n.id)
                  n.action!.run()
                }}
              >
                {n.action.label}
              </button>
            )}
            <button className="notice-close" onClick={() => dismiss(n.id)}>
              Dismiss
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
