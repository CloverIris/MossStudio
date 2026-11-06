import { describe, expect, it } from 'vitest'
import type { RunContext } from '@main/install/runContext'
import { installModeSwitches } from '@main/install/switches'

function context(patch: Partial<RunContext>): RunContext {
  return {
    mode: 'installed', platform: 'linux', platformKey: 'linux-x64', packaged: true, launched: false, silent: false, root: '/opt/R',
    launcher: null, appPath: '/opt/R/app-2.0.0', recordPath: '/opt/R/install.json', record: null, locatorPath: '', locator: null,
    portable: false, setup: null, ...patch,
  }
}

describe('installModeSwitches', () => {
  it('silent setup and uninstall run without a GPU process', () => {
    for (const mode of ['setup', 'uninstall'] as const) {
      expect(installModeSwitches(context({ mode, silent: true }))).toEqual({ disableHardwareAcceleration: true, inProcessGpu: true, userData: null })
    }
  })

  it('interactive setup and uninstall windows keep the default GPU path (Wayland never mapped them without it)', () => {
    for (const mode of ['setup', 'uninstall'] as const) {
      expect(installModeSwitches(context({ mode, silent: false }))).toEqual({ disableHardwareAcceleration: false, inProcessGpu: false, userData: null })
    }
  })

  it('the normal app is untouched; portable gets its own profile folder', () => {
    expect(installModeSwitches(context({ silent: true }))).toEqual({ disableHardwareAcceleration: false, inProcessGpu: false, userData: null })
    expect(installModeSwitches(context({ mode: 'portable', portable: true }))).toEqual({ disableHardwareAcceleration: false, inProcessGpu: false, userData: '/opt/R/data/.electron' })
  })
})
