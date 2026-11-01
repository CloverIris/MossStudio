import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type {
  EngineGpuProbeSnapshot,
  LocalEngineVersion,
  RemoteEngineInfo,
} from '@shared/types'
import { mapEngineGpuProbe } from '@shared/gpuCompatibility'
import {
  judgeEngineSupport,
  protocolCompatible,
  type EngineHello,
} from '@shared/engineProtocol'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { isInside, paths } from '../lib/paths'
import { probeEngine } from '../lib/probeEngine'
import { isManagedEngineDirectory } from '../lib/engineStore'
import { resolveServerPath, shutdownMossInfer } from './mossInfer'
import { getSettings, updateSettings } from './settings'
import { getGpuInventory } from './devices'
import { resolveGpuSelection } from '../lib/gpuInventory'
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

let gpuProbeCache: { fingerprint: string; createdAt: number; snapshot: EngineGpuProbeSnapshot; hello: EngineHello } | null = null
let gpuProbePending: { fingerprint: string; promise: Promise<EngineHello> } | null = null

function mapGpuProbe(
  inventory: Awaited<ReturnType<typeof getGpuInventory>>['devices'],
  hello: EngineHello,
  enginePath: string,
): EngineGpuProbeSnapshot {
  return mapEngineGpuProbe(
    inventory,
    hello.probe?.devices ?? [],
    enginePath,
    hello.version,
  )
}

export async function probeLocalEngineGpuCompatibility(
  force = false,
): Promise<{ snapshot: EngineGpuProbeSnapshot; hello: EngineHello }> {
  const path = resolveServerPath(getSettings())
  if (!path || !existsSync(path)) throw new Error('未找到 moss-server')
  const fingerprint = `${resolve(path)}:${statSync(path).mtimeMs}`
  if (!force && gpuProbeCache?.fingerprint === fingerprint && Date.now() - gpuProbeCache.createdAt < 30_000) {
    const inventory = await getGpuInventory()
    const snapshot = mapGpuProbe(inventory.devices, gpuProbeCache.hello, path)
    gpuProbeCache.snapshot = snapshot
    return { snapshot, hello: gpuProbeCache.hello }
  }
  let hello: EngineHello
  if (gpuProbePending?.fingerprint === fingerprint) {
    hello = await gpuProbePending.promise
  } else {
    const pending = { fingerprint, promise: probeEngine(path) }
    gpuProbePending = pending
    try {
      hello = await pending.promise
    } finally {
      if (gpuProbePending === pending) gpuProbePending = null
    }
  }
  const inventory = await getGpuInventory()
  const snapshot = mapGpuProbe(inventory.devices, hello, path)
  gpuProbeCache = { fingerprint, createdAt: Date.now(), snapshot, hello }
  return { snapshot, hello }
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
      .filter((entry) => entry.isDirectory() && isManagedEngineDirectory(entry.name))
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
  const settings = getSettings()
  const inventory = await getGpuInventory()
  const targetGpu = resolveGpuSelection(inventory.devices, settings.gpuSelection)
  if (targetGpu) {
    const hello = await probeEngine(version.path)
    if (!protocolCompatible(hello)) {
      throw new Error(
        `无法切换到此引擎：协议不兼容（protocol ${hello.protocol}），需要 protocol 2（MossInfer ≥ 2.0）`,
      )
    }
    // 安装后校验与切换共用同一判定，失败构建不能稍后被激活。
    const verdict = judgeEngineSupport(
      hello,
      { index: targetGpu.index, name: targetGpu.name },
      {
        expectedArchitecture: /(?:^|-)sm75(?:-|$)/.test(version.id) ? 'sm75' : 'standard',
        inventoryCapability: targetGpu.computeCapability,
      },
    )
    if (!verdict.ok) {
      throw new Error(
        `无法切换到此引擎：${targetGpu.name} 未通过兼容性校验。${verdict.reason ?? ''}`.trim(),
      )
    }
  }
  const updated = updateSettings({ inferenceBackend: 'mossinfer', mossInferServerPath: version.path })
  emit(Events.settingsChanged, updated)
  gpuProbeCache = null
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
  const hello = await probeEngine(serverPath)
  if (!protocolCompatible(hello)) {
    throw new Error(`引擎协议不兼容（protocol ${hello.protocol}），需要 protocol 2`)
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
  const { snapshot, hello } = await probeLocalEngineGpuCompatibility(true)
  return { ...hello.raw, gpuCompatibility: snapshot }
}

export async function remoteEngineInfo(hostId: string, refreshCuda = false): Promise<RemoteEngineInfo> {
  const host = getTrainingHost(getSettings(), hostId)
  if (!host) throw new Error('主机不存在')
  if (host.kind !== 'ssh') throw new Error('不是 SSH 主机')
  return remoteEngineStatus(host, refreshCuda)
}
