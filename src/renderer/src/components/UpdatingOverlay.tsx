import { useApp } from '../state/store'
import './updating.css'

/** Shown for the moment between "installing" and galleryLAB closing to update itself. */
export function UpdatingOverlay() {
  const s = useApp((st) => st.updates)
  if (!s?.installing) return null
  return (
    <div className="updating" role="alertdialog" aria-live="assertive" aria-label="Updating galleryLAB">
      <p className="updating-title display">Updating galleryLAB{s.version ? ` to ${s.version}` : ''}</p>
      <p className="updating-body">It opens again in a moment, in the same place, with your Library as you left it.</p>
    </div>
  )
}
