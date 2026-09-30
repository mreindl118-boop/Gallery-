import { z } from 'zod'
import { ImportIssue, ImportProgress, ImportStatus, PhotoSummary } from './ingest'
import {
  AppSettings,
  EngineState,
  LibraryStatus,
  ProjectId,
  ProjectName,
  ProjectSummary,
  ThemePreference,
  UpdateStatus
} from './schemas'

/**
 * The typed contract between renderer and main. Every method has a zod
 * schema for its input (validated in main, the trust boundary) and its
 * output. Add a method here, then implement it in src/main/rpc.ts; the
 * preload API and renderer types follow automatically.
 */
const m = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ input, output })
const none = z.undefined()

export const AppInfo = z.object({
  version: z.string(),
  platform: z.string(),
  resolvedTheme: z.enum(['light', 'dark']),
  engine: EngineState
})
export type AppInfo = z.infer<typeof AppInfo>

export const EnginePing = z.object({ pid: z.number(), uptimeMs: z.number(), version: z.string() })

export const rpcContract = {
  'app.info': m(none, AppInfo),
  'settings.get': m(none, AppSettings),
  'settings.setTheme': m(z.object({ theme: ThemePreference }), AppSettings),

  'library.status': m(none, LibraryStatus),
  /** Opens a folder picker; resolves to the chosen path or null. */
  'library.pickFolder': m(none, z.string().nullable()),
  /** Switch to a Library folder. `create` makes it if absent (first run, picked folders), not when retrying a missing one. */
  'library.setLocation': m(z.object({ path: z.string().min(1), create: z.boolean().default(true) }), LibraryStatus),
  'library.reveal': m(none, z.void()),

  'projects.list': m(none, z.array(ProjectSummary)),
  'projects.create': m(z.object({ name: ProjectName }), ProjectSummary),
  'projects.rename': m(z.object({ id: ProjectId, name: ProjectName }), ProjectSummary),
  'projects.trash': m(z.object({ id: ProjectId }), z.void()),
  'projects.reorder': m(z.object({ ids: z.array(ProjectId) }), z.array(ProjectSummary)),
  'projects.reveal': m(z.object({ id: ProjectId }), z.void()),

  'engine.ping': m(none, EnginePing),

  /** Start importing dropped or picked files and folders into a project. Returns at once; work runs in the engine. */
  'import.add': m(z.object({ id: ProjectId, paths: z.array(z.string().min(1)).min(1).max(100_000) }), ImportProgress),
  'import.pause': m(z.object({ id: ProjectId }), ImportProgress),
  'import.resume': m(z.object({ id: ProjectId }), ImportProgress),
  'import.cancel': m(z.object({ id: ProjectId }), ImportProgress),
  'import.retry': m(z.object({ id: ProjectId, issueIds: z.array(z.number().int()).optional() }), ImportProgress),
  'import.status': m(z.object({ id: ProjectId }), ImportStatus),
  'photos.list': m(
    z.object({ id: ProjectId, offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(5000).default(5000) }),
    z.array(PhotoSummary)
  ),
  /** Native file/folder pickers for Add photos / Add folder. Resolve to absolute paths (empty when cancelled). */
  'import.pickFiles': m(none, z.array(z.string())),
  'import.pickFolder': m(none, z.array(z.string())),


  'updates.status': m(none, UpdateStatus),
  /** Check now (downloads right away when automatic updates are on). */
  'updates.check': m(none, UpdateStatus),
  /** Download an available update (when automatic updates are off). */
  'updates.download': m(none, UpdateStatus),
  /** Quit, install the downloaded update in place and start galleryLAB again. */
  'updates.install': m(none, z.void()),
  'updates.setAuto': m(z.object({ auto: z.boolean() }), UpdateStatus),
  /** Open the public releases page in the browser. */
  'updates.openReleases': m(none, z.void())
} as const

export type RpcContract = typeof rpcContract
export type RpcMethod = keyof RpcContract
export type RpcInput<K extends RpcMethod> = z.input<RpcContract[K]['input']>
export type RpcOutput<K extends RpcMethod> = z.output<RpcContract[K]['output']>

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export const RPC_CHANNEL = 'gallery:rpc'
export const EVENT_CHANNEL = 'gallery:event'
export const ENGINE_PORT_CHANNEL = 'gallery:engine-port'

/** Low-volume events pushed from main to the renderer. */
export const MainEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('library.changed'), projects: z.array(ProjectSummary) }),
  z.object({ type: z.literal('library.status'), status: LibraryStatus }),
  z.object({ type: z.literal('theme.changed'), resolved: z.enum(['light', 'dark']) }),
  z.object({ type: z.literal('settings.changed'), settings: AppSettings }),
  z.object({ type: z.literal('engine.state'), state: EngineState }),
  z.object({ type: z.literal('updates.status'), status: UpdateStatus })
])
export type MainEvent = z.infer<typeof MainEvent>

/**
 * High-volume events from the engine, delivered to the renderer over a
 * MessagePort in batches of about 10 Hz. M1 adds import progress and
 * thumbnail events here.
 */
export const EngineEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('engine.heartbeat'), uptimeMs: z.number() }),
  /** Progress of a project's import queue (throttled by the batcher). */
  z.object({ type: z.literal('import.progress'), progress: ImportProgress }),
  /** Photos that finished importing (or got a new derivative). */
  z.object({ type: z.literal('import.photos'), projectId: ProjectId, photos: z.array(PhotoSummary) }),
  /** A file that could not be imported. */
  z.object({ type: z.literal('import.issue'), projectId: ProjectId, issue: ImportIssue })
])
export type EngineEvent = z.infer<typeof EngineEvent>
export const EngineEventBatch = z.array(EngineEvent)

/** User-facing error codes. Messages say what happened and what to do. */
export class GalleryError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'GalleryError'
  }
}
