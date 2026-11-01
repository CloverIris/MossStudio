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
import {
  isManagedEngineDirectory,
  readEngineManifest,
  writeEngineManifest,
  type EngineManifest,
} from '../lib/engineStore'
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

interface ExternalEngineEntry {
  path: string
  name: string
  manifest?: EngineManifest
}

function serverName(): string {
  return process.platform === 'win32' ? 'moss-server.exe' : 'moss-server'
}

/** 用户只登记外部二进制；验证信息保存在应用自己的 registry 中。 */
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
        manifest: entry.manifest,
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

export function localEngineInfo(): LocalEngineInfo {
  const path = resolveServerPath(getSettings())
  if (!path) return { available: false, path: null, error: '未找到 moss-server；请下载引擎或设置路径' }
  const version = localEngineVersions().find((item) => resolve(item.path) === resolve(path))?.name
  return version ? { available: existsSync(path), path, version } : { available: existsSync(path), path }
}

function withVerification(
  base: Omit<LocalEngineVersion, 'verified'>,
  manifest: EngineManifest | null,
  unverifiedReason: string,
): LocalEngineVersion {
  return {
    ...base,
    verified: manifest !== null,
    verifiedAt: manifest?.verifiedAt,
    engineVersion: manifest?.engineVersion,
    protocol: manifest?.protocol,
    capability: manifest ? manifest.device?.compute ?? null : undefined,
    flavour: manifest?.flavour,
    variant: manifest?.variant,
    architecture: manifest?.architecture,
    unverifiedReason: manifest ? undefined : unverifiedReason,
  }
}

export function localEngineVersions(): LocalEngineVersion[] {
  const root = paths.mossinfer()
  const managed: LocalEngineVersion[] = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isManagedEngineDirectory(entry.name))
      .map((entry): LocalEngineVersion | null => {
        const installDir = join(root, entry.name)
        const path = binaryIn(installDir)
        if (!path) return null
        return withVerification(
          { id: entry.name, name: entry.name, path, current: isCurrent(path), source: 'managed' },
          readEngineManifest(installDir),
          '旧安装目录没有验证记录；请验证后再切换',
        )
      })
      .filter((item): item is LocalEngineVersion => item !== null)
    : []
  const external: LocalEngineVersion[] = readExternal()
    .filter((item) => existsSync(item.path))
    .map((item) => withVerification(
      { id: `external:${item.path}`, name: `${item.name} · 外部`, path: item.path, current: isCurrent(item.path), source: 'external' as const },
      item.manifest ?? null,
      '外部引擎尚未验证；请验证后再切换',
    ))
  return [...managed, ...external].sort((a, b) => b.name.localeCompare(a.name))
}

function findLocalEngineVersion(id: string): LocalEngineVersion {
  const version = localEngineVersions().find((item) => item.id === id)
  if (!version) throw new Error('引擎版本不存在或安装不完整')
  return version
}

export function manifestForLocalEngineVersion(version: LocalEngineVersion): EngineManifest | null {
  if (version.source === 'managed') return readEngineManifest(join(paths.mossinfer(), basename(version.id)))
  return readExternal().find((item) => resolve(item.path) === resolve(version.path))?.manifest ?? null
}

async function verifyProbe(version: LocalEngineVersion): Promise<EngineManifest> {
  const settings = getSettings()
  const inventory = await getGpuInventory()
  const targetGpu = resolveGpuSelection(inventory.devices, settings.gpuSelection)
  if (!targetGpu) throw new Error('没有可用于验证引擎的 NVIDIA GPU；请先检查设备或 GPU 选择')
  const hello = await probeEngine(version.path)
  if (!protocolCompatible(hello)) {
    throw new Error(`引擎协议不兼容（protocol ${hello.protocol}），需要 protocol 2（MossInfer ≥ 2.0）`)
  }
  const expectedArchitecture = version.architecture ??
    (/(?:^|-)sm75(?:-|$)/.test(version.id) ? 'sm75' : version.source === 'managed' ? 'standard' : undefined)
  const verdict = judgeEngineSupport(
    hello,
    { index: targetGpu.index, name: targetGpu.name },
    { expectedArchitecture, inventoryCapability: targetGpu.computeCapability },
  )
  if (!verdict.ok) {
    throw new Error(`无法验证此引擎：${targetGpu.name} 未通过兼容性校验。${verdict.reason ?? ''}`.trim())
  }
  const buildFlavour = hello.probe?.buildFlavour
  return {
    schemaVersion: 1,
    stamp: version.id,
    engineVersion: hello.version,
    protocol: hello.protocol,
    verifiedAt: new Date().toISOString(),
    architecture: expectedArchitecture,
    flavour: buildFlavour === 'cu12' || buildFlavour === 'cu13' ? buildFlavour : undefined,
    variant: version.variant,
    device: verdict.device,
    devices: hello.probe?.devices ?? [],
    cublasLt: hello.probe?.cublasLt,
  }
}

async function activateLocalEngineVersion(version: LocalEngineVersion): Promise<LocalEngineInfo> {
  const updated = updateSettings({ inferenceBackend: 'mossinfer', mossInferServerPath: version.path })
  emit(Events.settingsChanged, updated)
  gpuProbeCache = null
  await shutdownMossInfer()
  return localEngineInfo()
}

async function persistVerification(version: LocalEngineVersion, manifest: EngineManifest): Promise<void> {
  if (version.source === 'managed') {
    await writeEngineManifest(join(paths.mossinfer(), basename(version.id)), manifest)
  } else {
    writeExternal(readExternal().map((item) =>
      resolve(item.path) === resolve(version.path) ? { ...item, manifest } : item,
    ))
  }
  gpuProbeCache = null
}

/** 已验证版本在切换前仍会确认当前 GPU；未验证版本必须走验证并切换。 */
export async function selectLocalEngineVersion(id: string): Promise<LocalEngineInfo> {
  const version = findLocalEngineVersion(id)
  if (!version.verified) throw new Error('此引擎尚未验证，请使用「验证并切换」')
  const manifest = await verifyProbe(version)
  await persistVerification(version, manifest)
  return activateLocalEngineVersion(version)
}

export async function verifyLocalEngineVersion(id: string): Promise<LocalEngineInfo> {
  const version = findLocalEngineVersion(id)
  const manifest = await verifyProbe(version)
  await persistVerification(version, manifest)
  return activateLocalEngineVersion(version)
}

/** 外部目录登记只验证协议；GPU 验证与激活由「验证并切换」完成。 */
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
