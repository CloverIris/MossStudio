/**
 * CI integration hook (tools/release/integration/run.mjs). Active ONLY in builds that baked in a
 * test key (`__MOSS_UPDATE_TEST_KEYS__` non-empty, see isUpdateTestBuild); a release build never
 * reads the file. It is a file, not env, because macOS reopens the bundle through `open`.
 *
 *   <dataRoot>/moss-test.json         { "pollMs": 2000, "crashVersions": ["1.0.6"] }
 *     pollMs         check the feed at start and then every pollMs, download automatically, and as
 *                    soon as `pending` is set and this version's health is confirmed, restart
 *                    through the normal handoff (launcher / macOS swap helper)
 *     crashVersions  exit(3) at startup, before confirming health, when app.getVersion() is listed
 *   <dataRoot>/moss-test-status.json  the last UpdaterState, for the CI log
 */
import { promises as fsp, readFileSync } from 'original-fs'
import { join } from 'node:path'
import type { UpdaterState } from '@shared/update'

export const TEST_HOOK_FILE = 'moss-test.json'
export const TEST_STATUS_FILE = 'moss-test-status.json'
export const TEST_CRASH_EXIT_CODE = 3

export interface UpdateTestHook {
  /** Poll interval in ms (at least 200); null keeps the normal schedule. */
  pollMs: number | null
  crashVersions: string[]
}

export function parseTestHook(text: string): UpdateTestHook | null {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as { pollMs?: unknown; crashVersions?: unknown }
  const pollMs = typeof value.pollMs === 'number' && Number.isFinite(value.pollMs) && value.pollMs > 0 ? Math.max(200, Math.round(value.pollMs)) : null
  const crashVersions = Array.isArray(value.crashVersions) ? value.crashVersions.filter((item): item is string => typeof item === 'string') : []
  return { pollMs, crashVersions }
}

/** The hook, or null: always null unless `testBuild` (a release build ignores the file completely). */
export function loadTestHook(dataRoot: string, testBuild: boolean): UpdateTestHook | null {
  if (!testBuild) return null
  try {
    return parseTestHook(readFileSync(join(dataRoot, TEST_HOOK_FILE), 'utf8'))
  } catch {
    return null
  }
}

export function shouldCrash(hook: UpdateTestHook | null, version: string): boolean {
  return Boolean(hook?.crashVersions.includes(version))
}

/** Restart once the update is materialized and this run has proven itself. */
export function readyToRestart(state: Pick<UpdaterState, 'phase' | 'pending'>, confirmed: boolean): boolean {
  return confirmed && state.phase === 'ready' && Boolean(state.pending)
}

export async function writeTestStatus(dataRoot: string, state: UpdaterState): Promise<void> {
  const file = join(dataRoot, TEST_STATUS_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify({ at: new Date().toISOString(), ...state }, null, 2)}\n`)
  await fsp.rename(tmp, file)
}
