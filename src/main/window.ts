import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, screen, session, shell } from 'electron'
import { CHROME, TITLE_BAR_HEIGHT } from './theme'

// Only development builds may load the renderer from a dev server; shipped builds ignore the variable.
const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

export function currentTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

export function createMainWindow(): BrowserWindow {
  const theme = currentTheme()
  const { workAreaSize } = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    width: Math.min(1440, Math.round(workAreaSize.width * 0.9)),
    height: Math.min(920, Math.round(workAreaSize.height * 0.9)),
    minWidth: Math.min(960, workAreaSize.width),
    minHeight: Math.min(640, workAreaSize.height),
    show: false,
    backgroundColor: CHROME[theme].ground,
    title: 'galleryLAB',
    // Frameless, with native Windows caption buttons tinted to the theme.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 15 } }
      : {
          titleBarOverlay: {
            color: CHROME[theme].ground,
            symbolColor: CHROME[theme].symbol,
            height: TITLE_BAR_HEIGHT
          }
        }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  win.once('ready-to-show', () => {
    if (!process.env['GALLERYLAB_HIDDEN']) win.show()
  })

  // No navigation away from the app, no new windows; web links open in the browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (isDev && url.startsWith(process.env['ELECTRON_RENDERER_URL']!)) return
    e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) void win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

export function applyChromeTheme(win: BrowserWindow): void {
  const theme = currentTheme()
  win.setBackgroundColor(CHROME[theme].ground)
  if (process.platform !== 'darwin') {
    win.setTitleBarOverlay({ color: CHROME[theme].ground, symbolColor: CHROME[theme].symbol, height: TITLE_BAR_HEIGHT })
  }
}

export function lockDownSession(): void {
  const allowed = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}
