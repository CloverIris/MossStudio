/**
 * One MossStudio per user (Electron's single-instance lock, keyed on userData). The launcher
 * relies on it: when the app already runs, the launcher just starts another process and the
 * lock forwards its arguments to the running one.
 *
 *   normal run       take the lock after runInstallMode(); a second instance quits and the
 *                    first one focuses its window
 *   setup/uninstall  never block on the lock: they PROBE it (with `{ moss: <request> }` as the
 *                    additional data), so the running app can offer to close itself, and the
 *                    probe tells setup/uninstall that MossStudio is still running
 */
import { app, BrowserWindow, dialog } from 'electron'

export type InstanceRequest = 'setup' | 'uninstall' | 'silent'

export type SecondInstanceAction = 'focus' | 'ask-close-for-setup' | 'ask-close-for-uninstall' | 'ignore'

/** What the running app does when another process asks for the lock. */
export function secondInstanceAction(data: unknown): SecondInstanceAction {
  const request = (data as { moss?: unknown } | null | undefined)?.moss
  if (request === 'setup') return 'ask-close-for-setup'
  if (request === 'uninstall') return 'ask-close-for-uninstall'
  if (request === 'silent') return 'ignore'
  return 'focus'
}

let asking = false

async function askToClose(reason: 'setup' | 'uninstall'): Promise<void> {
  if (asking) return
  asking = true
  try {
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'MossStudio',
      message: reason === 'uninstall' ? '要卸载 MossStudio，需要先关闭它。' : '安装程序需要先关闭 MossStudio。',
      detail: '正在进行的生成、训练和下载会被中断。',
      buttons: ['关闭 MossStudio', '取消'],
      defaultId: 0,
      cancelId: 1,
    }
    const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    if (response === 0) app.quit()
  } finally {
    asking = false
  }
}

/**
 * Normal run: take the lock. False means another instance has it; this one quits (its
 * arguments were forwarded). The first instance focuses `focus()` or offers to close.
 */
export function acquireAppLock(focus: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    const action = secondInstanceAction(data)
    if (action === 'focus') focus()
    else if (action === 'ask-close-for-setup') void askToClose('setup')
    else if (action === 'ask-close-for-uninstall') void askToClose('uninstall')
  })
  return true
}

/**
 * Setup/uninstall: is MossStudio running for this user? Asks for the lock with `request` as
 * additional data (the running app then offers to close itself, unless silent). Once this
 * process holds the lock, later probes answer false.
 */
export function otherInstanceRunning(request: InstanceRequest): boolean {
  return !app.requestSingleInstanceLock({ moss: request })
}

/** Before setup starts the installed app: let it take the lock. */
export function releaseAppLock(): void {
  if (app.hasSingleInstanceLock()) app.releaseSingleInstanceLock()
}

/**
 * Setup/uninstall: when their probe holds the lock, a normal MossStudio start quits as the
 * second instance; this brings the setup or uninstall window forward so the start is not lost
 * silently.
 */
export function focusOnSecondInstance(window: () => BrowserWindow | null): void {
  app.on('second-instance', () => {
    const win = window()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}
