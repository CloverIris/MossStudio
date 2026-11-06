/**
 * Chromium switches and paths an install mode needs, decided before ready (pure).
 *
 *   silent setup/uninstall  no window at all: disable hardware acceleration and keep the GPU in
 *                           the browser process (in-process-gpu), so no GPU process or broker
 *                           exists that could outlive app.exit() and keep R busy
 *   interactive windows     the default GPU path: disabling acceleration kept the setup window
 *                           from ever being mapped on a Wayland compositor (also true for the
 *                           normal app with --disable-gpu); they quit via app.quit(), which
 *                           shuts Chromium's helpers down properly
 *   portable                Electron's profile (and so its single-instance lock) in R/data/.electron
 */
import { portableUserData } from './dataRoot'
import type { RunContext } from './runContext'

export interface InstallModeSwitches {
  disableHardwareAcceleration: boolean
  inProcessGpu: boolean
  userData: string | null
}

export function installModeSwitches(context: RunContext): InstallModeSwitches {
  const silentInstallMode = context.silent && (context.mode === 'setup' || context.mode === 'uninstall')
  return {
    disableHardwareAcceleration: silentInstallMode,
    inProcessGpu: silentInstallMode,
    userData: portableUserData(context),
  }
}
