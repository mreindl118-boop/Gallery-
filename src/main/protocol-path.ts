import { isAbsolute, relative, resolve, sep } from 'node:path'

export const SCHEME = 'gallery'

/**
 * Map the path part of a gallery://<projectId>/<path> URL to a file inside
 * the project root, or null when it would land anywhere else. Pure: symlink
 * escapes are checked separately against the real path.
 */
export function resolveInsideRoot(root: string, urlPathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const parts = decoded.split(/[/\\]+/).filter((p) => p !== '')
  if (parts.length === 0) return null
  // Refuse drive letters, alternate data streams and device paths outright.
  if (parts.some((p) => p === '..' || p.includes(':'))) return null
  const target = resolve(root, ...parts)
  return isInside(root, target) ? target : null
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

export function galleryUrl(projectId: string, relPath: string): string {
  const encoded = relPath
    .split(/[/\\]+/)
    .filter(Boolean)
    .map((p) => encodeURIComponent(p))
    .join('/')
  return `${SCHEME}://${projectId}/${encoded}`
}
