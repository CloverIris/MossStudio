import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

export type WindowKind = 'studio' | 'trainer'

const windows = new Map<WindowKind, BrowserWindow>()
const isDev = !app.isPackaged
const screenshot = process.argv.includes('--screenshot')
const smoke = process.argv.includes('--smoke')

const config: Record<WindowKind, { width: number; height: number; minWidth: number; minHeight: number; route: string; title: string }> = {
  studio: { width: 1600, height: 1000, minWidth: 1280, minHeight: 760, route: '/studio', title: 'MossStudio' },
  trainer: { width: 1280, height: 840, minWidth: 980, minHeight: 640, route: '/trainer', title: 'Kohaku Trainer' },
}


export function createAppWindow(kind: WindowKind, show = true): BrowserWindow {
  const existing = windows.get(kind)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return existing
  }

  const meta = config[kind]
  const iconPath = app.isPackaged
    ? join(__dirname, '..', 'renderer', 'mossstudio-icon.png')
    : join(app.getAppPath(), 'src', 'renderer', 'public', 'mossstudio-icon.png')
  if (process.platform === 'darwin') app.dock?.setIcon(iconPath)
  const win = new BrowserWindow({
    width: meta.width,
    height: meta.height,
    minWidth: meta.minWidth,
    minHeight: meta.minHeight,
    show: false,
    title: meta.title,
    icon: iconPath,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 15 } }
      : process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: '#00000000', symbolColor: '#e9eef7', height: 44 },
          }
        : {}),
    backgroundColor: '#191b1f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [
        '--clover-opaque',
        `--clover-window=${kind}`,
        `--clover-channel=${app.isPackaged ? 'release' : 'dev'}`,
      ],
    },
  })

  win.once('ready-to-show', () => {
    if (!show) return
    win.show()
    // Big creative workspace, not an OS-level fullscreen takeover.
    if (kind === 'studio' && !screenshot && !smoke) win.center()
  })

  win.webContents.on('console-message', (...args: unknown[]) => {
    const details = args[1] as { level?: string; message?: string } | number | undefined
    if (details && typeof details === 'object' && details.message) {
      console.log(`[renderer:${details.level ?? 'log'}]`, details.message)
    } else if (typeof args[2] === 'string') {
      console.log('[renderer]', args[2])
    }
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer:gone]', details.reason, details.exitCode)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (url !== current) {
      event.preventDefault()
      if (url.startsWith('https://')) void shell.openExternal(url)
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${meta.route}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: meta.route })
  }

  windows.set(kind, win)
  win.on('closed', () => {
    if (windows.get(kind) === win) windows.delete(kind)
  })
  return win
}

export function openWindow(kind: WindowKind, route?: string): BrowserWindow {
  const existing = getWindow(kind)
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    if (route) void existing.webContents.executeJavaScript(`location.hash = '#${route}'`)
    return existing
  }
  const win = createAppWindow(kind)
  if (route) {
    const apply = (): void => {
      void win.webContents.executeJavaScript(`location.hash = '#${route}'`)
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', apply)
    else apply()
  }
  return win
}

export function getWindow(kind: WindowKind): BrowserWindow | undefined {
  const win = windows.get(kind)
  return win && !win.isDestroyed() ? win : undefined
}
