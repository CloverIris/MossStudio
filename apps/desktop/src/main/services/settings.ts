import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Settings } from '@shared/types'
import { paths } from '../lib/paths'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  uiAnimation: 'system',
  language: 'zh-CN',
  networkMode: 'auto',
  gitMirror: null,
  pipIndex: null,
  hfEndpoint: null,
  modelsRoot: null,
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
  gbcRoot: null,
  inferenceBackend: 'mossinfer',
  mossInferServerPath: null,
  mossInferMemoryMode: 'balanced',
  mossInferTier: 'high',
  mossInferChannel: 'stable',
  mossInferVariant: 'system-cuda',
  githubToken: null,
  disabledDevices: [],
  deviceLabels: {},
}

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  try {
    const raw = readFileSync(paths.settings(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Settings>
    cache = { ...DEFAULT_SETTINGS, ...parsed }
    if (!Array.isArray(cache.dismissedAnnouncements)) cache.dismissedAnnouncements = []
    // MossInfer 2.0 (server protocol 2) removed the auto tier: load requires
    // reference | high | turbo. Map legacy configs to the recommended default.
    if ((cache.mossInferTier as string) === 'auto') cache.mossInferTier = 'high'
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch }
  if (patch.dismissedAnnouncements) {
    next.dismissedAnnouncements = Array.from(new Set(patch.dismissedAnnouncements)).slice(-200)
  }
  atomicWriteJson(paths.settings(), next)
  cache = next
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
