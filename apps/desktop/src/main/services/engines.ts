import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { EngineGpuProbeSnapshot, LocalEngineVersion, RemoteEngineInfo } from '@shared/types'
import { mapEngineGpuProbe } from '@shared/gpuCompatibility'
import { judgeEngineSupport, protocolCompatible, type EngineHello } from '@shared/engineProtocol'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { isInside, paths } from '../lib/paths'
import { probeEngine } from '../lib/probeEngine'
import { engineBinaryPath, isManagedEngineDirectory } from '../lib/engineStore'
import { parseEngineStamp } from '@shared/engineUpdate'
import { deviceEngines, localServerPath } from './engineInstalls'
import { shutdownCliEngines } from './cliEngine'
import { isCliEngine } from '@shared/enginePackages'
import { releaseStaleMossInferRuntimes, resolveServerPath, shutdownMossInfer } from './mossInfer'
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
      return [
        {
          path: entry.path,
          name: typeof entry.name === 'string' ? entry.name : basename(entry.path),
        },
      ]
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

/** A managed folder holds one package: moss-server, moss-infer-vulkan or moss-infer-hip. */
function managedBinaryIn(directory: string, name: string): string | null {
  const stamp = parseEngineStamp(name)
  if (stamp && stamp.package.kind !== 'cuda') {
    const path = engineBinaryPath(directory, stamp.package.kind)
    return existsSync(path) ? path : null
  }
  return binaryIn(directory)
}

/** Binaries some GPU runs right now (each GPU's package, a pinned moss-server). */
function pathsInUse(): Set<string> {
  const used = new Set(deviceEngines().flatMap(({ engine }) => (engine ? [resolve(engine.binaryPath)] : [])))
  if (used.size === 0) {
    const legacy = resolveServerPath(getSettings())
    if (legacy) used.add(resolve(legacy))
  }
  return used
}

/** One probe per moss-server binary (several GPUs can run different CUDA packages). */
const helloCache = new Map<string, { fingerprint: string; createdAt: number; hello: EngineHello }>()
const helloPending = new Map<string, { fingerprint: string; promise: Promise<EngineHello> }>()

async function helloOf(path: string, force: boolean): Promise<EngineHello> {
  const key = resolve(path)
  const fingerprint = `${key}:${statSync(path).mtimeMs}`
  const cached = helloCache.get(key)
  if (!force && cached?.fingerprint === fingerprint && Date.now() - cached.createdAt < 30_000) return cached.hello
  const pending = helloPending.get(key)
  if (pending?.fingerprint === fingerprint) return pending.promise
  const entry = { fingerprint, promise: probeEngine(path) }
  helloPending.set(key, entry)
  try {
    const hello = await entry.promise
    helloCache.set(key, { fingerprint, createdAt: Date.now(), hello })
    return hello
  } finally {
    if (helloPending.get(key) === entry) helloPending.delete(key)
  }
}

export interface LocalGpuProbe {
  /** Every inventory GPU judged by the moss-server it runs. */
  snapshot: EngineGpuProbeSnapshot
  /** The default GPU's (or first) moss-server hello, for the 测试 row. */
  hello: EngineHello
  /** The hello of the moss-server this GPU runs; null for a GPU on a CLI engine or with none. */
  helloFor: (deviceUuid: string) => EngineHello | null
}

/**
 * Probes each moss-server some NVIDIA GPU runs (its own package via
 * resolveDeviceEngine) and judges every GPU against its own binary, so a
 * 4090 on cu13 and a Titan V on cu12-sm70 each get the right verdict.
 */
export async function probeLocalEngineGpuCompatibility(force = false): Promise<LocalGpuProbe> {
  const inventory = (await getGpuInventory()).devices
  const pathFor = new Map<string, string>()
  for (const device of inventory) {
    const path = localServerPath(device.uuid)
    if (path && existsSync(path)) pathFor.set(device.uuid, resolve(path))
  }
  const fallback = localServerPath()
  const binaries = [
    ...new Set([...pathFor.values(), ...(pathFor.size === 0 && fallback && existsSync(fallback) ? [resolve(fallback)] : [])]),
  ]
  if (binaries.length === 0) throw new Error('未找到 moss-server')
  const hellos = new Map<string, EngineHello>()
  for (const path of binaries) hellos.set(path, await helloOf(path, force))
  const checkedAt = new Date().toISOString()
  const devices = inventory.flatMap((device) => {
    const path = pathFor.get(device.uuid) ?? (pathFor.size === 0 ? binaries[0]! : undefined)
    const hello = path ? hellos.get(path) : undefined
    if (!hello || !path) return []
    return mapEngineGpuProbe(inventory, hello.probe?.devices ?? [], path, hello.version, checkedAt).devices.filter(
      (item) => item.uuid === device.uuid,
    )
  })
  const selection = getSettings().gpuSelection
  const preferred = typeof selection === 'object' ? pathFor.get(selection.uuid) : undefined
  const mainPath = preferred ?? binaries[0]!
  const main = hellos.get(mainPath)!
  return {
    snapshot: { enginePath: mainPath, engineVersion: main.version, checkedAt, devices },
    hello: main,
    helloFor: (deviceUuid) => {
      const path = pathFor.get(deviceUuid) ?? (pathFor.size === 0 ? binaries[0] : undefined)
      return path ? (hellos.get(path) ?? null) : null
    },
  }
}

export function localEngineVersions(): LocalEngineVersion[] {
  const inUse = pathsInUse()
  const isCurrent = (path: string): boolean => inUse.has(resolve(path))
  const root = paths.mossinfer()
  const managed: LocalEngineVersion[] = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isManagedEngineDirectory(entry.name))
        .map((entry): LocalEngineVersion | null => {
          const path = managedBinaryIn(join(root, entry.name), entry.name)
          if (!path) return null
          return { id: entry.name, name: entry.name, path, current: isCurrent(path), source: 'managed' }
        })
        .filter((item): item is LocalEngineVersion => item !== null)
    : []
  const external: LocalEngineVersion[] = readExternal()
    .filter((item) => existsSync(item.path))
    .map((item) => ({
      id: `external:${item.path}`,
      name: `${item.name} · 外部`,
      path: item.path,
      current: isCurrent(item.path),
      source: 'external' as const,
    }))
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
  const stamp = version.source === 'managed' ? parseEngineStamp(version.name) : null
  const expectedArchitecture = stamp?.package.kind === 'cuda' ? stamp.package.arch : undefined
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
  helloCache.clear()
  await shutdownMossInfer()
  await releaseStaleMossInferRuntimes()
}

/** 沿用原有切换行为：有目标 GPU 时先检查兼容性。 */
export async function selectLocalEngineVersion(id: string): Promise<void> {
  const version = findLocalEngineVersion(id)
  const stamp = version.source === 'managed' ? parseEngineStamp(version.name) : null
  if (stamp && stamp.package.kind !== 'cuda') {
    throw new Error('兼容模式和 AMD 原生引擎总是使用最新安装的版本；要换用它，请在 高级 › 每块 GPU 的引擎 里选择')
  }
  const settings = getSettings()
  const inventory = await getGpuInventory()
  const selected = resolveGpuSelection(inventory.devices, settings.gpuSelection)
  const targetGpu =
    selected && (selected.vendor ?? 'nvidia') === 'nvidia'
      ? selected
      : (inventory.devices.find((device) => (device.vendor ?? 'nvidia') === 'nvidia') ?? null)
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

export async function removeLocalEngineVersion(id: string): Promise<boolean> {
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
  // A Vulkan / HIP job may still run this binary (one process per job): stop them before deleting it.
  const stamp = parseEngineStamp(version.name)
  if (stamp && isCliEngine(stamp.package)) await shutdownCliEngines({ kind: stamp.package.kind as 'vulkan' | 'hip', binary: directory })
  rmSync(directory, { recursive: true, force: false })
  void releaseStaleMossInferRuntimes().catch(() => undefined)
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
