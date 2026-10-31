import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { LocalEngineVersion } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { isInside, paths } from '../lib/paths'
import { probeMossInfer, resolveServerPath, shutdownMossInfer } from './mossInfer'
import { getSettings, updateSettings } from './settings'
import { getTrainingHost } from './trainingHosts'
import { remoteEngineStatus } from './remoteEngine'

export interface LocalEngineInfo {
  available: boolean
  path: string | null
  version?: string
  error?: string
}

export function localEngineInfo(): LocalEngineInfo {
  const path = resolveServerPath(getSettings())
  if (!path) return { available: false, path: null, error: '未找到 moss-server；请下载引擎或设置路径' }
  return { available: existsSync(path), path }
}

export function localEngineVersions(): LocalEngineVersion[] {
  const root = paths.mossinfer()
  if (!existsSync(root)) return []
  const currentPath = resolveServerPath(getSettings())
  const serverName = process.platform === 'win32' ? 'moss-server.exe' : 'moss-server'
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(root, entry.name)
      const serverPath = join(directory, 'bin', serverName)
      if (!existsSync(serverPath)) return null
      return {
        id: entry.name,
        name: entry.name,
        path: serverPath,
        current: currentPath ? resolve(currentPath) === resolve(serverPath) : false,
      }
    })
    .filter((version): version is LocalEngineVersion => version !== null)
    .sort((a, b) => b.name.localeCompare(a.name))
}

function findLocalEngineVersion(id: string): LocalEngineVersion {
  const version = localEngineVersions().find((item) => item.id === id)
  if (!version) throw new Error('引擎版本不存在或安装不完整')
  return version
}

export async function selectLocalEngineVersion(id: string): Promise<LocalEngineInfo> {
  const version = findLocalEngineVersion(id)
  const updated = updateSettings({ mossInferServerPath: version.path })
  emit(Events.settingsChanged, updated)
  await shutdownMossInfer()
  return localEngineInfo()
}

export function removeLocalEngineVersion(id: string): boolean {
  const version = findLocalEngineVersion(id)
  const activePath = resolveServerPath(getSettings())
  if (activePath && resolve(activePath) === resolve(version.path)) {
    throw new Error('当前使用的引擎版本不能删除，请先切换到其他版本')
  }
  const directory = resolve(paths.mossinfer(), basename(id))
  if (!isInside(paths.mossinfer(), directory) || directory === resolve(paths.mossinfer())) {
    throw new Error('引擎版本路径无效')
  }
  const info = statSync(directory)
  if (!info.isDirectory()) throw new Error('引擎版本目录不存在')
  rmSync(directory, { recursive: true, force: false })
  return true
}

export async function probeLocalEngine(): Promise<Record<string, unknown>> {
  const path = resolveServerPath(getSettings())
  if (!path || !existsSync(path)) throw new Error('未找到 moss-server')
  return probeMossInfer(path)
}

export async function remoteEngineInfo(hostId: string): Promise<{ available: boolean; path: string; error?: string }> {
  const host = getTrainingHost(getSettings(), hostId)
  if (!host) throw new Error('主机不存在')
  if (host.kind !== 'ssh') throw new Error('不是 SSH 主机')
  return remoteEngineStatus(host)
}
