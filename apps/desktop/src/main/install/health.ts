import { readInstallRecord, updateInstallRecord } from './record'
import type { RunContext } from './runContext'

/**
 * Health confirmation: set confirmed=true in install.json when it records the version that
 * is running. The Updater calls this HEALTH_CONFIRM_MS after the window has been shown.
 * Returns true when the record now says confirmed (also when it already did); false when
 * there is no record or it is for another version (nothing is written then).
 */
export function confirmHealthFor(context: RunContext, runningVersion: string, now: Date = new Date()): boolean {
  if (!context.recordPath) return false
  const current = readInstallRecord(context.recordPath)
  if (!current || current.current !== runningVersion) return false
  if (current.confirmed) return true
  const next = updateInstallRecord(context.recordPath, (record) => ({ ...record, confirmed: true, updatedAt: now.toISOString() }))
  return Boolean(next?.confirmed)
}
