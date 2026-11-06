/** Windows taskbar identity: one AppUserModelID for the app, its windows and its shortcuts. */
import { app, type BrowserWindow } from 'electron'
import { APP_USER_MODEL_ID, PRODUCT_NAME } from './layout'
import { getRunContext } from './runContext'

/** Called once at startup on Windows: shortcuts and the taskbar group under this id. */
export function applyAppUserModelId(): void {
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)
}

/** Pins of this window relaunch through the launcher, so they survive version switches. */
export function applyAppDetails(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  const launcher = getRunContext().launcher
  if (!launcher) return
  try {
    win.setAppDetails({
      appId: APP_USER_MODEL_ID,
      appIconPath: launcher,
      appIconIndex: 0,
      relaunchCommand: `"${launcher}"`,
      relaunchDisplayName: PRODUCT_NAME,
    })
  } catch (error) {
    console.error('[install] setAppDetails', error)
  }
}
