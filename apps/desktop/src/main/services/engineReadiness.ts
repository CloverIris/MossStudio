import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EngineReadiness } from '@shared/types'
import { getEngineInstallProgress, readEngineLastAttempt } from '../lib/engineStore'
import { paths } from '../lib/paths'
import { resolveServerPath } from './mossInfer'
import { getSettings } from './settings'
import { deviceEngines } from './engineInstalls'

type ReadinessBase = Omit<EngineReadiness, 'installing' | 'lastAttempt'>

let cache: { key: string; createdAt: number; value: ReadinessBase } | null = null

export function invalidateEngineReadiness(): void {
  cache = null
}

/**
 * Ready when at least one local GPU has an installed package that runs on it
 * (or, before any GPU is known, when a moss-server is found the old way).
 * `devices` says which package each GPU runs.
 */
function calculateReadiness(): ReadinessBase {
  const engines = deviceEngines()
  const devices = engines.map(({ gpu, engine, memorySkipped }) => ({
    deviceUuid: gpu.id,
    name: gpu.name,
    packageId: engine?.packageId ?? null,
    path: engine?.binaryPath ?? null,
    ...(memorySkipped ? { memorySkipped: true } : {}),
  }))
  const selection = getSettings().gpuSelection
  const preferred =
    typeof selection === 'object' ? devices.find((device) => device.deviceUuid === selection.uuid && device.path) : undefined
  const first = preferred ?? devices.find((device) => device.path)
  if (first?.path) return { state: 'ready', path: first.path, devices }
  if (engines.length === 0) {
    const path = resolveServerPath(getSettings())
    if (path && existsSync(path)) return { state: 'ready', path, devices }
  }
  return {
    state: 'missing',
    path: null,
    devices,
    reason: engines.length > 0 ? '还没有安装适合这台电脑显卡的推理引擎；请安装引擎' : '未找到 moss-server；请下载引擎或设置路径',
  }
}

function fingerprint(): string {
  const path = resolveServerPath(getSettings())
  const legacy = path && existsSync(path) ? `${resolve(path)}:${statSync(path).mtimeMs}` : 'none'
  let root = 'none'
  try {
    root = String(statSync(paths.mossinfer()).mtimeMs)
  } catch {
    /* no engine root yet */
  }
  const settings = getSettings()
  return `${legacy}|${root}|${settings.mossInferServerPath ?? ''}|${JSON.stringify(settings.engineDeviceOverrides ?? {})}`
}

export async function engineReadiness(): Promise<EngineReadiness> {
  const key = fingerprint()
  let base: ReadinessBase
  if (cache?.key === key && Date.now() - cache.createdAt < 30_000) {
    base = cache.value
  } else {
    base = calculateReadiness()
    cache = { key, createdAt: Date.now(), value: base }
  }
  return {
    ...base,
    installing: getEngineInstallProgress() ?? undefined,
    lastAttempt: readEngineLastAttempt(paths.mossinfer()) ?? undefined,
  }
}
