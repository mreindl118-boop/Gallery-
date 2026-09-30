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
import { applyChromeTheme, createMainWindow, currentTheme, lockDownSession } from './window'

if (process.env['GALLERYLAB_USER_DATA']) app.setPath('userData', process.env['GALLERYLAB_USER_DATA'])
registerGalleryScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main().catch((err) => {
    console.error('[main] startup failed', err)
    app.exit(1)
  })
}

async function main(): Promise<void> {
  const settings = new SettingsStore()
  let win: BrowserWindow | null = null

  const emit = (event: MainEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(EVENT_CHANNEL, event)
    }
  }

  const engine = new EngineHost((state) => emit({ type: 'engine.state', state }))

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
      'updates.status': () => updates.get(),
      'updates.check': () => updates.check(),
      'updates.download': () => updates.download(),
      'updates.install': () => updates.install(),
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
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  lockDownSession()
  handleGalleryScheme((id) => host.library?.projectRoot(id) ?? null)
  engine.start()
  void updates.start()

  const open = (): void => {
    win = createMainWindow()
    const w = win
    w.webContents.on('did-finish-load', () => engine.connectRenderer(w.webContents))
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
