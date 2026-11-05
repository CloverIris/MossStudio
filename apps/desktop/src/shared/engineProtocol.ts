import type { EngineFeatures } from './types'

export const ENGINE_PROTOCOL_VERSION = 2

export interface EngineComputeCapability {
  major: number
  minor: number
}

export interface EngineDevice {
  index: number | null
  name: string
  supported: boolean | null
  unsupportedReason?: string
  compute: EngineComputeCapability | null
  pciBusId?: string
  totalMemoryBytes?: number
  freeMemoryBytes?: number
  raw: Record<string, unknown>
}

export interface EngineCublasLt {
  source?: string
  version?: number
  path?: string
  error?: string
}

export interface EngineProbe {
  driverCudaVersion?: number
  runtimeCudaVersion?: number
  driverCompatible?: boolean
  deviceCount?: number
  supportedDeviceCount?: number
  buildFlavour?: string
  recommendedFlavour?: string
  message?: string
  cublasLt?: EngineCublasLt
  devices: EngineDevice[]
}

export interface EngineHello {
  protocol: number
  server?: string
  version?: string
  abiVersion?: number
  capabilities: Record<string, boolean | undefined>
  /** Accepted names per enum parameter (hello's `values`, 2.2+); empty with older engines. */
  values: Record<string, string[]>
  probe?: EngineProbe
  raw: Record<string, unknown>
}

export interface EngineSupportVerdict {
  ok: boolean
  reason?: string
  device?: EngineDevice
  warnings: string[]
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

/** 同时兼容新构建的 compute_capability 字符串和旧构建的 major/minor 分字段。 */
export function readEngineCompute(source: unknown): EngineComputeCapability | null {
  if (!isRecord(source)) return null
  if ('compute' in source) {
    const compute = source.compute
    if (isRecord(compute)) {
      const major = optionalNumber(compute.major)
      const minor = optionalNumber(compute.minor)
      return major === undefined || minor === undefined ? null : { major, minor }
    }
  }
  const major = optionalNumber(source.compute_major)
  if (major !== undefined && major > 0) {
    return { major: Math.trunc(major), minor: Math.trunc(optionalNumber(source.compute_minor) ?? 0) }
  }
  const raw = source.compute_capability
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { major: Math.trunc(raw), minor: 0 }
  }
  if (typeof raw !== 'string') return null
  const match = raw.trim().match(/^(\d+)(?:\.(\d+))?$/)
  if (!match) return null
  const parsedMajor = Number(match[1])
  const parsedMinor = match[2] === undefined ? 0 : Number(match[2])
  return parsedMajor > 0 ? { major: parsedMajor, minor: parsedMinor } : null
}

function decodeDevice(raw: unknown, index: number): EngineDevice {
  if (!isRecord(raw)) throw new Error(`hello.probe.devices[${index}] 必须是对象`)
  return {
    index: optionalNumber(raw.index) ?? null,
    name: optionalString(raw.name) ?? '',
    supported: typeof raw.supported === 'boolean' ? raw.supported : null,
    unsupportedReason: optionalString(raw.unsupported_reason ?? raw.unsupportedReason),
    compute: readEngineCompute(raw),
    pciBusId: optionalString(raw.pci_bus_id ?? raw.pciBusId),
    totalMemoryBytes: optionalNumber(raw.total_memory_bytes ?? raw.totalMemoryBytes),
    freeMemoryBytes: optionalNumber(raw.free_memory_bytes ?? raw.freeMemoryBytes),
    raw,
  }
}

function decodeCublasLt(raw: unknown): EngineCublasLt | undefined {
  if (!isRecord(raw)) return undefined
  return {
    source: optionalString(raw.source),
    version: optionalNumber(raw.version),
    path: optionalString(raw.path),
    error: optionalString(raw.error),
  }
}

/** moss-server 的不可信 JSON 只能经此函数进入主进程和渲染层。 */
export function decodeEngineHello(raw: unknown): EngineHello {
  if (!isRecord(raw)) throw new Error('引擎 hello 必须是 JSON 对象')
  const protocol = optionalNumber(raw.protocol_version ?? raw.protocol)
  if (protocol === undefined) throw new Error('引擎 hello 缺少有效的 protocol_version')

  const capabilities: Record<string, boolean | undefined> = {}
  if (isRecord(raw.capabilities)) {
    for (const [key, value] of Object.entries(raw.capabilities)) {
      if (typeof value === 'boolean') capabilities[key] = value
    }
  }

  const values: Record<string, string[]> = {}
  if (isRecord(raw.values)) {
    for (const [key, list] of Object.entries(raw.values)) {
      if (Array.isArray(list)) values[key] = list.filter((item): item is string => typeof item === 'string')
    }
  }

  let probe: EngineProbe | undefined
  if (raw.probe !== undefined && raw.probe !== null) {
    if (!isRecord(raw.probe)) throw new Error('引擎 hello.probe 必须是对象')
    const rawDevices = raw.probe.devices
    if (rawDevices !== undefined && !Array.isArray(rawDevices)) {
      throw new Error('引擎 hello.probe.devices 必须是数组')
    }
    probe = {
      driverCudaVersion: optionalNumber(raw.probe.driver_cuda_version ?? raw.probe.driverCudaVersion),
      runtimeCudaVersion: optionalNumber(raw.probe.runtime_cuda_version ?? raw.probe.runtimeCudaVersion),
      driverCompatible: typeof raw.probe.driver_compatible === 'boolean' ? raw.probe.driver_compatible : undefined,
      deviceCount: optionalNumber(raw.probe.device_count ?? raw.probe.deviceCount),
      supportedDeviceCount: optionalNumber(raw.probe.supported_device_count ?? raw.probe.supportedDeviceCount),
      buildFlavour: optionalString(raw.probe.build_flavour ?? raw.probe.buildFlavour),
      recommendedFlavour: optionalString(raw.probe.recommended_flavour ?? raw.probe.recommendedFlavour),
      message: optionalString(raw.probe.message),
      cublasLt: decodeCublasLt(raw.probe.cublaslt ?? raw.probe.cublasLt),
      devices: (rawDevices ?? []).map(decodeDevice),
    }
  }

  return {
    protocol,
    server: optionalString(raw.server),
    version: optionalString(raw.version),
    abiVersion: optionalNumber(raw.abi_version ?? raw.abiVersion),
    capabilities,
    values,
    probe,
    raw,
  }
}

/**
 * What a job may ask of this engine. A capability the hello does not name
 * (an engine older than 2.2) counts as unsupported.
 */
export function engineFeaturesOf(hello: EngineHello): EngineFeatures {
  const on = (key: string): boolean => hello.capabilities[key] === true
  const values: Record<string, string[]> = {}
  for (const [key, list] of Object.entries(hello.values)) values[key] = [...list]
  return {
    preview: on('preview'),
    imageInput: on('image_input'),
    control: on('control'),
    references: on('references'),
    hires: on('hires'),
    samplers: on('samplers'),
    // Every moss-server since protocol 2 loads LoRAs; only an explicit `false` says otherwise.
    lora: hello.capabilities['lora'] !== false,
    values,
  }
}

export function protocolCompatible(hello: EngineHello): boolean {
  return hello.protocol === ENGINE_PROTOCOL_VERSION
}

export function matchEngineDevice(
  candidates: EngineDevice[],
  gpu: { index?: number; name?: string },
  options: { indexOnly?: boolean } = {},
): EngineDevice | undefined {
  if (options.indexOnly) {
    const byIndex = candidates.filter((candidate) => candidate.index === gpu.index)
    return gpu.index !== undefined && byIndex.length === 1 ? byIndex[0] : undefined
  }
  const byIndex = candidates.filter((candidate) =>
    gpu.index !== undefined &&
    candidate.index === gpu.index &&
    (!candidate.name || !gpu.name || normalizedName(candidate.name) === normalizedName(gpu.name)),
  )
  if (byIndex.length === 1) return byIndex[0]
  const byName = candidates.filter((candidate) =>
    candidate.name && gpu.name && normalizedName(candidate.name) === normalizedName(gpu.name),
  )
  return byName.length === 1 ? byName[0] : undefined
}

/** supported 是唯一兼容性权威；算力与架构差异只形成警告。 */
export function judgeEngineSupport(
  hello: EngineHello,
  gpu: { index?: number; name?: string },
  options: {
    indexOnly?: boolean
    expectedArchitecture?: 'standard' | 'sm75' | 'sm70'
    inventoryCapability?: { major: number; minor: number } | null
  } = {},
): EngineSupportVerdict {
  const warnings: string[] = []
  if (!protocolCompatible(hello)) {
    return { ok: false, reason: `引擎协议为 ${hello.protocol}，需要 protocol ${ENGINE_PROTOCOL_VERSION}`, warnings }
  }
  if (!hello.probe) return { ok: false, reason: '引擎 hello 缺少 probe，未给出兼容性结论', warnings }
  const device = matchEngineDevice(hello.probe.devices, gpu, { indexOnly: options.indexOnly })
  const label = gpu.name?.trim() || '当前 GPU'
  if (!device) {
    return { ok: false, reason: `引擎没有返回 ${label} 的可匹配设备，未给出兼容性结论`, warnings }
  }
  if (device.supported === false) {
    return { ok: false, reason: device.unsupportedReason || `引擎判定 ${label} 不受此构建支持`, device, warnings }
  }
  if (device.supported !== true) {
    return { ok: false, reason: `引擎未给出 ${label} 的兼容性结论（缺少 supported）`, device, warnings }
  }

  const capability = device.compute
  if (capability && options.inventoryCapability &&
      (capability.major !== options.inventoryCapability.major || capability.minor !== options.inventoryCapability.minor)) {
    warnings.push(
      `系统算力为 ${options.inventoryCapability.major}.${options.inventoryCapability.minor}，引擎报告为 ${capability.major}.${capability.minor}；以引擎 supported 结论为准`,
    )
  }
  if (capability && options.expectedArchitecture === 'sm75' && (capability.major !== 7 || capability.minor !== 5)) {
    warnings.push(`SM75 构建报告 ${label} 算力为 ${capability.major}.${capability.minor}；以引擎 supported 结论为准`)
  }
  if (capability && options.expectedArchitecture === 'sm70' && capability.major < 7) {
    warnings.push(`SM70 构建报告 ${label} 算力为 ${capability.major}.${capability.minor}；以引擎 supported 结论为准`)
  }
  if (capability && options.expectedArchitecture === 'standard' && capability.major < 8) {
    warnings.push(`标准构建报告 ${label} 算力为 ${capability.major}.${capability.minor}；以引擎 supported 结论为准`)
  }
  return { ok: true, device, warnings }
}
