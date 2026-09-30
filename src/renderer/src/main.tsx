import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/libre-franklin/wght.css'
import './design/tokens.css'
import './design/base.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { boot } from './lib/bridge'
import { useApp } from './state/store'

document.documentElement.classList.add(`platform-${window.gallery.platform}`)

const root = createRoot(document.getElementById('root')!)
boot()
  .catch((err: unknown) => {
    console.error('Boot failed', err)
    useApp.getState().set({ bootError: err instanceof Error ? err.message : String(err) })
  })
  .finally(() =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  )
