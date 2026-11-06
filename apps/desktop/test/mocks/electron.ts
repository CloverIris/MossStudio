/**
 * Stand-in for the `electron` module in the `main` Vitest project.
 *
 * Every member main/ imports exists here with inert, inspectable behaviour so a
 * service can be imported without an Electron runtime. Paths resolve under
 * MOSSSTUDIO_TEST_USERDATA (set per test via `useTempDataRoot`) or os.tmpdir().
 * Tests that care about a call spy on it: `vi.spyOn(shell, 'openPath')`.
 */
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function userData(): string {
  return process.env['MOSSSTUDIO_TEST_USERDATA'] ?? join(tmpdir(), 'mossstudio-test-userdata')
}

const appEvents = new EventEmitter()

export const app = {
  isPackaged: false,
  name: 'MossStudio',
  getName: () => 'MossStudio',
  getVersion: () => process.env['MOSSSTUDIO_TEST_APP_VERSION'] ?? '1.0.3',
  getPath: (name: string): string => {
    if (name === 'exe') return join(userData(), 'MossStudio.exe')
    if (name === 'userData' || name === 'appData') return userData()
    return join(userData(), name)
  },
  setPath: (): void => undefined,
  getAppPath: () => process.cwd(),
  getLocale: () => 'zh-CN',
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  on: (event: string, listener: (...args: unknown[]) => void) => {
    appEvents.on(event, listener)
    return app
  },
  once: (event: string, listener: (...args: unknown[]) => void) => {
    appEvents.once(event, listener)
    return app
  },
  emit: (event: string, ...args: unknown[]) => appEvents.emit(event, ...args),
  off: (event: string, listener: (...args: unknown[]) => void) => {
    appEvents.off(event, listener)
    return app
  },
  removeListener: (event: string, listener: (...args: unknown[]) => void) => {
    appEvents.off(event, listener)
    return app
  },
  quit: (): void => undefined,
  exit: (): void => undefined,
  relaunch: (): void => undefined,
  focus: (): void => undefined,
  requestSingleInstanceLock: () => true,
  setAppUserModelId: (): void => undefined,
  disableHardwareAcceleration: (): void => undefined,
  commandLine: { appendSwitch: (): void => undefined },
}

class FakeWebContents extends EventEmitter {
  sent: Array<{ channel: string; payload: unknown }> = []
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }
  isDestroyed(): boolean {
    return false
  }
}

const windows: BrowserWindow[] = []

export class BrowserWindow extends EventEmitter {
  static getAllWindows(): BrowserWindow[] {
    return windows.filter((win) => !win.destroyed)
  }
  static getFocusedWindow(): BrowserWindow | null {
    return windows[0] ?? null
  }
  static fromWebContents(): BrowserWindow | null {
    return windows[0] ?? null
  }
  /** Test helper: drop every fake window. */
  static reset(): void {
    windows.length = 0
  }
  webContents = new FakeWebContents()
  destroyed = false
  constructor(readonly options: unknown = {}) {
    super()
    windows.push(this)
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
  }
  close(): void {
    this.destroyed = true
  }
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  loadFile(): Promise<void> {
    return Promise.resolve()
  }
  show(): void {}
  focus(): void {}
  isMinimized(): boolean {
    return false
  }
  isFocused(): boolean {
    return !this.destroyed
  }
  isVisible(): boolean {
    return !this.destroyed
  }
  restore(): void {}
}

const handlers = new Map<string, (...args: unknown[]) => unknown>()
export const ipcMain = {
  handlers,
  handle: (channel: string, handler: (...args: unknown[]) => unknown): void => {
    handlers.set(channel, handler)
  },
  removeHandler: (channel: string): void => {
    handlers.delete(channel)
  },
  on: (): void => undefined,
  removeAllListeners: (): void => undefined,
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  getSelectedStorageBackend: (): string => 'basic_text',
  encryptString: (value: string): Buffer => Buffer.from(`enc:${value}`, 'utf8'),
  decryptString: (value: Buffer): string => {
    const text = value.toString('utf8')
    if (!text.startsWith('enc:')) throw new Error('not encrypted by the test safeStorage')
    return text.slice(4)
  },
}

export const shell = {
  openPath: async (_path: string): Promise<string> => '',
  openExternal: async (_url: string): Promise<void> => undefined,
  showItemInFolder: (_path: string): void => undefined,
  trashItem: async (_path: string): Promise<void> => undefined,
}

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: true }),
  showMessageBox: async (): Promise<{ response: number }> => ({ response: 0 }),
  showErrorBox: (): void => undefined,
}

export const clipboard = {
  text: '',
  writeText(value: string): void {
    clipboard.text = value
  },
  readText(): string {
    return clipboard.text
  },
}

export const nativeTheme = { shouldUseDarkColors: true, themeSource: 'system', on: (): void => undefined }

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true, resize: () => ({ toPNG: () => Buffer.alloc(0) }), toPNG: () => Buffer.alloc(0) }),
  createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({ toPNG: () => Buffer.alloc(0) }), toPNG: () => Buffer.alloc(0) }),
  createEmpty: () => ({ isEmpty: () => true }),
}

export const protocol = {
  registerSchemesAsPrivileged: (): void => undefined,
  handle: (): void => undefined,
}

export const powerMonitor = { on: (): void => undefined, off: (): void => undefined, removeListener: (): void => undefined }

export class Notification extends EventEmitter {
  static isSupported(): boolean {
    return true
  }
  static shown: Array<{ title?: string; body?: string }> = []
  constructor(readonly options: { title?: string; body?: string } = {}) {
    super()
  }
  show(): void {
    Notification.shown.push(this.options)
  }
  close(): void {}
}

export const utilityProcess = {
  fork: (): never => {
    throw new Error('utilityProcess.fork is not available in unit tests')
  },
}
export type UtilityProcess = { kill(): boolean; pid?: number }

export default {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  shell,
  dialog,
  clipboard,
  nativeTheme,
  nativeImage,
  protocol,
  powerMonitor,
  Notification,
  utilityProcess,
}
