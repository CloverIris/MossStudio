import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

function serverName(): string {
  return process.platform === 'win32' ? 'moss-server.exe' : 'moss-server'
}

/** External engines the user pointed at; registered by path, never copied. */
function registryFile(): string {
  return join(paths.mossinfer(), 'external.json')
}

function readExternal(): Array<{ path: string; name: string }> {
  try {
    const raw = JSON.parse(readFileSync(registryFile(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is { path: string; name: string } =>
      Boolean(item) && typeof (item as { path?: unknown }).path === 'string')
  } catch {
    return []
  }
}

function writeExternal(items: Array<{ path: string; name: string }>): void {
  mkdirSync(paths.mossinfer(), { recursive: true })
  writeFileSync(registryFile(), JSON.stringify(items, null, 2), 'utf8')
}

function binaryIn(directory: string): string | null {
  return [join(directory, 'bin', serverName()), join(directory, serverName())].find(existsSync) ?? null
}

function isCurrent(path: string): boolean {
  const currentPath = resolveServerPath(getSettings())
  return currentPath !== null && resolve(currentPath) === resolve(path)
}

export function localEngineInfo(): LocalEngineInfo {
  const path = resolveServerPath(getSettings())
  if (!path) return { available: false, path: null, error: '未找到 moss-server；请下载引擎或设置路径' }
  const version = localEngineVersions().find((item) => resolve(item.path) === resolve(path))?.name
  return version ? { available: existsSync(path), path, version } : { available: existsSync(path), path }
}

export function localEngineVersions(): LocalEngineVersion[] {
  const root = paths.mossinfer()
  const managed: LocalEngineVersion[] = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry): LocalEngineVersion | null => {
        const path = binaryIn(join(root, entry.name))
        if (!path) return null
        return { id: entry.name, name: entry.name, path, current: isCurrent(path), source: 'managed' }
      })
      .filter((item): item is LocalEngineVersion => item !== null)
    : []
  const external: LocalEngineVersion[] = readExternal()
    .filter((item) => existsSync(item.path))
    .map((item) => ({ id: `external:${item.path}`, name: `${item.name} · 外部`, path: item.path, current: isCurrent(item.path), source: 'external' as const }))
  return [...managed, ...external].sort((a, b) => b.name.localeCompare(a.name))
}

function findLocalEngineVersion(id: string): LocalEngineVersion {
  const version = localEngineVersions().find((item) => item.id === id)
  if (!version) throw new Error('引擎版本不存在或安装不完整')
  return version
}

/** Activation: make an already-known engine the one jobs use. */
export async function selectLocalEngineVersion(id: string): Promise<LocalEngineInfo> {
  const version = findLocalEngineVersion(id)
  const updated = updateSettings({ inferenceBackend: 'mossinfer', mossInferServerPath: version.path })
  emit(Events.settingsChanged, updated)
  await shutdownMossInfer()
  return localEngineInfo()
}

/**
 * Registration only: validate the directory and remember it as a candidate.
 * Activating it is a separate action (`selectLocalEngineVersion`).
 */
export async function selectLocalEngineDirectory(directory: string): Promise<LocalEngineVersion[]> {
  const root = resolve(directory)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error('所选路径不是有效的引擎目录')
  const serverPath = binaryIn(root)
  if (!serverPath) throw new Error(`所选目录中未找到 ${serverName()}；请选择解压后的引擎根目录或 bin 目录`)
  const hello = await probeMossInfer(serverPath)
  if (Number(hello['protocol_version']) !== 2) {
    throw new Error(`引擎协议不兼容（protocol ${String(hello['protocol_version'] ?? 'unknown')}），需要 protocol 2`)
  }
  const items = readExternal().filter((item) => resolve(item.path) !== resolve(serverPath))
  items.unshift({ path: serverPath, name: basename(root) })
  writeExternal(items)
  return localEngineVersions()
}

export function removeLocalEngineVersion(id: string): boolean {
  const version = findLocalEngineVersion(id)
  if (version.current) throw new Error('当前使用的引擎版本不能删除，请先切换到其他版本')
  if (version.source === 'external') {
    writeExternal(readExternal().filter((item) => resolve(item.path) !== resolve(version.path)))
    return true
  }
  const directory = resolve(paths.mossinfer(), basename(version.id))
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
