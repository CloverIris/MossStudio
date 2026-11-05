import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareEngineTags, parseEngineStamp } from '@shared/engineUpdate'
import type { EnginePackage } from '@shared/enginePackages'
import type { JobRecord, LocalEngineVersion, MossInferDownloadState, MossInferRelease, Settings } from '@shared/types'
import type { ActivationGate } from '../lib/engineActivation'
import { paths } from '../lib/paths'
import { engineReadiness } from './engineReadiness'
import { localEngineVersions } from './engines'
import { getMossInferDownloadState, listMossInferReleases } from './mossInferDownload'
import { installEnginePlan } from './enginePlan'
import { getSettings } from './settings'
import { listJobs } from './supervisor'

/**
 * Keeps the inference engine on the newest stable release when
 * `settings.engineAutoUpdate` is on (the default).
 *
 * - Only managed stable installs are updated: a custom engine or a CI build
 *   was picked on purpose and is left alone.
 * - A release the person installed on purpose while a newer one existed (a
 *   rollback) is pinned and skipped until they update by hand or turn the
 *   switch back on.
 * - Every installed package kind is kept current (each CUDA flavour/arch/
 *   runtime, Vulkan, HIP), read from the folder names of the installs in use.
 * - The new build downloads in the background but is only activated while no
 *   engine job runs, because activating restarts the engine.
 * - A release that failed to install is retried with growing gaps instead of
 *   a full download at every check.
 */

export interface EngineAutoUpdateState {
  /** Release the person chose to stay on. */
  pinnedTag?: string
  /** Last release that failed to install, and how often in a row. */
  failed?: { tag: string; at: number; count: number }
}

export interface InstallRequest {
  /** Every package in use whose install is older than the release. */
  packages: EnginePackage[]
  releaseTag: string
  activation: Omit<ActivationGate, 'signal'>
}

export interface EngineAutoUpdateDeps {
  getSettings: () => Settings
  engineReady: () => Promise<boolean>
  versions: () => LocalEngineVersion[]
  releases: () => Promise<MossInferRelease[]>
  jobs: () => Promise<JobRecord[]>
  downloadState: () => MossInferDownloadState | null
  install: (request: InstallRequest) => Promise<MossInferDownloadState>
  readState: () => EngineAutoUpdateState
  writeState: (state: EngineAutoUpdateState) => void
  now?: () => number
}

export type EngineAutoUpdateResult =
  | 'disabled'
  | 'not-installed'
  | 'unmanaged'
  | 'pinned'
  | 'backoff'
  | 'busy'
  | 'current'
  | 'updated'
  | 'failed'

const ACTIVE_JOB_STATES = new Set<JobRecord['state']>(['queued', 'starting', 'running'])
const DAY_MS = 24 * 60 * 60_000

/** One day after the first failure, then 2, 4, capped at a week. */
export function failureBackoffMs(count: number): number {
  return Math.min(7 * DAY_MS, DAY_MS * 2 ** Math.max(0, count - 1))
}

/** True while local engine jobs are queued or running (training and remote jobs don't use this engine). */
export function hasActiveEngineJobs(jobs: JobRecord[]): boolean {
  return jobs.some((job) => !job.hostId && job.kind !== 'training' && ACTIVE_JOB_STATES.has(job.state))
}

export async function runEngineAutoUpdate(deps: EngineAutoUpdateDeps): Promise<EngineAutoUpdateResult> {
  const now = deps.now ?? Date.now
  const settings = deps.getSettings()
  if (!settings.engineAutoUpdate) return 'disabled'
  // First installs belong to Setup; this only keeps an existing engine current.
  if (!(await deps.engineReady())) return 'not-installed'
  const inUse = deps.versions().filter((version) => version.current)
  if (inUse.length === 0) return 'not-installed'
  // Stable managed installs in use, one per package (the newest one when several are in use).
  const stamps = inUse
    .map((version) => (version.source === 'managed' ? parseEngineStamp(version.name) : null))
    .filter((stamp): stamp is NonNullable<typeof stamp> => stamp?.channel === 'stable')
  if (stamps.length === 0) return 'unmanaged'
  const state = deps.readState()
  if (state.pinnedTag && stamps.some((stamp) => stamp.tag === state.pinnedTag)) return 'pinned'
  const latest = [...await deps.releases()].sort((a, b) => compareEngineTags(b.tag, a.tag))[0]
  if (!latest) return 'current'
  const outdated = new Map<string, EnginePackage>()
  for (const stamp of stamps) {
    const newerInstalled = stamps.some((other) => other.packageId === stamp.packageId && compareEngineTags(other.tag, latest.tag) >= 0)
    if (!newerInstalled && compareEngineTags(latest.tag, stamp.tag) > 0) outdated.set(stamp.packageId, stamp.package)
  }
  if (outdated.size === 0) return 'current'
  const target = latest.tag
  if (state.failed?.tag === target && now() - state.failed.at < failureBackoffMs(state.failed.count)) return 'backoff'
  const download = deps.downloadState()
  if (download && !['done', 'error', 'canceled'].includes(download.phase)) return 'busy'
  if (hasActiveEngineJobs(await deps.jobs())) return 'busy'
  const result = await deps.install({
    packages: [...outdated.values()],
    releaseTag: target,
    // Jobs may start during the download: check again, under the activation lock, right before switching.
    activation: { canActivate: async () => !hasActiveEngineJobs(await deps.jobs()) },
  })
  if (result.phase === 'done') {
    deps.writeState({ ...state, failed: undefined })
    return 'updated'
  }
  if (result.phase === 'error') {
    const count = state.failed?.tag === target ? state.failed.count + 1 : 1
    deps.writeState({ ...state, failed: { tag: target, at: now(), count } })
  }
  return 'failed'
}

/* ------------------------------------------------------------------ */
/* Pinning after manual installs                                        */
/* ------------------------------------------------------------------ */

/**
 * A stable install the person started by hand. Picking an older release than
 * the newest one pins it; installing the newest (or no specific release)
 * clears the pin. When the newest is unknown (offline) the pin stays as it was.
 */
export function stateAfterManualInstall(
  state: EngineAutoUpdateState,
  releaseTag: string | undefined,
  latestTag: string | null,
): EngineAutoUpdateState {
  if (!releaseTag) return {}
  if (latestTag === null) return state
  return compareEngineTags(latestTag, releaseTag) > 0 ? { ...state, pinnedTag: releaseTag } : {}
}

function stateFile(): string {
  return join(paths.root(), 'engine-auto-update.json')
}

export function readEngineAutoUpdateState(): EngineAutoUpdateState {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as EngineAutoUpdateState : {}
  } catch {
    return {}
  }
}

export function writeEngineAutoUpdateState(state: EngineAutoUpdateState): void {
  try {
    writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    console.warn('[engine-auto-update] state', error)
  }
}

/** Called after a manual stable install finished (Settings, Setup). */
export async function recordManualEngineInstall(releaseTag: string | undefined): Promise<void> {
  let latestTag: string | null = null
  if (releaseTag) {
    try {
      latestTag = [...await listMossInferReleases()].sort((a, b) => compareEngineTags(b.tag, a.tag))[0]?.tag ?? null
    } catch {
      latestTag = null
    }
  }
  writeEngineAutoUpdateState(stateAfterManualInstall(readEngineAutoUpdateState(), releaseTag, latestTag))
}

/** Turning 自动更新 back on means "keep me current" again. */
export function clearEngineAutoUpdateHold(): void {
  const state = readEngineAutoUpdateState()
  if (state.pinnedTag || state.failed) writeEngineAutoUpdateState({})
}

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

/** First check a few minutes after start, then every six hours. */
const FIRST_CHECK_MS = 3 * 60_000
const INTERVAL_MS = 6 * 60 * 60_000
/** A busy engine is checked again sooner than the regular interval. */
const BUSY_RETRY_MS = 20 * 60_000

let timer: NodeJS.Timeout | null = null
let running = false

// Static imports on purpose: dynamic imports here make the bundler split the main
// process into chunks, which breaks windows.ts paths relative to __dirname.
function defaultDeps(): EngineAutoUpdateDeps {
  return {
    getSettings,
    engineReady: async () => (await engineReadiness()).state === 'ready',
    versions: localEngineVersions,
    releases: listMossInferReleases,
    jobs: listJobs,
    downloadState: getMossInferDownloadState,
    install: ({ packages, releaseTag, activation }) =>
      installEnginePlan({ channel: 'stable', packages, releaseTag, activation }),
    readState: readEngineAutoUpdateState,
    writeState: writeEngineAutoUpdateState,
  }
}

function schedule(delay: number): void {
  timer = setTimeout(() => void tick(), delay)
  timer.unref?.()
}

async function tick(): Promise<void> {
  if (running) return
  running = true
  let next = INTERVAL_MS
  try {
    const result = await runEngineAutoUpdate(defaultDeps())
    if (result === 'busy') next = BUSY_RETRY_MS
    if (result === 'updated' || result === 'failed') console.log(`[engine-auto-update] ${result}`)
  } catch (error) {
    // Offline or rate-limited: try again at the next interval.
    console.warn('[engine-auto-update]', error instanceof Error ? error.message : error)
  } finally {
    running = false
    if (timer) schedule(next)
  }
}

export function startEngineAutoUpdate(): void {
  if (timer) return
  schedule(FIRST_CHECK_MS)
}

export function stopEngineAutoUpdate(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
