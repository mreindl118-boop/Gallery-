import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { isInside, resolveInsideRoot, SCHEME } from './protocol-path'

/** Must run before app `ready`. */
export function registerGalleryScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
    }
  ])
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Timing-Allow-Origin': '*'
}

/**
 * Serve project files to the renderer. Image bytes never cross IPC; they are
 * streamed from disk here. Anything that resolves outside the project root,
 * including through a symlink or junction, is refused.
 */
export function handleGalleryScheme(projectRoot: (id: string) => string | null): void {
  protocol.handle(SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return deny(405)
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return deny(400)
    }
    const root = projectRoot(url.hostname)
    if (!root) return deny(404)
    const file = resolveInsideRoot(root, url.pathname)
    if (!file) return deny(403)
    try {
      const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)])
      if (!isInside(realRoot, realFile)) return deny(403)
      const stat = await fs.stat(realFile)
      if (!stat.isFile()) return deny(404)
      const upstream = await net.fetch(pathToFileURL(realFile).toString(), {
        method: request.method,
        headers: request.headers
      })
      const headers = new Headers(upstream.headers)
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
      headers.set('Cache-Control', 'no-cache')
      return new Response(upstream.body, { status: upstream.status, headers })
    } catch {
      return deny(404)
    }
  })
}

function deny(status: number): Response {
  return new Response(null, { status, headers: CORS })
}
