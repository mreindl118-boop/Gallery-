import { create } from 'zustand'
import type {
  EngineState,
  LibraryStatus,
  ProjectSummary,
  ResolvedTheme,
  ThemePreference,
  UpdateStatus
} from '@shared/schemas'

export interface Notice {
  id: number
  text: string
  tone: 'info' | 'error'
  /** One quiet button, e.g. "Restart to update". Notices with an action stay until used or dismissed. */
  action?: { label: string; run: () => void }
  /** Notices with the same key replace each other. */
  key?: string
}

interface AppState {
  booted: boolean
  bootError: string | null
  status: LibraryStatus | null
  projects: ProjectSummary[]
  theme: ResolvedTheme
  themePreference: ThemePreference
  engine: EngineState
  updates: UpdateStatus | null
  version: string
  /** Project whose title is being edited in place. */
  renaming: string | null
  notices: Notice[]
  settingsOpen: boolean
  set: (patch: Partial<AppState>) => void
  notify: (text: string, tone?: Notice['tone'], extra?: Pick<Notice, 'action' | 'key'>) => void
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
  updates: null,
  version: '',
  renaming: null,
  notices: [],
  settingsOpen: false,
  set: (patch) => set(patch),
  notify: (text, tone = 'info', extra) =>
    set((s) => {
      const kept = extra?.key ? s.notices.filter((n) => n.key !== extra.key) : s.notices
      return { notices: [...kept.slice(-2), { id: ++noticeId, text, tone, ...extra }] }
    }),
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }))
}))

/** Surface an RPC failure in plain words. */
export function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  useApp.getState().notify(message, 'error')
}
