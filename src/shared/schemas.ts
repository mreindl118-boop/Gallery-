import { z } from 'zod'

/** Project ids are lowercase so they survive as the host of a standard URL scheme. */
export const ProjectId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Invalid project id')
export type ProjectId = z.infer<typeof ProjectId>

export const ImportMode = z.enum(['copy', 'reference'])
export type ImportMode = z.infer<typeof ImportMode>

export const ThemePreference = z.enum(['system', 'light', 'dark'])
export type ThemePreference = z.infer<typeof ThemePreference>
export type ResolvedTheme = 'light' | 'dark'

export const ProjectName = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Give the project a name.').max(120, 'Keep the name under 120 characters.'))

export const PROJECT_SCHEMA_VERSION = 1
export const ProjectFile = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: ProjectId,
  name: z.string().min(1),
  created: z.iso.datetime(),
  updated: z.iso.datetime(),
  seed: z.number().int().min(0).max(0xffffffff),
  settings: z
    .object({
      centerlineCm: z.number().min(100).max(200).default(145)
    })
    .default({ centerlineCm: 145 }),
  importMode: ImportMode
})
export type ProjectFile = z.infer<typeof ProjectFile>

export const LIBRARY_SCHEMA_VERSION = 1
export const LibraryFile = z.object({
  schemaVersion: z.literal(LIBRARY_SCHEMA_VERSION),
  /** Display order of projects, by id. */
  order: z.array(ProjectId),
  /** Project id → folder name inside the Library. A rescan rebuilds this. */
  projects: z.record(ProjectId, z.object({ folder: z.string().min(1) }))
})
export type LibraryFile = z.infer<typeof LibraryFile>

export const SETTINGS_SCHEMA_VERSION = 1
export const AppSettings = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
  libraryPath: z.string().nullable(),
  theme: ThemePreference,
  defaultImportMode: ImportMode,
  units: z.enum(['auto', 'cm', 'in']),
  centerlineCm: z.number().min(100).max(200),
  /** Download updates in the background and install them on quit. Added in 0.1.1; defaults on. */
  autoUpdate: z.boolean().default(true)
})
export type AppSettings = z.infer<typeof AppSettings>

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  libraryPath: null,
  theme: 'system',
  defaultImportMode: 'copy',
  units: 'auto',
  centerlineCm: 145,
  autoUpdate: true
}

/** What the renderer sees of a project. */
export const ProjectSummary = z.object({
  id: ProjectId,
  name: z.string(),
  folder: z.string(),
  created: z.string(),
  updated: z.string(),
  importMode: ImportMode,
  photoCount: z.number().int().min(0)
})
export type ProjectSummary = z.infer<typeof ProjectSummary>

/** Why a Library folder can't be used, for plain-language messages. */
export const LibraryProblem = z.enum(['missing', 'unwritable', 'unreadable', 'inside-app'])
export type LibraryProblem = z.infer<typeof LibraryProblem>

export const LibraryStatus = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unset'), defaultPath: z.string() }),
  z.object({
    state: z.literal('missing'),
    path: z.string(),
    defaultPath: z.string(),
    problem: LibraryProblem.default('missing')
  }),
  z.object({ state: z.literal('ready'), path: z.string() })
])
export type LibraryStatus = z.infer<typeof LibraryStatus>

export const EngineState = z.enum(['starting', 'ready', 'restarting', 'failed'])
export type EngineState = z.infer<typeof EngineState>

/**
 * What the updater is doing. `kind` says which mechanism applies: the NSIS
 * installer build (electron-updater), the portable exe (self-replacing), or
 * none (development builds and other platforms).
 */
export const UpdateStatus = z.object({
  kind: z.enum(['installer', 'portable', 'none']),
  current: z.string(),
  auto: z.boolean(),
  phase: z.enum(['idle', 'checking', 'available', 'downloading', 'ready', 'up-to-date', 'error']),
  /** The newer version, once one is known. */
  version: z.string().nullable(),
  /** Download progress 0–100 while downloading. */
  percent: z.number().min(0).max(100).nullable(),
  /** Plain-language error: what happened and what to do. */
  message: z.string().nullable(),
  lastChecked: z.string().nullable(),
  /** galleryLAB is about to close to install; the window says so. */
  installing: z.boolean().default(false)
})
export type UpdateStatus = z.infer<typeof UpdateStatus>
