/**
 * macOS portable folders have no launcher, so the app does what the launcher does on
 * Windows/Linux: write install.json on first start (portable=true, dataRoot=R/data,
 * channel from portable.json) and rebase it when the folder has moved. Windows/Linux
 * portable records are the launcher's; this never runs there.
 */
import { join } from 'node:path'
import type { InstallRecord } from '@shared/install'
import { BUNDLE_NAME, PORTABLE_FILE, isWithin, samePath } from './layout'
import { readInstallRecord, readJsonObject, writeInstallRecord } from './record'
import type { RunContext } from './runContext'

export function ensureMacPortableRecord(context: RunContext, version: string, now: Date = new Date()): InstallRecord | null {
  if (context.platform !== 'darwin' || context.mode !== 'portable' || !context.root || !context.recordPath || !context.platformKey) return null
  const root = context.root
  const existing = readInstallRecord(context.recordPath)
  if (existing && samePath('darwin', existing.root, root)) return existing
  const at = now.toISOString()
  const marker = readJsonObject(join(root, PORTABLE_FILE)) ?? {}
  const channel = marker['channel'] === 'beta' ? 'beta' : 'stable'
  const record: InstallRecord = existing
    ? {
        ...existing,
        root,
        appPath: join(root, BUNDLE_NAME),
        dataRoot: isWithin('darwin', existing.root, existing.dataRoot) ? join(root, 'data') : existing.dataRoot,
        updatedAt: at,
      }
    : {
        schema: 1,
        platform: context.platformKey,
        root,
        appPath: join(root, BUNDLE_NAME),
        dataRoot: join(root, 'data'),
        portable: true,
        channel,
        // The bundle that is running is what this folder holds (portable.json may predate an update).
        current: version,
        failed: [],
        confirmed: false,
        installedAt: at,
        updatedAt: at,
      }
  writeInstallRecord(context.recordPath, record)
  context.record = record
  return record
}
