import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, net } from 'electron'
import { NsisUpdater } from 'electron-updater'
import { compareVersions, portableFeedUrls, type PortableFeed } from '@shared/release'
import type { UpdateStatus } from '@shared/schemas'
import { updateLog, updateLogPath } from './log'
import {
  canWriteBeside,
  cleanupLeftovers,
  downloadVerified,
  fetchFeed,
  attemptsSoFar,
  encodedHelper,
  hasReadyUpdate,
  helperEnv,
  readyVersion,
  recordAttempt,
  type FetchLike
} from './portable-core'

const FIRST_CHECK_MS = 15_000
const EVERY_MS = 4 * 60 * 60 * 1000

/** Messages depend on whether galleryLAB will retry by itself (automatic updates on). */
const offlineMessage = (auto: boolean): string =>
  auto
    ? 'galleryLAB couldn’t check for updates. Check your internet connection; it tries again later.'
    : 'galleryLAB couldn’t check for updates. Check your internet connection and try again.'
const downloadMessage = (auto: boolean): string =>
  auto
    ? 'The update couldn’t be downloaded. galleryLAB tries again later, or you can try now.'
    : 'The update couldn’t be downloaded. Check your internet connection and try again.'
const STUCK_MESSAGE =
  'galleryLAB downloaded an update but couldn’t finish installing it here. Download the new version from the releases page and replace this file with it.'

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
  /** Don't install on this quit (Windows session ending). */
  postpone(): void
}

type Patch = (p: Partial<UpdateStatus>) => void
/** What a backend needs from the controller. */
interface Ctx {
  patch: Patch
  /** Whether automatic updates are on right now (for message wording). */
  auto: () => boolean
}

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
  private downloading: Promise<void> | null = null
  private readonly autoApply = process.env['GALLERYLAB_UPDATE_AUTO_APPLY'] === '1'

  constructor(
    auto: boolean,
    private readonly onChange: (s: UpdateStatus) => void
  ) {
    const feed = testFeed()
    this.backend = pickBackend(feed, { patch: (p) => this.patch(p), auto: () => this.status.auto })
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

  /** One download at a time; a second click waits for the first. */
  async download(): Promise<UpdateStatus> {
    const backend = this.backend
    if (!backend || (this.status.phase !== 'available' && !this.downloading)) return this.status
    this.downloading ??= backend.download().finally(() => {
      this.downloading = null
    })
    await this.downloading.catch(() => undefined)
    return this.status
  }

  /** False when there is nothing ready to install (the caller tells the user). */
  install(): boolean {
    if (!this.backend || this.status.phase !== 'ready') return false
    this.backend.install()
    return true
  }

  setAuto(auto: boolean): UpdateStatus {
    this.patch({ auto })
    this.backend?.setAutoDownload(auto)
    this.schedule()
    return this.status
  }

  /** Windows is logging off or shutting down: don't start an install it would cut short. */
  onSessionEnd(): void {
    updateLog('info', 'session ending; postponing any install to the next quit')
    this.backend?.postpone()
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

function pickBackend(feed: string | null, ctx: Ctx): Backend | null {
  if (process.env['GALLERYLAB_UPDATE_FAKE'] === '1') return new FakeBackend(ctx.patch)
  if (!app.isPackaged || process.platform !== 'win32') return null
  const exeDir = dirname(app.getPath('exe'))
  const portableFile = process.env['PORTABLE_EXECUTABLE_FILE']
  const installed = hasUninstaller(exeDir)
  updateLog(
    'info',
    `mode check: exe ${app.getPath('exe')}, installed ${installed}, PORTABLE_EXECUTABLE_FILE ${portableFile ?? '-'}, PORTABLE_EXECUTABLE_APP_FILENAME ${process.env['PORTABLE_EXECUTABLE_APP_FILENAME'] ?? '-'}`
  )
  // An installed copy always has its uninstaller beside it. That decides the mode, whatever
  // PORTABLE_EXECUTABLE_* variables it may have inherited from some other portable app.
  if (installed) {
    return existsSync(join(process.resourcesPath, 'app-update.yml')) ? new InstallerBackend(feed, ctx) : null
  }
  if (portableFile && /\.exe$/i.test(portableFile) && existsSync(portableFile)) {
    return new PortableBackend(portableFile, feed, ctx)
  }
  return null
}

/** True when the folder holds the NSIS uninstaller ("Uninstall galleryLAB.exe"), i.e. a real install. */
function hasUninstaller(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => /^uninstall .*\.exe$/i.test(n))
  } catch {
    return false
  }
}

const nowIso = (): string => new Date().toISOString()

/** NSIS build: electron-updater, pinned to the folder galleryLAB runs from. */
class InstallerBackend implements Backend {
  readonly kind = 'installer' as const
  private updater: NsisUpdater | null = null
  private version: string | null = null
  /** A download is under way, so an error means the download failed, not the check. */
  private fetching = false
  private readonly patch: Patch

  constructor(
    private readonly feed: string | null,
    private readonly ctx: Ctx
  ) {
    this.patch = ctx.patch
  }

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
    // No /D: the per-user installer reinstalls into the folder it recorded at install time
    // (proven by scripts/ci/update-test.ps1). Passing /D= through Node's quoting is unreliable
    // for folders with spaces.
    if (this.feed) u.setFeedURL({ provider: 'generic', url: this.feed })

    u.on('checking-for-update', () => {
      this.version = null
      this.fetching = false
      this.patch({ phase: 'checking', message: null })
    })
    u.on('update-available', (info) => {
      this.version = info.version
      this.fetching = u.autoDownload
      this.patch({ phase: 'available', version: info.version, lastChecked: nowIso() })
    })
    u.on('update-not-available', () =>
      this.patch({ phase: 'up-to-date', version: null, percent: null, lastChecked: nowIso() })
    )
    u.on('download-progress', (p) =>
      this.patch({ phase: 'downloading', version: this.version, percent: Math.floor(p.percent) })
    )
    u.on('update-downloaded', (info) => {
      this.fetching = false
      this.patch({ phase: 'ready', version: info.version, percent: 100, message: null })
    })
    u.on('error', (err) => {
      updateLog('error', 'electron-updater', err)
      const wasDownloading = this.fetching && this.version !== null
      this.fetching = false
      this.patch({
        phase: wasDownloading ? 'available' : 'error',
        percent: null,
        message: wasDownloading ? downloadMessage(this.ctx.auto()) : offlineMessage(this.ctx.auto()),
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
    this.fetching = true
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

  postpone(): void {
    if (this.updater) this.updater.autoInstallOnAppQuit = false
  }
}

/** Portable build: replace this exe at its own path. */
class PortableBackend implements Backend {
  readonly kind = 'portable' as const
  private autoDownload = true
  private handedOff = false
  private stuck = false
  private postponed = false
  private pending: PortableFeed | null = null
  private readonly fetchFn: FetchLike = (url) => net.fetch(url, { headers: { 'Cache-Control': 'no-cache' } })

  private readonly patch: Patch

  constructor(
    private readonly exePath: string,
    private readonly feed: string | null,
    private readonly ctx: Ctx
  ) {
    this.patch = ctx.patch
  }

  async init(): Promise<void> {
    await cleanupLeftovers(this.exePath, app.getVersion())
    const waiting = await readyVersion(this.exePath)
    if (waiting && compareVersions(waiting, app.getVersion()) > 0) {
      const attempts = await attemptsSoFar(this.exePath)
      updateLog('info', `update ${waiting} is waiting beside ${this.exePath} (${attempts} earlier attempts)`)
      if (attempts >= 2) {
        // The helper was started but the swap never happened (for example PowerShell is blocked).
        this.stuck = true
        this.patch({ phase: 'error', version: waiting, message: STUCK_MESSAGE })
        return
      }
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
      if (this.stuck) {
        this.patch({ phase: 'error', version: feed.version, message: STUCK_MESSAGE, lastChecked: nowIso() })
        return
      }
      if ((await readyVersion(this.exePath)) === feed.version) {
        this.patch({ phase: 'ready', version: feed.version, percent: 100, lastChecked: nowIso() })
        return
      }
      this.patch({ phase: 'available', version: feed.version, lastChecked: nowIso() })
      if (this.autoDownload) await this.download()
    } catch (err) {
      updateLog('error', 'portable check failed', err)
      this.patch({ phase: 'error', message: offlineMessage(this.ctx.auto()), lastChecked: nowIso() })
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
      this.patch({ phase: 'available', percent: null, message: downloadMessage(this.ctx.auto()) })
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
    const root = process.env['SystemRoot'] ?? 'C:\\Windows'
    const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (!existsSync(powershell)) {
      updateLog('error', `PowerShell not found at ${powershell}`)
      return false
    }
    // Count the attempt before handing off, synchronously: this may run inside will-quit.
    recordAttempt(this.exePath)
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...helperEnv(this.exePath, process.pid, relaunch, { launcherPid: process.ppid, log: updateLogPath() })
      }
      delete env['PORTABLE_EXECUTABLE_FILE']
      delete env['PORTABLE_EXECUTABLE_DIR']
      delete env['PORTABLE_EXECUTABLE_APP_FILENAME']
      // Detached: a non-detached child is placed in a job that Windows kills when galleryLAB exits.
      const child = spawn(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          encodedHelper()
        ],
        { env, stdio: 'ignore', detached: true, windowsHide: true, cwd: dirname(this.exePath) }
      )
      child.on('error', (err) => updateLog('error', 'update helper failed to start', err))
      child.unref()
      this.handedOff = true
      updateLog('info', `helper started (pid ${child.pid ?? '?'}, relaunch ${relaunch}) for ${this.exePath}`)
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
    // Install on quit: the helper finishes the swap after we exit, without relaunching.
    if (!this.handedOff && !this.stuck && !this.postponed) this.startHelper(false)
  }

  postpone(): void {
    this.postponed = true
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
  postpone(): void {}
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
