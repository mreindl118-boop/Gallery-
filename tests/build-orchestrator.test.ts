import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BuildProgress, GeneratedAsset, type GenerationEstimate, type PhotoReading } from '@shared/build'
import type { EngineEvent } from '@shared/rpc'
import { Build, buildHandlers, type BuildOptions, type Credentials, type Handler } from '../src/engine/build'
import { STATUS } from '../src/engine/build/orchestrator'
import { MESSAGES } from '../src/engine/build/providers'
import { readTheme } from '../src/engine/build/theming'
import { IngestDb } from '../src/engine/ingest/db'
import { Ingest } from '../src/engine/ingest'
import { jpeg, writeFile } from './fixtures/images'

let tmp: string
const cleanup: (() => Promise<void> | void)[] = []

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gl-build-'))
})
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
  rmSync(tmp, { recursive: true, force: true })
})

type Ev = EngineEvent & { at: number }

async function until<T>(fn: () => T | undefined | false, timeout = 15_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error('Timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const progressOf = (events: Ev[]) =>
  events.flatMap((e) => (e.type === 'build.progress' ? [e.progress] : [])) as BuildProgress[]
const assetsOf = (events: Ev[]) =>
  events.flatMap((e) => (e.type === 'build.asset' ? [e.asset] : [])) as GeneratedAsset[]
const settled = (events: Ev[]) => {
  const last = progressOf(events).at(-1)
  return last && (last.state === 'done' || last.state === 'failed' || last.state === 'idle') ? last : undefined
}

/** Imports `n` small photos into a fresh project and waits for the import to settle. */
async function project(
  n: number,
  events: Ev[],
  buildOpts: BuildOptions = {},
  onBuild?: (b: Build, p: { projectId: string; root: string }) => void
) {
  const root = join(tmp, 'Project')
  const p = { projectId: randomUUID(), root }
  const broadcast = (e: EngineEvent) => events.push({ ...e, at: Date.now() })
  const build = new Build(broadcast, { idleCloseMs: 20, log: () => undefined, progressIntervalMs: 50, ...buildOpts })
  cleanup.push(() => build.dispose())
  onBuild?.(build, p)
  const ingest = new Ingest(broadcast, { idleCloseMs: 20, log: () => undefined })
  cleanup.push(() => ingest.dispose())
  const src = join(tmp, 'src')
  for (let i = 0; i < n; i++)
    await writeFile(join(src, `p${i}.jpg`), await jpeg({ seed: 100 + i, width: 96, height: 64 }))
  ingest.add({ ...p, paths: [src] })
  await until(() => ingest.status(p).progress.state === 'done')
  return { p, build, ingest, root, broadcast }
}

const PRICES = { stability: 0.04, openai: 0.04, xai: 0.07 }
type Handlers = Record<'status' | 'start' | 'pause' | 'resume' | 'cancel' | 'reading' | 'assets' | 'estimate', Handler>
const handlersOf = (b: Build) => buildHandlers(b) as Handlers
const creds = (over: Partial<Credentials> = {}): Credentials => ({
  provider: 'openai',
  key: 'sk-secret',
  prices: PRICES,
  limits: { imagesPerBuild: 4, spendCapUsd: 5 },
  ...over
})

const png = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
    .png()
    .toBuffer()
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeProvider(script: (n: number) => Response | Promise<Response>) {
  let calls = 0
  const fetchFn = (async () => script(++calls)) as typeof fetch
  return { deps: { fetch: fetchFn, sleep: async () => undefined }, calls: () => calls }
}
const okImage = async () => json({ data: [{ b64_json: (await png()).toString('base64') }] })

describe('build orchestrator', () => {
  it('starts on its own when an import finishes, reads every photo, themes, and stops without a provider', async () => {
    const events: Ev[] = []
    const { p, build, root } = await project(5, events)
    const last = await until(() => settled(events))
    expect(last.state).toBe('done')
    expect(last.status).toBe(STATUS.themedNoKey)
    expect(last.fraction).toBe(1)
    expect(last.completed).toEqual(['reading', 'theming'])
    expect(last.startedAt).toBeTruthy()
    expect(last.finishedAt).toBeTruthy()

    const seen = progressOf(events).filter((e) => e.projectId === p.projectId)
    // Stages appear in order, and the throttle holds: same-looking events are at least an interval apart.
    const stages = [...new Set(seen.map((e) => e.stage))]
    expect(stages).toEqual([null, 'reading', 'theming'])
    const evs = events.filter((e) => e.type === 'build.progress')
    for (let i = 1; i < evs.length; i++) {
      const a = evs[i - 1]!
      const b = evs[i]!
      if (a.type !== 'build.progress' || b.type !== 'build.progress') continue
      const same =
        a.progress.state === b.progress.state &&
        a.progress.stage === b.progress.stage &&
        a.progress.completed.length === b.progress.completed.length
      if (same && a.progress.state === 'running' && a.progress.stage === 'reading' && b.progress.stageFraction < 1)
        expect(b.at - a.at).toBeGreaterThanOrEqual(45)
    }
    for (const e of seen) BuildProgress.parse(e)

    const theme = await readTheme(root)
    expect(theme?.projectId).toBe(p.projectId)
    expect(theme?.reasons.length).toBeGreaterThan(5)
    const ids = IngestDb.open(root, { create: false, recover: false })!
    const photos = ids.allPhotos()
    expect(photos).toHaveLength(5)
    for (const ph of photos) expect(ids.reading(ph.id)).toBeTruthy()
    expect(ids.buildRow()?.state).toBe('done')
    expect(ids.buildRow()?.theme).toContain('"archetype"')
    ids.close()

    const h = handlersOf(build)
    const reading = h.reading({ ...p, photoId: photos[0]!.id }) as PhotoReading | null
    expect(reading?.photoId).toBe(photos[0]!.id)
    expect(reading?.palette.length).toBeGreaterThan(0)
    expect(h.assets(p)).toEqual([])
    expect((h.status({ ...p, credentials: null }) as BuildProgress).state).toBe('done')
  })

  it('reads only new photos on a second build, and themes again', async () => {
    const events: Ev[] = []
    const { p, build, ingest, root } = await project(3, events)
    await until(() => settled(events))
    const read: string[] = []
    const b2 = new Build(() => undefined, {
      idleCloseMs: 20,
      log: () => undefined,
      autoStart: false,
      beforeStep: (s, id) => void (s === 'photo' && read.push(id))
    })
    cleanup.push(() => b2.dispose())
    await build.dispose()
    const src2 = join(tmp, 'src2')
    await writeFile(join(src2, 'new.jpg'), await jpeg({ seed: 999, width: 96, height: 64 }))
    ingest.add({ ...p, paths: [src2] })
    await until(() => ingest.status(p).progress.state === 'done' && ingest.status(p).progress.photos === 4)
    const pb = b2.project({ ...p, credentials: null })
    pb.start()
    await until(() => pb.status().state === 'done')
    expect(read).toHaveLength(1)
    expect(IngestDb.open(root, { create: false, recover: false })!.readingCount(1)).toBe(4)
  })

  it('resumes after a simulated restart with the photos still unread', async () => {
    const events: Ev[] = []
    let first: Build | null = null
    let pb!: ReturnType<Build['project']>
    let readA = 0
    const { p, root } = await project(
      6,
      events,
      {
        concurrency: 1,
        beforeStep: (step) => {
          if (step !== 'photo') return
          readA++
          // "Quit" mid-reading: the fourth photo never starts.
          if (readA === 4) void first!.dispose()
        }
      },
      (b, p) => {
        first = b
        pb = b.project(p)
      }
    )
    await until(() => !pb!.running)
    await first!.dispose()
    const row = IngestDb.open(root, { create: false, recover: false })!
    expect(row.buildRow()?.state).toBe('running')
    expect(row.readingCount(1)).toBe(3)
    row.close()

    const readB: string[] = []
    const events2: Ev[] = []
    const second = new Build((e) => events2.push({ ...e, at: Date.now() }), {
      idleCloseMs: 20,
      log: () => undefined,
      autoStart: false,
      beforeStep: (s, id) => void (s === 'photo' && readB.push(id))
    })
    cleanup.push(() => second.dispose())
    const resumed = second.project({ ...p, credentials: null })
    expect(resumed.running).toBe(true)
    const last = await until(() => settled(events2))
    expect(last.state).toBe('done')
    expect(readB).toHaveLength(3)
    expect(IngestDb.open(root, { create: false, recover: false })!.readingCount(1)).toBe(6)
  })

  it('pauses, resumes and cancels', async () => {
    const events: Ev[] = []
    let pb!: ReturnType<Build['project']>
    let n = 0
    await project(
      4,
      events,
      {
        concurrency: 1,
        beforeStep: (step) => {
          if (step === 'photo' && ++n === 2) pb!.pause()
        }
      },
      (b, p) => (pb = b.project(p))
    )
    const paused = await until(() => progressOf(events).find((e) => e.state === 'paused'))
    expect(paused.status).toBe(STATUS.paused)
    expect(paused.message).toBe(STATUS.pausedMessage)
    await until(() => !pb!.running)
    expect(pb.status().state).toBe('paused')
    expect(pb.status().stageFraction).toBeGreaterThan(0)
    expect(pb.status().stageFraction).toBeLessThan(1)

    pb.resume()
    const done = await until(() => progressOf(events).find((e) => e.state === 'done'))
    expect(done.completed).toEqual(['reading', 'theming'])

    // Cancel mid-run: the build goes back to idle, readings are kept.
    n = -100
    pb.start()
    pb.cancel()
    await until(() => !pb!.running)
    const s = pb.status()
    expect(s.state).toBe('idle')
    expect(s.status).toBe(STATUS.stopped)
    expect(s.completed).toEqual([])
    expect(s.fraction).toBe(0)
  })

  it('generates assets through a provider, re-uses them when the theme is unchanged, and respects the cap', async () => {
    const events: Ev[] = []
    const fake = fakeProvider(() => okImage())
    const { p, build, root } = await project(3, events, { providerDeps: fake.deps })
    await until(() => settled(events))
    expect(fake.calls()).toBe(0)

    const pb = build.project({ ...p, credentials: creds() })
    const h = handlersOf(build)
    const est = h.estimate({ ...p, credentials: creds() }) as GenerationEstimate
    expect(est).toEqual({ provider: 'openai', images: 4, pricePerImageUsd: 0.04, totalUsd: 0.16, withinCap: true })

    events.length = 0
    pb.start()
    const last = await until(() => settled(events))
    expect(last.state).toBe('done')
    expect(last.status).toBe(STATUS.built)
    expect(last.completed).toEqual(['reading', 'theming', 'generating'])
    expect(fake.calls()).toBe(4)
    const made = assetsOf(events)
    expect(made.map((a) => a.kind)).toEqual(['texture', 'texture', 'backdrop', 'companion'])
    for (const a of made) {
      GeneratedAsset.parse(a)
      expect(a.path).toMatch(/^\.gallery\/generated\/[0-9a-f-]+\.png$/)
      expect(existsSync(join(root, ...a.path.split('/')))).toBe(true)
      expect(a.prompt).not.toContain('sk-secret')
    }
    expect(made[3]!.seedPhotoIds).toHaveLength(1)
    const listed = h.assets(p) as GeneratedAsset[]
    expect(listed.map((a) => a.id)).toEqual(made.map((a) => a.id))
    const making = progressOf(events).filter((e) => e.stage === 'generating' && e.state === 'running')
    expect(making.some((e) => e.status === STATUS.making(1, 4))).toBe(true)
    expect(making.at(-1)!.fraction).toBeGreaterThanOrEqual(0.7)

    // No event or file carries the key.
    expect(JSON.stringify(events)).not.toContain('sk-secret')
    const db = IngestDb.open(root, { create: false, recover: false })!
    expect(JSON.stringify(db.buildRow())).not.toContain('sk-secret')
    expect(JSON.stringify(db.assets())).not.toContain('sk-secret')
    db.close()

    // Same theme: nothing new is made.
    events.length = 0
    pb.start()
    await until(() => settled(events))
    expect(fake.calls()).toBe(4)
    expect((h.assets(p) as GeneratedAsset[]).length).toBe(4)
    expect(readdirSync(join(root, '.gallery', 'generated'))).toHaveLength(4)

    // Over the cap: themed, nothing made, a plain message.
    events.length = 0
    build.project({ ...p, credentials: creds({ limits: { imagesPerBuild: 4, spendCapUsd: 0.1 } }) }).start()
    const capped = await until(() => settled(events))
    expect(capped.state).toBe('done')
    expect(capped.status).toBe(STATUS.overCap(4, 0.16, 0.1))
    expect(fake.calls()).toBe(4)

    // Images per build raised: only the missing ones are made.
    events.length = 0
    build.project({ ...p, credentials: creds({ limits: { imagesPerBuild: 6, spendCapUsd: 5 } }) }).start()
    await until(() => settled(events))
    expect(fake.calls()).toBe(6)
    expect(assetsOf(events).map((a) => a.kind)).toEqual(['companion', 'companion'])
  })

  it('stops with the key message on 401, skips filtered images', async () => {
    const events: Ev[] = []
    const fake = fakeProvider((n) =>
      n === 1
        ? json({ error: { message: 'bad key' } }, 401)
        : n === 3
          ? json({ error: { message: 'content_policy_violation' } }, 400)
          : okImage()
    )
    const { p, build } = await project(2, events, { providerDeps: fake.deps })
    await until(() => settled(events))
    events.length = 0
    const pb = build.project({ ...p, credentials: creds({ limits: { imagesPerBuild: 3, spendCapUsd: 5 } }) })
    pb.start()
    const failed = await until(() => settled(events))
    expect(failed.state).toBe('failed')
    expect(failed.message).toBe(MESSAGES.rejected)
    expect(failed.status).toBe(STATUS.failed)
    expect(failed.completed).toEqual(['reading', 'theming'])

    events.length = 0
    pb.start()
    const done = await until(() => settled(events))
    expect(done.state).toBe('done')
    expect(done.status).toBe(STATUS.built)
    expect(assetsOf(events)).toHaveLength(2)
    expect(fake.calls()).toBe(4)
  })

  it('restarts when start is called during a run', async () => {
    const events: Ev[] = []
    const { p, build } = await project(4, events, { concurrency: 1 })
    const pb = build.project(p)
    await until(() => pb.running)
    pb.start()
    expect(pb.status().state).toBe('waiting')
    const last = await until(() => settled(events))
    expect(last.state).toBe('done')
    expect(pb.running).toBe(false)
  })

  it('handlers validate params and answer idle for a project without an index', () => {
    const build = new Build(() => undefined, { autoStart: false })
    cleanup.push(() => build.dispose())
    const h = handlersOf(build)
    const p = { projectId: randomUUID(), root: join(tmp, 'Nothing') }
    expect((h.status(p) as BuildProgress).state).toBe('idle')
    expect((h.start(p) as BuildProgress).status).toBe(STATUS.noPhotos)
    expect(h.estimate({ ...p, credentials: null })).toEqual({
      provider: 'none',
      images: 0,
      pricePerImageUsd: 0,
      totalUsd: 0,
      withinCap: true
    })
    expect(() => h.start({ projectId: 'not-a-uuid', root: '' })).toThrow()
  })
})
