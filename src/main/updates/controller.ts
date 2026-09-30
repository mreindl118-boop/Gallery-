import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, net } from 'electron'
import { NsisUpdater } from 'electron-updater'
import { compareVersions, portableFeedUrls, type PortableFeed } from '@shared/release'
import type { UpdateStatus } from '@shared/schemas'
import { updateLog } from './log'
import {
  canWriteBeside,
  cleanupLeftovers,
  downloadVerified,
  fetchFeed,
  hasReadyUpdate,
  HELPER_SCRIPT,
  helperEnv,
  readyVersion,
  type FetchLike
} from './portable-core'

const FIRST_CHECK_MS = 15_000
const EVERY_MS = 4 * 60 * 60 * 1000

const OFFLINE_MESSAGE = 'galleryLAB couldn’t check for updates. Check your internet connection; it tries again later.'
const DOWNLOAD_MESSAGE = 'The update couldn’t be downloaded. galleryLAB tries again later, or you can try now.'

interface Backend {
  readonly kind: UpdateStatus['kind']
  init(): Promise<void>
  check(): Promise<void>
  download(): Promise<void>
  /** Quit, put the new build in place and start it again. */
  install(): void
  setAutoDownload(on: boolean): void
  /** Called from `will-quit`; must be synchronous. */
  onQuit(): void
}

type Patch = (p: Partial<UpdateStatus>) => void

/**
 * Keeps galleryLAB current without moving it. The installer build uses
 * electron-updater with the install directory pinned to the folder the app
 * runs from; the portable build replaces its own exe at the same path. User
 * data and the Library live outside both and are never touched.
 */
export class UpdateController {
  private status: UpdateStatus
  private backend: Backend | null
  private timer: ReturnType<typeof setInterval> | null = null
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private busy: Promise<void> | null = null
  private readonly autoApply = process.env['GALLERYLAB_UPDATE_AUTO_APPLY'] === '1'

  constructor(
    auto: boolean,
    private readonly onChange: (s: UpdateStatus) => void
  ) {
    const feed = testFeed()
    this.backend = pickBackend(feed, (p) => this.patch(p))
    this.status = {
      kind: this.backend?.kind ?? 'none',
      current: app.getVersion(),
      auto,
      phase: 'idle',
      version: null,
      percent: null,
      message: null,
      lastChecked: null
    }
  }

  get(): UpdateStatus {
    return this.status
  }

  private patch(p: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...p }
    this.onChange(this.status)
    if (p.phase === 'ready' && this.autoApply) setTimeout(() => this.install(), 500)
  }

  async start(): Promise<void> {
    if (!this.backend) return
    updateLog(
      'info',
      `start: ${this.status.kind} ${this.status.current}, auto ${this.status.auto}, exe ${app.getPath('exe')}`
    )
    await this.backend.init().catch((err) => updateLog('warn', 'init failed', err))
    this.backend.setAutoDownload(this.status.auto)
    this.schedule()
  }

  private schedule(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.timer) clearInterval(this.timer)
    this.firstTimer = null
    this.timer = null
    if (!this.backend || !this.status.auto) return
    const delay = Number(process.env['GALLERYLAB_UPDATE_CHECK_DELAY_MS'] ?? FIRST_CHECK_MS)
    this.firstTimer = setTimeout(() => void this.check(), Number.isFinite(delay) ? delay : FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), EVERY_MS)
    this.timer.unref?.()
  }

  /** One check at a time; a second caller waits for the first. */
  async check(): Promise<UpdateStatus> {
    const backend = this.backend
    if (!backend) return this.status
    if (this.status.phase === 'downloading' || this.status.phase === 'ready') return this.status
    this.busy ??= backend.check().finally(() => {
      this.busy = null
    })
    await this.busy.catch(() => undefined)
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    if (!this.backend || this.status.phase !== 'available') return this.status
    await this.backend.download().catch(() => undefined)
    return this.status
  }

  install(): void {
    if (!this.backend || this.status.phase !== 'ready') return
    this.backend.install()
  }

  setAuto(auto: boolean): UpdateStatus {
    this.patch({ auto })
    this.backend?.setAutoDownload(auto)
    this.schedule()
    return this.status
  }

  onQuit(): void {
    try {
      this.backend?.onQuit()
    } catch (err) {
      updateLog('error', 'install on quit failed', err)
    }
  }
}

/** A local feed for end-to-end update tests. Only loopback http or https is accepted. */
function testFeed(): string | null {
  const url = process.env['GALLERYLAB_UPDATE_FEED']
  if (!url) return null
  return /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)/.test(url) ? url : null
}

function pickBackend(feed: string | null, patch: Patch): Backend | null {
  if (process.env['GALLERYLAB_UPDATE_FAKE'] === '1') return new FakeBackend(patch)
  if (!app.isPackaged || process.platform !== 'win32') return null
  const portableExe = process.env['PORTABLE_EXECUTABLE_FILE']
  if (portableExe) return new PortableBackend(portableExe, feed, patch)
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return null
  return new InstallerBackend(feed, patch)
}

const nowIso = (): string => new Date().toISOString()

/** NSIS build: electron-updater, pinned to the folder galleryLAB runs from. */
class InstallerBackend implements Backend {
  readonly kind = 'installer' as const
  private updater: NsisUpdater | null = null
  private version: string | null = null

  constructor(
    private readonly feed: string | null,
    private readonly patch: Patch
  ) {}

  async init(): Promise<void> {
    const u = new NsisUpdater()
    u.logger = {
      info: (m: unknown) => updateLog('info', m),
      warn: (m: unknown) => updateLog('warn', m),
      error: (m: unknown) => updateLog('error', m),
      debug: () => undefined
    }
    u.autoInstallOnAppQuit = true
    u.allowDowngrade = false
    u.allowPrerelease = false
    u.disableWebInstaller = true
    // Keep the install exactly where it is, even if the registry points elsewhere.
    u.installDirectory = dirname(app.getPath('exe'))
    if (this.feed) u.setFeedURL({ provider: 'generic', url: this.feed })

    u.on('checking-for-update', () => this.patch({ phase: 'checking', message: null }))
    u.on('update-available', (info) => {
      this.version = info.version
      this.patch({ phase: 'available', version: info.version, lastChecked: nowIso() })
    })
    u.on('update-not-available', () =>
      this.patch({ phase: 'up-to-date', version: null, percent: null, lastChecked: nowIso() })
    )
    u.on('download-progress', (p) =>
      this.patch({ phase: 'downloading', version: this.version, percent: Math.floor(p.percent) })
    )
    u.on('update-downloaded', (info) =>
      this.patch({ phase: 'ready', version: info.version, percent: 100, message: null })
    )
    u.on('error', (err) => {
      updateLog('error', 'electron-updater', err)
      const downloading = this.version !== null
      this.patch({
        phase: downloading ? 'available' : 'error',
        message: downloading ? DOWNLOAD_MESSAGE : OFFLINE_MESSAGE,
        lastChecked: nowIso()
      })
    })
    this.updater = u
  }

  async check(): Promise<void> {
    if (!this.updater) return
    try {
      await this.updater.checkForUpdates()
    } catch {
      // Reported through the 'error' event.
    }
  }

  async download(): Promise<void> {
    if (!this.updater) return
    this.patch({ phase: 'downloading', percent: 0, message: null })
    try {
      await this.updater.downloadUpdate()
    } catch {
      // Reported through the 'error' event.
    }
  }

  install(): void {
    // Silent, then start the new version: no installer pages to click through.
    this.updater?.quitAndInstall(true, true)
  }

  setAutoDownload(on: boolean): void {
    if (this.updater) this.updater.autoDownload = on
  }

  onQuit(): void {
    // electron-updater installs a downloaded update on quit by itself.
  }
}

/** Portable build: replace this exe at its own path. */
class PortableBackend implements Backend {
  readonly kind = 'portable' as const
  private autoDownload = true
  private handedOff = false
  private pending: PortableFeed | null = null
  private readonly fetchFn: FetchLike = (url) => net.fetch(url, { headers: { 'Cache-Control': 'no-cache' } })

  constructor(
    private readonly exePath: string,
    private readonly feed: string | null,
    private readonly patch: Patch
  ) {}

  async init(): Promise<void> {
    await cleanupLeftovers(this.exePath, app.getVersion())
    const waiting = await readyVersion(this.exePath)
    if (waiting && compareVersions(waiting, app.getVersion()) > 0) {
      updateLog('info', `update ${waiting} is waiting beside ${this.exePath}`)
      this.patch({ phase: 'ready', version: waiting, percent: 100 })
    }
  }

  async check(): Promise<void> {
    this.patch({ phase: 'checking', message: null })
    try {
      const url = portableFeedUrls(this.feed).feed
      const feed = await fetchFeed(this.fetchFn, url)
      updateLog('info', `portable feed ${url}: ${feed.version} (running ${app.getVersion()})`)
      if (compareVersions(feed.version, app.getVersion()) <= 0) {
        this.pending = null
        this.patch({ phase: 'up-to-date', version: null, percent: null, lastChecked: nowIso() })
        return
      }
      this.pending = feed
      if ((await readyVersion(this.exePath)) === feed.version) {
        this.patch({ phase: 'ready', version: feed.version, percent: 100, lastChecked: nowIso() })
        return
      }
      this.patch({ phase: 'available', version: feed.version, lastChecked: nowIso() })
      if (this.autoDownload) await this.download()
    } catch (err) {
      updateLog('error', 'portable check failed', err)
      this.patch({ phase: 'error', message: OFFLINE_MESSAGE, lastChecked: nowIso() })
    }
  }

  async download(): Promise<void> {
    const feed = this.pending
    if (!feed) return
    if (!(await canWriteBeside(this.exePath))) {
      updateLog('warn', `cannot write beside ${this.exePath}`)
      this.patch({
        phase: 'error',
        message: `galleryLAB can’t update itself in ${dirname(this.exePath)} because that folder can’t be changed. Move galleryLAB to a folder you can write to, or download the new version from the releases page.`
      })
      return
    }
    this.patch({ phase: 'downloading', version: feed.version, percent: 0, message: null })
    try {
      const url = portableFeedUrls(this.feed, feed.version, feed.file).asset!
      await downloadVerified(this.fetchFn, url, feed, this.exePath, (percent) =>
        this.patch({ phase: 'downloading', percent })
      )
      updateLog('info', `downloaded and verified ${feed.file} ${feed.version}`)
      this.patch({ phase: 'ready', version: feed.version, percent: 100 })
    } catch (err) {
      updateLog('error', 'portable download failed', err)
      this.patch({ phase: 'available', percent: null, message: DOWNLOAD_MESSAGE })
    }
  }

  install(): void {
    if (this.handedOff) return
    if (!this.startHelper(true)) {
      this.patch({
        phase: 'error',
        message: 'galleryLAB couldn’t start its updater. Quit galleryLAB and open it again to try once more.'
      })
      return
    }
    app.quit()
  }

  /**
   * Hand the verified update to a helper that moves it onto the exe's path
   * once galleryLAB and its launcher have exited, then optionally starts it.
   */
  private startHelper(relaunch: boolean): boolean {
    if (!hasReadyUpdate(this.exePath)) return false
    try {
      const script = join(tmpdir(), `galleryLAB-update-${process.pid}.cmd`)
      writeFileSync(script, HELPER_SCRIPT, 'ascii')
      const env: NodeJS.ProcessEnv = { ...process.env, ...helperEnv(this.exePath, process.pid, relaunch) }
      delete env['PORTABLE_EXECUTABLE_FILE']
      delete env['PORTABLE_EXECUTABLE_DIR']
      delete env['PORTABLE_EXECUTABLE_APP_FILENAME']
      spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/c', script], {
        env,
        stdio: 'ignore',
        windowsHide: true,
        cwd: dirname(this.exePath)
      }).unref()
      this.handedOff = true
      updateLog('info', `helper started (relaunch ${relaunch}) for ${this.exePath}`)
      return true
    } catch (err) {
      updateLog('error', 'could not start the update helper', err)
      return false
    }
  }

  setAutoDownload(on: boolean): void {
    this.autoDownload = on
  }

  onQuit(): void {
    // Install on quit: the helper finishes the move after we exit, without relaunching.
    if (!this.handedOff) this.startHelper(false)
  }
}

/** Development stand-in so the Settings UI can be exercised end to end. */
class FakeBackend implements Backend {
  readonly kind = 'installer' as const
  private auto = true
  constructor(private readonly patch: Patch) {}
  async init(): Promise<void> {}
  async check(): Promise<void> {
    this.patch({ phase: 'checking', message: null })
    await delay(300)
    this.patch({ phase: 'available', version: '9.9.9', lastChecked: nowIso() })
    if (this.auto) await this.download()
  }
  async download(): Promise<void> {
    for (let p = 0; p <= 100; p += 25) {
      this.patch({ phase: 'downloading', version: '9.9.9', percent: p })
      await delay(120)
    }
    this.patch({ phase: 'ready', version: '9.9.9', percent: 100 })
  }
  install(): void {
    this.patch({ phase: 'up-to-date', current: '9.9.9', version: null, percent: null })
  }
  setAutoDownload(on: boolean): void {
    this.auto = on
  }
  onQuit(): void {}
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
