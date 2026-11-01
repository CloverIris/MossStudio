import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComputeDevice, ManagedHost, Settings, SshAuthMethod, TrainingHost } from '@shared/types'
import { paths } from '../lib/paths'
import { run } from '../lib/run'
import { listDevices } from './devices'
import { probeHost } from './ssh'
import { hasSshPassword, removeSshPassword, saveSshPassword } from './sshCredentials'
import { hasHfToken, saveHfToken } from './hfCredentials'
import { trustUnknownHost } from './sshHostKeys'

const FILE = () => join(paths.root(), 'hosts.json')
const LEGACY_FILE = () => join(paths.root(), 'training-hosts.json')
let remote: TrainingHost[] | null = null

function load(): TrainingHost[] {
  if (remote) return remote
  const file = existsSync(FILE()) ? FILE() : existsSync(LEGACY_FILE()) ? LEGACY_FILE() : null
  if (!file) {
    remote = []
    return remote
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as TrainingHost[]
    remote = Array.isArray(parsed) ? parsed : []
    // One-way migration: keep the legacy file untouched, write the global inventory.
    if (file === LEGACY_FILE()) persist()
  } catch {
    remote = []
  }
  return remote
}

function persist(): void {
  writeFileSync(FILE(), JSON.stringify(load(), null, 2), 'utf8')
}

export function listTrainingHosts(settings: Settings): TrainingHost[] {
  const local: TrainingHost = {
    id: 'local',
    name: '本机',
    kind: 'local',
    trainerRoot: paths.trainerRoot(settings.trainerRoot),
    instanceRoot: paths.instances(),
    modelsRoot: paths.models(settings.modelsRoot),
    status: 'unchecked',
  }
  return [local, ...load()]
}

export interface SaveTrainingHostInput {
  id?: string
  name: string
  host: string
  user: string
  port?: number
  authMethod?: SshAuthMethod
  identityFile?: string
  password?: string
  trainerRoot: string
  engineRoot?: string
  outputRoot?: string
  modelPath?: string
  instanceRoot?: string
  modelsRoot?: string
  downloadProxy?: string
  hfEndpoint?: string
  downloadConcurrency?: number | null
  hfToken?: string
  clearHfToken?: boolean
}

export function saveTrainingHost(input: SaveTrainingHostInput): TrainingHost {
  const hosts = load()
  const existing = input.id ? hosts.find((host) => host.id === input.id) : undefined
  const authMethod = input.authMethod ?? existing?.authMethod ?? 'identityFile'
  const id = existing?.id ?? `ssh-${randomUUID().slice(0, 8)}`
  if (authMethod === 'password') {
    if (input.password) saveSshPassword(id, input.password)
    else if (!hasSshPassword(id)) throw new Error('请输入 SSH 密码')
  } else {
    removeSshPassword(id)
  }
  if (input.clearHfToken) saveHfToken(id, null)
  else if (input.hfToken) saveHfToken(id, input.hfToken)
  const next: TrainingHost = {
    id,
    name: input.name.trim() || input.host,
    kind: 'ssh',
    host: input.host.trim(),
    user: input.user.trim(),
    port: input.port ?? 22,
    authMethod,
    identityFile: authMethod === 'identityFile' ? (input.identityFile ?? existing?.identityFile)?.trim() || undefined : undefined,
    hasPassword: authMethod === 'password',
    trainerRoot: input.trainerRoot.trim(),
    engineRoot: input.engineRoot?.trim() || existing?.engineRoot,
    outputRoot: input.outputRoot?.trim() || existing?.outputRoot,
    modelPath: input.modelPath?.trim() || existing?.modelPath,
    instanceRoot: input.instanceRoot?.trim() || existing?.instanceRoot,
    modelsRoot: input.modelsRoot?.trim() || undefined,
    downloadProxy: input.downloadProxy === undefined ? existing?.downloadProxy : input.downloadProxy.trim() || undefined,
    hfEndpoint: input.hfEndpoint === undefined ? existing?.hfEndpoint : input.hfEndpoint.trim() || undefined,
    downloadConcurrency: input.downloadConcurrency === undefined ? existing?.downloadConcurrency : input.downloadConcurrency ?? undefined,
    hasHfToken: hasHfToken(id),
    status: 'unchecked',
    lastCheckedAt: undefined,
  }
  if (existing) Object.assign(existing, next)
  else remote = [...hosts, next]
  persist()
  return next
}

export function getTrainingHost(settings: Settings, id: string): TrainingHost | undefined {
  return listTrainingHosts(settings).find((host) => host.id === id)
}

export async function testTrainingHost(settings: Settings, id: string): Promise<TrainingHost> {
  const host = getTrainingHost(settings, id)
  if (!host) throw new Error('训练主机不存在')
  if (host.kind === 'local') {
    const cuda = await run('nvidia-smi', ['-L'], { timeoutMs: 8000 })
    return {
      ...host,
      status: cuda.code === 0 ? 'ok' : 'error',
      lastCheckedAt: new Date().toISOString(),
      error: cuda.code === 0 ? undefined : '本机没有 NVIDIA CUDA；KohakuMossTrainer 不支持 MPS',
    }
  }
  try {
    let probe
    try {
      probe = await probeHost(host)
    } catch (error) {
      if (!(await trustUnknownHost(host, error))) throw error
      probe = await probeHost(host)
    }
    Object.assign(host, {
      status: 'ok',
      lastCheckedAt: new Date().toISOString(),
      error: undefined,
      remote: {
        os: probe.os,
        gpu: probe.gpu,
        git: probe.git,
        uv: probe.uv,
        python: probe.python,
        rootReady: probe.rootReady,
      },
    })
  } catch (error) {
    Object.assign(host, {
      status: 'error',
      lastCheckedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message.slice(0, 2000) : String(error),
    })
  }
  persist()
  return { ...host }
}

export function updateTrainingHostVersions(settings: Settings, id: string, versions: TrainingHost['versions']): void {
  const hosts = load()
  const host = hosts.find((item) => item.id === id)
  if (!host) return
  host.versions = versions
  persist()
}

export interface TrainingHostPathsPatch {
  engineRoot?: string
  outputRoot?: string
  modelsRoot?: string
  modelPath?: string
}

export function updateTrainingHostPaths(id: string, patch: TrainingHostPathsPatch): void {
  const host = load().find((item) => item.id === id)
  if (!host) throw new Error('主机不存在')
  if (patch.engineRoot !== undefined) host.engineRoot = patch.engineRoot.trim() || undefined
  if (patch.outputRoot !== undefined) host.outputRoot = patch.outputRoot.trim() || undefined
  if (patch.modelsRoot !== undefined) host.modelsRoot = patch.modelsRoot.trim() || undefined
  if (patch.modelPath !== undefined) host.modelPath = patch.modelPath.trim() || undefined
  persist()
}

export function updateTrainingHostModelPath(id: string, modelPath: string): void {
  const host = load().find((item) => item.id === id)
  if (!host) throw new Error('主机不存在')
  host.modelPath = modelPath
  persist()
}

export function removeTrainingHost(id: string): void {
  removeSshPassword(id)
  saveHfToken(id, null)
  remote = load().filter((host) => host.id !== id)
  persist()
}

function parseRemoteDevices(host: TrainingHost): ComputeDevice[] {
  if (host.kind !== 'ssh' || host.status !== 'ok' || !host.remote?.gpu) return []
  return host.remote.gpu
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [name = 'GPU', memory = ''] = line.split(',').map((part) => part.trim())
      const mb = Number.parseInt(memory, 10)
      const memoryBytes = Number.isFinite(mb) ? mb * 1024 * 1024 : undefined
      return {
        id: `${host.id}:cuda:${index}`,
        hostId: host.id,
        hostName: host.name,
        name: name || `GPU ${index}`,
        kind: 'cuda' as const,
        detail: `CUDA · ${memoryBytes ? `${Math.round(memoryBytes / 1024 ** 3)} GB` : '显存未知'}`,
        memoryBytes,
        available: true,
        source: 'remote' as const,
      }
    })
}

function localManagedDevices(settings: Settings): ComputeDevice[] {
  const devices = listDevices(settings)
  const mpsName = devices.find((device) => device.kind === 'mps')?.name
  return devices.map((device) => ({
    ...device,
    name: device.kind === 'cpu' && mpsName === device.name ? `${device.name} · CPU` : device.name,
    hostId: 'local',
    hostName: '本机',
    source: 'local' as const,
  }))
}

function managedHost(settings: Settings, host: TrainingHost): ManagedHost {
  const devices = host.kind === 'local' ? localManagedDevices(settings) : parseRemoteDevices(host)
  return {
    ...host,
    status: host.kind === 'local' ? 'ok' : host.status,
    devices,
  }
}

/** Hosts plus their current device inventory; the single source for the device manager. */
export function listManagedHosts(settings: Settings): ManagedHost[] {
  return listTrainingHosts(settings).map((host) => managedHost(settings, host))
}

export async function testManagedHost(settings: Settings, id: string): Promise<ManagedHost> {
  const existing = getTrainingHost(settings, id)
  if (existing?.kind === 'local') {
    // Local host availability is not the trainer's CUDA check; MPS/CPU are valid
    // devices for the launcher even when Kohaku training cannot use them.
    return managedHost(settings, {
      ...existing,
      status: 'ok',
      lastCheckedAt: new Date().toISOString(),
      error: undefined,
    })
  }
  const host = await testTrainingHost(settings, id)
  return managedHost(settings, host)
}
