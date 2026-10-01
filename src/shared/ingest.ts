import { z } from 'zod'
import { ProjectId } from './schemas'

/**
 * The ingest contract: what the renderer, main and the engine exchange about
 * importing photos into a project. The engine does all the work; main only
 * forwards requests with the project root it resolved itself.
 */

/** Photo formats galleryLAB recognises by their bytes (not their extension). */
export const PhotoFormat = z.enum(['jpeg', 'png', 'webp', 'avif', 'tiff', 'heic', 'raw'])
export type PhotoFormat = z.infer<typeof PhotoFormat>

/** Video containers galleryLAB recognises by their bytes. M4V files count as mp4. */
export const VideoFormat = z.enum(['mp4', 'mov', 'mkv', 'webm', 'avi'])
export type VideoFormat = z.infer<typeof VideoFormat>

/** Any imported file's format. */
export const MediaFormat = z.enum([...PhotoFormat.options, ...VideoFormat.options])
export type MediaFormat = z.infer<typeof MediaFormat>

export const isVideoFormat = (format: string): format is VideoFormat =>
  (VideoFormat.options as readonly string[]).includes(format)

export const MediaKind = z.enum(['photo', 'video'])
export type MediaKind = z.infer<typeof MediaKind>

/**
 * One imported photo or video, as the contact sheet and info panel need it. A
 * video has the same derivatives as a photo, made from its poster frame.
 */
export const PhotoSummary = z.object({
  /** Content hash (hex). Stable across renames and moves; also the derivative file name. */
  id: z.string().regex(/^[0-9a-f]{16,64}$/),
  /** Path of the copy inside the project, relative to the project folder, with forward slashes. */
  originalPath: z.string(),
  /** Name shown to people (the file name without folders). */
  name: z.string(),
  /** Rows written before videos existed have no kind; they are photos. */
  kind: MediaKind.default('photo'),
  format: MediaFormat,
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** Capture time (ISO) from metadata, if any. */
  takenAt: z.string().nullable(),
  /** Length of a video; null for photos. */
  durationMs: z.number().int().nonnegative().nullable().default(null),
  /** 32 px placeholder as a data: URL, shown until the thumbnail loads. */
  lqip: z.string().nullable(),
  /** Relative paths of derivatives inside the project folder, once made. */
  thumb: z.string().nullable(),
  display: z.string().nullable(),
  /** Import order, for a stable contact sheet. */
  seq: z.number().int().nonnegative()
})
export type PhotoSummary = z.infer<typeof PhotoSummary>

/** A file that could not be imported, with a plain reason and whether Retry can help. */
export const ImportIssue = z.object({
  id: z.number().int(),
  /** Absolute path of the file as it was dropped (shown shortened in the UI). */
  source: z.string(),
  reason: z.string(),
  kind: z.enum(['unsupported', 'unreadable', 'corrupt', 'duplicate', 'disk-full', 'failed']),
  retryable: z.boolean()
})
export type ImportIssue = z.infer<typeof ImportIssue>

export const ImportState = z.enum(['idle', 'discovering', 'importing', 'paused', 'done'])
export type ImportState = z.infer<typeof ImportState>

/** Progress for one project's import queue. Counts cover the current batch run (since the queue was last empty). */
export const ImportProgress = z.object({
  projectId: ProjectId,
  state: ImportState,
  /** Files found so far (grows while discovering). */
  total: z.number().int().nonnegative(),
  /** Files finished: imported, skipped as duplicates, or failed. */
  done: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Of `imported`, how many are videos. */
  importedVideos: z.number().int().nonnegative().default(0),
  /** Photos and videos in the project in total (all batches). */
  photos: z.number().int().nonnegative(),
  /** Of `photos`, how many are videos. */
  videos: z.number().int().nonnegative().default(0),
  /** Recent throughput in files per second (0 when idle). */
  filesPerSecond: z.number().nonnegative(),
  /** Estimated seconds left, or null when unknown. */
  secondsLeft: z.number().nonnegative().nullable()
})
export type ImportProgress = z.infer<typeof ImportProgress>

/** Engine methods (main → engine). `root` is always resolved by main from the Library, never by the renderer. */
export const IngestMethods = {
  add: z.object({ projectId: ProjectId, root: z.string(), paths: z.array(z.string().min(1)).min(1).max(100_000) }),
  pause: z.object({ projectId: ProjectId, root: z.string() }),
  resume: z.object({ projectId: ProjectId, root: z.string() }),
  cancel: z.object({ projectId: ProjectId, root: z.string() }),
  retry: z.object({ projectId: ProjectId, root: z.string(), issueIds: z.array(z.number().int()).optional() }),
  status: z.object({ projectId: ProjectId, root: z.string() }),
  photos: z.object({
    projectId: ProjectId,
    root: z.string(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(5000)
  }),
  issues: z.object({ projectId: ProjectId, root: z.string() }),
  /** Resume unfinished work in these projects (called by main at startup). */
  resumeAll: z.object({ projects: z.array(z.object({ projectId: ProjectId, root: z.string() })) })
} as const

export const ImportStatus = z.object({ progress: ImportProgress, issues: z.array(ImportIssue) })
export type ImportStatus = z.infer<typeof ImportStatus>

/** Derivative sizes (long edge, px) and where they live under .gallery/derivatives/. */
export const DERIVATIVES = {
  lqip: 32,
  thumb: { size: 512, dir: 'thumb-512' },
  display: { size: 2048, dir: 'display-2048' }
} as const

export const derivativePath = (kind: 'thumb' | 'display', id: string): string =>
  `.gallery/derivatives/${DERIVATIVES[kind].dir}/${id}.webp`
