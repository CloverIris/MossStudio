import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

interface ExternalEngineEntry {
  path: string
  name: string
}

function serverName(): string {
  return process.platform === 'win32' ? 'moss-server.exe' : 'moss-server'
}

/** 用户只登记外部二进制，不修改用户选择的引擎目录。 */
function registryFile(): string {
  return join(paths.mossinfer(), 'external.json')
}

function readExternal(): ExternalEngineEntry[] {
  try {
    const raw = JSON.parse(readFileSync(registryFile(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.flatMap((item): ExternalEngineEntry[] => {
      if (!item || typeof item !== 'object' || typeof (item as { path?: unknown }).path !== 'string') return []
      const entry = item as Partial<ExternalEngineEntry> & { path: string }
      return [{
        path: entry.path,
        name: typeof entry.name === 'string' ? entry.name : basename(entry.path),
      }]
    })
  } catch {
    return []
  }
}

function writeExternal(items: ExternalEngineEntry[]): void {
  mkdirSync(paths.mossinfer(), { recursive: true })
  const temporary = `${registryFile()}.tmp`
  writeFileSync(temporary, JSON.stringify(items, null, 2), 'utf8')
  renameSync(temporary, registryFile())
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
  return mapEngineGpuProbe(inventory, hello.probe?.devices ?? [], enginePath, hello.version)
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

type TargetGpu = NonNullable<ReturnType<typeof resolveGpuSelection>>

async function probeVersionCompatibility(version: LocalEngineVersion, targetGpu: TargetGpu): Promise<void> {
  const hello = await probeEngine(version.path)
  if (!protocolCompatible(hello)) {
    throw new Error(`引擎协议不兼容（protocol ${hello.protocol}），需要 protocol 2（MossInfer ≥ 2.0）`)
  }
  const expectedArchitecture = /(?:^|-)sm75(?:-|$)/.test(version.id)
    ? 'sm75'
    : version.source === 'managed' ? 'standard' : undefined
  const verdict = judgeEngineSupport(
    hello,
    { index: targetGpu.index, name: targetGpu.name },
    { expectedArchitecture, inventoryCapability: targetGpu.computeCapability },
  )
  if (!verdict.ok) {
    throw new Error(`无法切换到此引擎：${targetGpu.name} 不兼容。${verdict.reason ?? ''}`.trim())
  }
}

async function activateLocalEngineVersion(version: LocalEngineVersion): Promise<void> {
  const updated = updateSettings({ inferenceBackend: 'mossinfer', mossInferServerPath: version.path })
  emit(Events.settingsChanged, updated)
  gpuProbeCache = null
  await shutdownMossInfer()
}

/** 沿用原有切换行为：有目标 GPU 时先检查兼容性。 */
export async function selectLocalEngineVersion(id: string): Promise<void> {
  const version = findLocalEngineVersion(id)
  const settings = getSettings()
  const inventory = await getGpuInventory()
  const targetGpu = resolveGpuSelection(inventory.devices, settings.gpuSelection)
  if (targetGpu) await probeVersionCompatibility(version, targetGpu)
  return activateLocalEngineVersion(version)
}

/** 外部目录登记只检查 protocol 2；切换时再检查目标 GPU。 */
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

export async function probeLocalEngine(): Promise<{
  hello: EngineHello
  gpuCompatibility: EngineGpuProbeSnapshot
}> {
  const { snapshot, hello } = await probeLocalEngineGpuCompatibility(true)
  return { hello, gpuCompatibility: snapshot }
}

export async function remoteEngineInfo(hostId: string, refreshCuda = false): Promise<RemoteEngineInfo> {
  const host = getTrainingHost(getSettings(), hostId)
  if (!host) throw new Error('主机不存在')
  if (host.kind !== 'ssh') throw new Error('不是 SSH 主机')
  return remoteEngineStatus(host, refreshCuda)
}
