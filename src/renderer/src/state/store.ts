import { create } from 'zustand'
import type { EngineState, LibraryStatus, ProjectSummary, ResolvedTheme, ThemePreference } from '@shared/schemas'

export interface Notice {
  id: number
  text: string
  tone: 'info' | 'error'
}

interface AppState {
  booted: boolean
  bootError: string | null
  status: LibraryStatus | null
  projects: ProjectSummary[]
  theme: ResolvedTheme
  themePreference: ThemePreference
  engine: EngineState
  version: string
  /** Project whose title is being edited in place. */
  renaming: string | null
  notices: Notice[]
  settingsOpen: boolean
  set: (patch: Partial<AppState>) => void
  notify: (text: string, tone?: Notice['tone']) => void
  dismiss: (id: number) => void
}

let noticeId = 0

export const useApp = create<AppState>((set) => ({
  booted: false,
  bootError: null,
  status: null,
  projects: [],
  theme: 'light',
  themePreference: 'system',
  engine: 'starting',
  version: '',
  renaming: null,
  notices: [],
  settingsOpen: false,
  set: (patch) => set(patch),
  notify: (text, tone = 'info') => set((s) => ({ notices: [...s.notices.slice(-2), { id: ++noticeId, text, tone }] })),
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }))
}))

/** Surface an RPC failure in plain words. */
export function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  useApp.getState().notify(message, 'error')
}
