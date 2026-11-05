import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasHfToken } from './hfCredentials'
import type { Settings } from '@shared/types'
import { paths, setEngineRoot } from '../lib/paths'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  uiAnimation: 'system',
  language: 'zh-CN',
  networkMode: 'auto',
  gitMirror: null,
  pipIndex: null,
  hfEndpoint: null,
  hasHfToken: false,
  modelDownloadConcurrency: 4,
  hfQueryHostId: null,
  modelsRoot: null,
  modelDirectories: {
    dit: null,
    textEncoder: null,
    vae: null,
    support: null,
    adapters: null,
  },
  pythonPath: null,
  torchBackend: 'auto',
  torchIndex: null,
  autoCheckUpdates: true,
  desktopNotifications: true,
  lanWebEnabled: false,
  lanWebPort: null,
  lanWebInstanceId: null,
  updateChannel: 'stable',
  dismissedAnnouncements: [],
  dismissedUpdateVersion: null,
  sidebarCollapsed: false,
  onboardingState: 'pending',
  onboardingHostId: 'local',
  galleryRoots: [],
  homeBackground: null,
    trainerRoot: null,
    engineRoot: null,
  gbcRoot: null,
  inferenceBackend: 'mossinfer',
  mossInferServerPath: null,
  mossInferMemoryMode: 'balanced',
  mossInferTier: 'high',
  mossInferChannel: 'stable',
  mossInferVariant: 'system-cuda',
  mossInferArchitecture: 'auto',
  gpuSelection: 'auto',
  gpuProfileMode: 'auto',
  gpuProfileOverrides: {},
  githubToken: null,
  disabledDevices: [],
  deviceLabels: {},
  remoteHostsEnabled: false,
  trainingEnabled: false,
  engineAutoUpdate: true,
}

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  try {
    const raw = readFileSync(paths.settings(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Settings>
    cache = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      modelDirectories: { ...DEFAULT_SETTINGS.modelDirectories, ...parsed.modelDirectories },
      gpuProfileOverrides: parsed.gpuProfileOverrides ?? DEFAULT_SETTINGS.gpuProfileOverrides,
    }
    if (
      typeof cache.gpuSelection !== 'object' ||
      cache.gpuSelection === null ||
      typeof cache.gpuSelection.uuid !== 'string' ||
      cache.gpuSelection.uuid.startsWith('cuda:')
    ) {
      cache.gpuSelection = 'auto'
    }
    if (!Array.isArray(cache.dismissedAnnouncements)) cache.dismissedAnnouncements = []
    // Optional features arrived after users had already configured them: keep
    // them visible for anyone who was using them before the switch existed.
    if (parsed.remoteHostsEnabled === undefined) cache.remoteHostsEnabled = hasConfiguredRemoteHosts()
    if (parsed.trainingEnabled === undefined) cache.trainingEnabled = hasTrainerInstall(parsed.trainerRoot ?? null)
    if ((cache.mossInferVariant as string) === 'sm75') {
      cache.mossInferVariant = 'system-cuda'
      cache.mossInferArchitecture = 'sm75'
    }
    // MossInfer 2.0 (server protocol 2) removed the auto tier: load requires
    // reference | high | turbo. Map legacy configs to the recommended default.
    if ((cache.mossInferTier as string) === 'auto') cache.mossInferTier = 'high'
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  cache.hasHfToken = hasHfToken()
  setEngineRoot(cache.engineRoot)
  return cache
}

/**
 * Whether this user really trained before the switch existed. The trainer
 * folder alone says nothing: ensureDirs creates trainer/git, versions and
 * runtimes on every launch. A created version (a non-empty folder under
 * versions/) or a past training job counts.
 */
export function hasTrainerInstall(trainerRoot: string | null): boolean {
  try {
    const versions = join(paths.trainerRoot(trainerRoot), 'versions')
    const created = readdirSync(versions, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false
      try { return readdirSync(join(versions, entry.name)).length > 0 } catch { return false }
    })
    if (created) return true
  } catch {
    // no versions folder: fall through to the job history
  }
  try {
    const jobs = JSON.parse(readFileSync(join(paths.root(), 'jobs', 'jobs.json'), 'utf8')) as unknown
    return Array.isArray(jobs) && jobs.some((job) => typeof job === 'object' && job !== null && (job as { kind?: unknown }).kind === 'training')
  } catch {
    return false
  }
}

function hasConfiguredRemoteHosts(): boolean {
  for (const name of ['hosts.json', 'training-hosts.json']) {
    try {
      const hosts = JSON.parse(readFileSync(join(paths.root(), name), 'utf8')) as unknown
      if (Array.isArray(hosts) && hosts.length > 0) return true
    } catch {
      // missing or unreadable: no remote hosts configured
    }
  }
  return false
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings()
  const next: Settings = {
    ...current,
    ...patch,
    modelDirectories: { ...current.modelDirectories, ...patch.modelDirectories },
  }
  if (patch.dismissedAnnouncements) {
    next.dismissedAnnouncements = Array.from(new Set(patch.dismissedAnnouncements)).slice(-200)
  }
  next.hasHfToken = hasHfToken()
  atomicWriteJson(paths.settings(), next)
  cache = next
  setEngineRoot(next.engineRoot)
  return next
}

export function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }


}
