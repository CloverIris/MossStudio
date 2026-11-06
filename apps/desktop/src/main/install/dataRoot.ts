/**
 * The data root, in order:
 *   1. MOSSSTUDIO_DATA (tests, relocated installs)
 *   2. install.json `dataRoot` (portable: only while R has not moved since it was written)
 *   3. portable: R/data
 *   4. installed without a readable install.json: R/data (macOS: the locator's data root)
 *   5. setup mode: a throwaway folder in temp (setup never touches user data)
 *   6. dev and loose builds: Electron userData
 * The paths.ts override (setDataRoot) sits between 1 and 2.
 */
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathFor, samePath } from './layout'
import type { RunContext } from './runContext'

export interface DataRootFallbacks {
  userData(): string
  scratch(): string
}

export function envDataRoot(env: Record<string, string | undefined>): string | null {
  const value = env['MOSSSTUDIO_DATA']?.trim()
  return value ? resolve(value) : null
}

export function contextDataRoot(context: RunContext, fallbacks: DataRootFallbacks): string {
  const p = pathFor(context.platform)
  const { record, root } = context
  if (record && !(context.portable && root && !samePath(context.platform, record.root, root))) return record.dataRoot
  if (context.portable && root) return p.join(root, 'data')
  if ((context.mode === 'installed' || context.mode === 'uninstall') && root) {
    return context.platform === 'darwin' && context.locator ? context.locator.dataRoot : p.join(root, 'data')
  }
  if (context.mode === 'setup') return fallbacks.scratch()
  return fallbacks.userData()
}

export function resolveDataRoot(context: RunContext, env: Record<string, string | undefined>, fallbacks: DataRootFallbacks): string {
  return envDataRoot(env) ?? contextDataRoot(context, fallbacks)
}

export function setupScratchRoot(): string {
  return join(tmpdir(), `MossStudio-setup-${process.pid}`)
}

/**
 * The data root the install itself records, ignoring MOSSSTUDIO_DATA and setDataRoot: what
 * install.json (fresh, when given) says, else portable/installed R/data. The uninstall plan
 * must carry exactly this, since the launcher checks it against install.json.
 */
export function recordedDataRoot(context: RunContext, fresh: RunContext['record'] = context.record): string | null {
  if (!context.root) return null
  return contextDataRoot(
    { ...context, record: fresh ?? context.record },
    {
      userData: () => pathFor(context.platform).join(context.root!, 'data'),
      scratch: () => pathFor(context.platform).join(context.root!, 'data'),
    },
  )
}

/**
 * Portable copies keep Electron's profile inside their data root (R/data/.electron), so the
 * folder stays self-contained and its single-instance lock is its own, not the installed
 * app's. Null outside portable mode.
 */
export function portableUserData(context: RunContext): string | null {
  if (context.mode !== 'portable' || !context.root) return null
  const dataRoot = recordedDataRoot(context)
  return dataRoot ? pathFor(context.platform).join(dataRoot, '.electron') : null
}
