import type { ResolvedTheme } from '@shared/schemas'

/** Window chrome colors per theme; must match src/renderer/design/tokens.css. */
export const CHROME: Record<ResolvedTheme, { ground: string; symbol: string }> = {
  light: { ground: '#F7F8F7', symbol: '#22272B' },
  dark: { ground: '#262626', symbol: '#E7E7E5' }
}

export const TITLE_BAR_HEIGHT = 44
