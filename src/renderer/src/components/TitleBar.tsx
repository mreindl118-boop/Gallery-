import type { ReactNode } from 'react'
import './titlebar.css'

/**
 * The draggable top strip. Its right edge stops where the native Windows
 * caption buttons begin (Window Controls Overlay env vars), so nothing we
 * draw ever sits under them.
 */
export function TitleBar({ children }: { children?: ReactNode }) {
  return (
    <header className="titlebar">
      <span className="wordmark">
        gallery<span className="wordmark-lab">LAB</span>
      </span>
      <div className="titlebar-actions">{children}</div>
    </header>
  )
}
