import { watch, type FSWatcher, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from 'electron'
import { EVENT_CHANNEL, GalleryError, type MainEvent } from '@shared/rpc'
import type { LibraryStatus } from '@shared/schemas'
import { EngineHost } from './engine-host'
import { Library } from './library'
import { handleGalleryScheme, registerGalleryScheme } from './protocol'
import { registerRpc } from './rpc'
import { SettingsStore } from './settings'
import { applyChromeTheme, createMainWindow, currentTheme, lockDownSession } from './window'

if (process.env['GALLERYLAB_USER_DATA']) app.setPath('userData', process.env['GALLERYLAB_USER_DATA'])
registerGalleryScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  const settings = new SettingsStore()
  let library: Library | null = null
  let libraryWatcher: FSWatcher | null = null
  let win: BrowserWindow | null = null

  const emit = (event: MainEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(EVENT_CHANNEL, event)
    }
  }

  const engine = new EngineHost((state) => emit({ type: 'engine.state', state }))

  const defaultLibraryPath = (): string =>
    process.env['GALLERYLAB_DEFAULT_LIBRARY'] ?? join(app.getPath('pictures'), 'galleryLAB')

  async function libraryStatus(): Promise<LibraryStatus> {
    const path = settings.get().libraryPath
    if (!path) return { state: 'unset', defaultPath: defaultLibraryPath() }
    if (library && library.root === path) return { state: 'ready', path }
    return { state: 'missing', path, defaultPath: defaultLibraryPath() }
  }

  async function openLibrary(path: string): Promise<void> {
    libraryWatcher?.close()
    libraryWatcher = null
    library = null
    try {
      await fs.mkdir(path, { recursive: true })
      const probe = join(path, `.gallerylab-write-test-${process.pid}`)
      await fs.writeFile(probe, '')
      await fs.rm(probe)
    } catch {
      return // Stays "missing"; the renderer offers to choose another folder.
    }
    const lib = new Library(path, { trash: (p) => shell.trashItem(p) })
    await lib.rescan()
    library = lib
    libraryWatcher = watchLibrary(lib)
  }

  /** Pick up projects renamed, added or removed in Explorer. */
  function watchLibrary(lib: Library): FSWatcher | null {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const w = watch(lib.root, { persistent: false }, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          const before = JSON.stringify(lib.list())
          lib.rescan().then(
            (projects) => {
              if (JSON.stringify(projects) !== before) emit({ type: 'library.changed', projects })
            },
            () => undefined
          )
        }, 400)
      })
      w.on('error', () => undefined)
      return w
    } catch {
      return null
    }
  }

  const requireLibrary = (): Library => {
    if (!library) throw new GalleryError('no-library', 'Choose a Library folder first.')
    return library
  }

  const afterChange = async <T>(result: T): Promise<T> => {
    if (library) emit({ type: 'library.changed', projects: library.list() })
    return result
  }

  await settings.load()
  nativeTheme.themeSource = settings.get().theme
  const libPath = settings.get().libraryPath
  if (libPath) await openLibrary(libPath)

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
        const opts: Electron.OpenDialogOptions = {
          title: 'Choose a Library folder',
          buttonLabel: 'Use this folder',
          properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
          defaultPath: settings.get().libraryPath ?? app.getPath('pictures')
        }
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        return res.canceled ? null : (res.filePaths[0] ?? null)
      },
      'library.setLocation': async ({ path }) => {
        await openLibrary(path)
        if (!library) {
          throw new GalleryError(
            'library-unwritable',
            `galleryLAB can’t write to ${path}. Choose a folder you have permission to change.`
          )
        }
        await settings.update({ libraryPath: path })
        const status = await libraryStatus()
        emit({ type: 'library.status', status })
        return afterChange(status)
      },
      'library.reveal': async () => {
        const err = await shell.openPath(requireLibrary().root)
        if (err) throw new GalleryError('reveal', err)
      },
      'projects.list': () => requireLibrary().list(),
      'projects.create': async ({ name }) =>
        afterChange(await requireLibrary().create(name, settings.get().defaultImportMode)),
      'projects.rename': async ({ id, name }) => afterChange(await requireLibrary().rename(id, name)),
      'projects.trash': async ({ id }) => afterChange(await requireLibrary().trash(id)),
      'projects.reorder': async ({ ids }) => afterChange(await requireLibrary().reorder(ids)),
      'projects.reveal': ({ id }) => {
        const root = requireLibrary().projectRoot(id)
        if (!root) throw new GalleryError('not-found', 'That project is no longer in the Library.')
        shell.showItemInFolder(join(root, 'project.json'))
      },
      'engine.ping': () => engine.request('ping')
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
  handleGalleryScheme((id) => library?.projectRoot(id) ?? null)
  engine.start()

  const open = (): void => {
    win = createMainWindow()
    const w = win
    w.webContents.on('did-finish-load', () => engine.connectRenderer(w.webContents))
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
    libraryWatcher?.close()
    engine.stop()
  })
}
