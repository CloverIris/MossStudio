import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { compareEngineTags, parseEngineStamp } from '@shared/engineUpdate'
import { hasHfToken } from './hfCredentials'
import type { Settings } from '@shared/types'
import { isInside, paths, setEngineRoot } from '../lib/paths'

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
  desktopNotifications: true,
  lanWebEnabled: false,
  lanWebPort: null,
  lanWebInstanceId: null,
  updateChannel: 'stable',
  autoDownloadUpdates: true,
  skippedUpdateVersion: null,
  dismissedAnnouncements: [],
  noticedFailedUpdates: [],
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
  engineDeviceOverrides: {},
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
    if (!Array.isArray(cache.noticedFailedUpdates)) cache.noticedFailedUpdates = []
    // Optional features arrived after users had already configured them: keep
    // them visible for anyone who was using them before the switch existed.
    if (parsed.remoteHostsEnabled === undefined) cache.remoteHostsEnabled = hasConfiguredRemoteHosts()
    if (parsed.trainingEnabled === undefined) cache.trainingEnabled = hasTrainerInstall(parsed.trainerRoot ?? null)
    migrateLegacyEngineSettings(cache, parsed as Record<string, unknown>)
    // MossInfer 2.0 (server protocol 2) removed the auto tier: load requires
    // reference | high | turbo. Map legacy configs to the recommended default.
    if ((cache.mossInferTier as string) === 'auto') cache.mossInferTier = 'high'
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  cache.hasHfToken = hasHfToken()
  setEngineRoot(cache.engineRoot)
  if (legacyEnginePin(cache)) cache.mossInferServerPath = null
  if (legacyBundledPending) {
    legacyBundledPending = false
    writeLegacyEngineVariant(paths.mossinfer(), 'bundled')
  }
  return cache
}

let legacyPinPending = false
let legacyBundledPending = false

/**
 * The old global 「内置 CUDA」 choice, kept until the machine probe knows the
 * NVIDIA GPUs and turns it into their engineDeviceOverrides (enginePlan.ts).
 */
const LEGACY_VARIANT_FILE = 'legacy-engine-variant.json'

export function writeLegacyEngineVariant(root: string, variant: 'bundled'): void {
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, LEGACY_VARIANT_FILE), JSON.stringify({ variant }), 'utf8')
  } catch (error) {
    console.warn('[settings] legacy engine variant', error)
  }
}

/** The pending old 「内置 CUDA」 choice, if any; `take` removes it. */
export function legacyEngineVariant(root: string, take = false): 'bundled' | null {
  const file = join(root, LEGACY_VARIANT_FILE)
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { variant?: unknown }
    if (take) rmSync(file, { force: true })
    return raw.variant === 'bundled' ? 'bundled' : null
  } catch {
    return null
  }
}

/**
 * Engine packages are chosen per GPU now (engineDeviceOverrides). The old
 * global package type / architecture are dropped: the installed packages keep
 * them (a bundled or SM75 install stays the one that GPU runs, and auto-update
 * keeps the same package current). The old downloader also wrote every
 * managed install into mossInferServerPath; that pin is released once so each
 * GPU uses its own package, but only when it is the newest install of its
 * package: an older one was a deliberate rollback and stays. A custom
 * (external) moss-server stays pinned. An explicit 「内置 CUDA」 becomes a
 * per-GPU override once the GPUs are known.
 */
export function migrateLegacyEngineSettings(settings: Settings, parsed: Record<string, unknown>): void {
  const legacy = settings as Settings & { mossInferVariant?: unknown; mossInferArchitecture?: unknown }
  const hadLegacy = 'mossInferVariant' in parsed || 'mossInferArchitecture' in parsed
  delete legacy.mossInferVariant
  delete legacy.mossInferArchitecture
  if (!settings.engineDeviceOverrides || typeof settings.engineDeviceOverrides !== 'object' || Array.isArray(settings.engineDeviceOverrides)) {
    settings.engineDeviceOverrides = {}
  }
  legacyPinPending = hadLegacy
  legacyBundledPending = parsed['mossInferVariant'] === 'bundled'
}

function legacyEnginePin(settings: Settings): boolean {
  if (!legacyPinPending) return false
  legacyPinPending = false
  const pinned = settings.mossInferServerPath
  if (!pinned || !isInside(paths.mossinfer(), pinned)) return false
  return isNewestManagedInstall(paths.mossinfer(), pinned)
}

/** Whether `<root>/<stamp>/bin/moss-server` is the newest stable install of its package (no newer tag next to it). */
export function isNewestManagedInstall(root: string, serverPath: string): boolean {
  const name = relative(root, serverPath).split(/[\\/]/)[0] ?? ''
  const stamp = parseEngineStamp(name)
  if (!stamp) return true
  if (stamp.channel !== 'stable') return true
  let siblings: string[] = []
  try { siblings = readdirSync(root) } catch { return true }
  return !siblings.some((other) => {
    const candidate = parseEngineStamp(other)
    return candidate?.channel === 'stable' && candidate.packageId === stamp.packageId && compareEngineTags(candidate.tag, stamp.tag) > 0
  })
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
