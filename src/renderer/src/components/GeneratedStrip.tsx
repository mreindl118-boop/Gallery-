import type { GeneratedAsset } from '@shared/build'
import { galleryUrl } from './ContactSheet'
import './generated-strip.css'

const KIND_WORDS: Record<GeneratedAsset['kind'], string> = {
  texture: 'Texture',
  backdrop: 'Backdrop',
  companion: 'Companion'
}

/** Assets the build made from the project's own photos: a quiet row of thumbnails under the contact sheet. */
export function GeneratedStrip({ projectId, assets }: { projectId: string; assets: GeneratedAsset[] }) {
  if (!assets.length) return null
  return (
    <section className="generated" aria-label="Generated">
      <h2 className="generated-title">Generated</h2>
      <ul className="generated-row">
        {assets.map((a) => (
          <li key={a.id} className="generated-item">
            <img
              className="generated-thumb"
              src={galleryUrl(projectId, a.path)}
              alt={`${KIND_WORDS[a.kind]} ${a.id}`}
            />
            <span className="generated-kind">{KIND_WORDS[a.kind]}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
