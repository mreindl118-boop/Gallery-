import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from 'electron'
import { releasesPageUrl } from '@shared/release'
import { EVENT_CHANNEL, GalleryError, type MainEvent } from '@shared/rpc'
import type { LibraryProblem, LibraryStatus } from '@shared/schemas'
import { EngineHost } from './engine-host'
import type { Library } from './library'
import { LibraryHost } from './library-host'
import { handleGalleryScheme, registerGalleryScheme } from './protocol'
import { registerRpc } from './rpc'
import { SettingsStore } from './settings'
import { UpdateController } from './updates/controller'
import { fatal, startupLog } from './startup-log'
import { applyChromeTheme, createMainWindow, currentTheme, lockDownSession } from './window'

if (process.env['GALLERYLAB_USER_DATA']) app.setPath('userData', process.env['GALLERYLAB_USER_DATA'])
startupLog(
  `galleryLAB ${app.getVersion()} starting: exe ${app.getPath('exe')}, packaged ${app.isPackaged}, args ${JSON.stringify(process.argv.slice(1))}`
)
process.on('uncaughtException', (err) => fatal('main process', err))
process.on('unhandledRejection', (err) => startupLog('unhandled rejection:', err))
registerGalleryScheme()

if (!app.requestSingleInstanceLock()) {
  // Another galleryLAB is already running for this user: it gets a second-instance event and comes to the front.
  startupLog('another galleryLAB is already running; handing over to it and quitting')
  app.quit()
} else {
  startupLog('single-instance lock acquired')
  main().catch((err) => fatal('startup', err))
}

async function main(): Promise<void> {
  const settings = new SettingsStore()
  let win: BrowserWindow | null = null

  const emit = (event: MainEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(EVENT_CHANNEL, event)
    }
  }

  const engine = new EngineHost((state) => {
    emit({ type: 'engine.state', state })
    // After every (re)start, pick up imports that were interrupted (quit, crash, power loss).
    if (state === 'ready') void resumeImports()
  })

  async function resumeImports(): Promise<void> {
    await host.settled()
    const lib = host.library
    if (!lib) return
    const projects = lib.list().flatMap((p) => {
      const root = lib.projectRoot(p.id)
      return root ? [{ projectId: p.id, root }] : []
    })
    if (projects.length) await engine.request('ingest.resumeAll', { projects }).catch(() => undefined)
  }

  /** The project's folder, resolved by main from the Library, never taken from the renderer. */
  const projectRootFor = async (id: string): Promise<string> => {
    const root = (await requireLibrary()).projectRoot(id)
    if (!root) throw new GalleryError('not-found', 'That project is no longer in the Library.')
    return root
  }

  const ingest = async <T>(method: string, id: string, extra: Record<string, unknown> = {}): Promise<T> =>
    engine.request<T>(`ingest.${method}`, { projectId: id, root: await projectRootFor(id), ...extra }, 120_000)

  const IMAGE_EXTENSIONS = [
    'jpg',
    'jpeg',
    'png',
    'webp',
    'avif',
    'tif',
    'tiff',
    'heic',
    'heif',
    'dng',
    'cr2',
    'cr3',
    'nef',
    'arw',
    'raf',
    'orf',
    'rw2'
  ]

  const host = new LibraryHost({
    trash: (p) => shell.trashItem(p),
    // A Library inside the program folder would be deleted by the next update or uninstall.
    forbiddenRoots: () => (app.isPackaged ? [dirname(app.getPath('exe')), process.resourcesPath] : []),
    onChanged: (projects) => emit({ type: 'library.changed', projects })
  })

  const defaultLibraryPath = (): string => {
    if (process.env['GALLERYLAB_DEFAULT_LIBRARY']) return process.env['GALLERYLAB_DEFAULT_LIBRARY']
    for (const name of ['pictures', 'documents', 'home'] as const) {
      try {
        return join(app.getPath(name), 'galleryLAB')
      } catch {
        // Some redirected or policy-managed profiles can't resolve every known folder.
      }
    }
    return join(app.getPath('userData'), 'Library')
  }

  let lastProblem: LibraryProblem = 'missing'

  async function libraryStatus(): Promise<LibraryStatus> {
    await host.settled()
    const path = settings.get().libraryPath
    if (!path) return { state: 'unset', defaultPath: defaultLibraryPath() }
    if (host.library && host.library.root === path) return { state: 'ready', path }
    return { state: 'missing', path, defaultPath: defaultLibraryPath(), problem: lastProblem }
  }

  const requireLibrary = async (): Promise<Library> => {
    await host.settled()
    if (!host.library) throw new GalleryError('no-library', 'Choose a Library folder first.')
    return host.library
  }

  const afterChange = async <T>(result: T): Promise<T> => {
    if (host.library) emit({ type: 'library.changed', projects: host.library.list() })
    return result
  }

  await settings.load()
  startupLog(`settings loaded from ${app.getPath('userData')}`)
  nativeTheme.themeSource = settings.get().theme
  const updates = new UpdateController(settings.get().autoUpdate, (status) => emit({ type: 'updates.status', status }))
  // Open the saved Library without blocking the window; RPCs wait for it. Never recreate it if it's gone.
  const libPath = settings.get().libraryPath
  if (libPath) {
    void host.open(libPath, false).then((r) => {
      if (!r.ok) lastProblem = r.problem
    })
  }

  registerRpc(
    {
      'app.info': () => ({
        version: app.getVersion(),
        platform: process.platform,
        resolvedTheme: currentTheme(),
        engine: engine.state
      }),
      'settings.get': () => settings.get(),
      'settings.setTheme': async ({ theme }) => {
        const next = await settings.update({ theme })
        nativeTheme.themeSource = theme
        emit({ type: 'settings.changed', settings: next })
        return next
      },
      'library.status': () => libraryStatus(),
      'library.pickFolder': async () => {
        let defaultPath = settings.get().libraryPath ?? undefined
        if (!defaultPath) {
          try {
            defaultPath = app.getPath('pictures')
          } catch {
            defaultPath = undefined
          }
        }
        const opts: Electron.OpenDialogOptions = {
          title: 'Choose a Library folder',
          buttonLabel: 'Use this folder',
          properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
          ...(defaultPath ? { defaultPath } : {})
        }
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        return res.canceled ? null : (res.filePaths[0] ?? null)
      },
      'library.setLocation': async ({ path, create }) => {
        const result = await host.open(path, create)
        if (!result.ok) {
          lastProblem = result.problem
          // Whatever was open stays open; say what went wrong and what to do.
          throw new GalleryError(`library-${result.problem}`, libraryProblemMessage(result.problem, path))
        }
        await settings.update({ libraryPath: path })
        void resumeImports()
        const status = await libraryStatus()
        emit({ type: 'library.status', status })
        return afterChange(status)
      },
      'library.reveal': async () => {
        const err = await shell.openPath((await requireLibrary()).root)
        if (err) throw new GalleryError('reveal', err)
      },
      'projects.list': async () => (await requireLibrary()).list(),
      'projects.create': async ({ name }) =>
        afterChange(await (await requireLibrary()).create(name, settings.get().defaultImportMode)),
      'projects.rename': async ({ id, name }) => afterChange(await (await requireLibrary()).rename(id, name)),
      'projects.trash': async ({ id }) => afterChange(await (await requireLibrary()).trash(id)),
      'projects.reorder': async ({ ids }) => afterChange(await (await requireLibrary()).reorder(ids)),
      'projects.reveal': async ({ id }) => {
        const root = (await requireLibrary()).projectRoot(id)
        if (!root) throw new GalleryError('not-found', 'That project is no longer in the Library.')
        shell.showItemInFolder(join(root, 'project.json'))
      },
      'engine.ping': () => engine.request('ping'),
      'import.add': ({ id, paths }) => ingest('add', id, { paths }),
      'import.pause': ({ id }) => ingest('pause', id),
      'import.resume': ({ id }) => ingest('resume', id),
      'import.cancel': ({ id }) => ingest('cancel', id),
      'import.retry': ({ id, issueIds }) => ingest('retry', id, issueIds ? { issueIds } : {}),
      'import.status': ({ id }) => ingest('status', id),
      'photos.list': ({ id, offset, limit }) => ingest('photos', id, { offset, limit }),
      'import.pickFiles': async () => {
        const opts: Electron.OpenDialogOptions = {
          title: 'Add photos',
          buttonLabel: 'Add',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: 'Photos', extensions: IMAGE_EXTENSIONS },
            { name: 'All files', extensions: ['*'] }
          ]
        }
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        return res.canceled ? [] : res.filePaths
      },
      'import.pickFolder': async () => {
        const opts: Electron.OpenDialogOptions = {
          title: 'Add a folder of photos',
          buttonLabel: 'Add folder',
          properties: ['openDirectory', 'multiSelections']
        }
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        return res.canceled ? [] : res.filePaths
      },
      'updates.status': () => updates.get(),
      'updates.check': () => updates.check(),
      'updates.download': () => updates.download(),
      'updates.install': () => {
        if (!updates.install()) {
          throw new GalleryError(
            'no-update',
            'There’s no update ready to install right now. Check for updates in Settings.'
          )
        }
      },
      'updates.setAuto': async ({ auto }) => {
        await settings.update({ autoUpdate: auto })
        return updates.setAuto(auto)
      },
      'updates.openReleases': async () => {
        await shell.openExternal(releasesPageUrl())
      }
    },
    (event) => {
      const frame = event.senderFrame
      return (
        !!win &&
        !win.isDestroyed() &&
        event.sender === win.webContents &&
        frame !== null &&
        frame === win.webContents.mainFrame
      )
    }
  )

  await app.whenReady()
  startupLog('app ready')
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  lockDownSession()
  handleGalleryScheme((id) => host.library?.projectRoot(id) ?? null)
  engine.start()
  void updates.start()

  const open = (): void => {
    win = createMainWindow()
    const w = win
    startupLog('window created')
    w.webContents.on('did-finish-load', () => {
      startupLog('renderer loaded')
      engine.connectRenderer(w.webContents)
    })
    w.webContents.on('did-fail-load', (_e, code, description, url) =>
      startupLog(`renderer failed to load ${url}: ${code} ${description}`)
    )
    w.webContents.on('render-process-gone', (_e, details) =>
      startupLog(`renderer process gone: ${details.reason} (exit code ${details.exitCode})`)
    )
    // Logging off or shutting down: an installer started now would be cut short.
    w.on('session-end', () => updates.onSessionEnd())
    w.on('closed', () => {
      if (win === w) win = null
    })
  }
  open()

  nativeTheme.on('updated', () => {
    for (const w of BrowserWindow.getAllWindows()) applyChromeTheme(w)
    emit({ type: 'theme.changed', resolved: currentTheme() })
  })

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) open()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => {
    host.close()
    engine.stop()
  })
  app.on('will-quit', () => updates.onQuit())
}

function libraryProblemMessage(problem: LibraryProblem, path: string): string {
  switch (problem) {
    case 'missing':
      return `galleryLAB can’t find ${path}. Reconnect the drive it’s on and try again, or choose another folder.`
    case 'unreadable':
      return `galleryLAB couldn’t read the contents of ${path}. Check that you can open it in Explorer, then try again.`
    case 'inside-app':
      return 'That folder is inside galleryLAB’s own program folder, which is replaced by every update. Choose a folder outside it, such as Pictures.'
    default:
      return `galleryLAB can’t write to ${path}. Choose a folder you have permission to change.`
  }
}
