import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EngineReadiness } from '@shared/types'
import {
  getEngineInstallProgress,
  readEngineLastAttempt,
} from '../lib/engineStore'
import { paths } from '../lib/paths'
import { resolveServerPath } from './mossInfer'
import { getSettings } from './settings'

type ReadinessBase = Omit<EngineReadiness, 'installing' | 'lastAttempt'>

let cache: { key: string; createdAt: number; value: ReadinessBase } | null = null

export function invalidateEngineReadiness(): void {
  cache = null
}

function calculateReadiness(): ReadinessBase {
  const path = resolveServerPath(getSettings())
  if (!path || !existsSync(path)) {
    return { state: 'missing', path: null, reason: '未找到 moss-server；请下载引擎或设置路径' }
  }
  return { state: 'ready', path }
}

export async function engineReadiness(): Promise<EngineReadiness> {
  const path = resolveServerPath(getSettings())
  const fingerprint = path && existsSync(path) ? `${resolve(path)}:${statSync(path).mtimeMs}` : 'missing'
  let base: ReadinessBase
  if (cache?.key === fingerprint && Date.now() - cache.createdAt < 30_000) {
    base = cache.value
  } else {
    base = calculateReadiness()
    cache = { key: fingerprint, createdAt: Date.now(), value: base }
  }
  return {
    ...base,
    installing: getEngineInstallProgress() ?? undefined,
    lastAttempt: readEngineLastAttempt(paths.mossinfer()) ?? undefined,
  }
}
