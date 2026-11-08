import { describe, expect, it } from 'vitest'
import {
  applyGpuOverride,
  defaultGpuUuid,
  gpuEmptyMessage,
  gpuRows,
  hostSummary,
  remoteInstallOptions,
  savedGpuMissing,
  applyEngineOverride,
  engineInUseLabel,
  engineOverrideOptions,
  fixedEngineSettingsNote,
  gpuEngineInfo,
  gpuPickerLabel,
} from '@renderer/pages/settings/devicesModel'
import { RELEASE_220, enginePlanFor, inventoryDevicesFor, machineFixture } from '@test/mocks/backend/machines'
import { planLines } from '@renderer/lib/engineInstall'
import type { EngineGpuProbeSnapshot, LocalEngineVersion, RemoteEngineInfo } from '@shared/types'
import {
  FIXTURE_NOW,
  GPU_RTX_3060,
  engineMissingFixture,
  engineReadyFixture,
  gpuDeviceFixture,
  gpuInventoryFixture,
  gpuTelemetryFixture,
  sshHostFixture,
} from '@test/mocks/backend/fixtures'

const rtx4090 = gpuDeviceFixture()
const rtx3060 = GPU_RTX_3060()
const inventory = gpuInventoryFixture([rtx4090, rtx3060])

function probe(statuses: Record<string, 'supported' | 'unsupported' | 'unknown'>, reason?: string): EngineGpuProbeSnapshot {
  return {
    enginePath: '/e',
    checkedAt: FIXTURE_NOW,
    devices: Object.entries(statuses).map(([uuid, status], index) => ({
      uuid,
      index,
      name: uuid,
      status,
      reason: status === 'unsupported' ? reason : undefined,
    })),
  }
}

describe('default GPU', () => {
  it('uses the saved GPU, else the recommended one', () => {
    expect(defaultGpuUuid(inventory, { uuid: rtx3060.uuid })).toBe(rtx3060.uuid)
    expect(defaultGpuUuid(inventory, 'auto')).toBe(rtx4090.uuid)
    expect(defaultGpuUuid(null, 'auto')).toBeUndefined()
  })

  it('notices a saved GPU that is gone', () => {
    expect(savedGpuMissing(inventory, { uuid: 'GPU-gone' })).toBe(true)
    expect(savedGpuMissing(inventory, { uuid: rtx3060.uuid })).toBe(false)
    expect(savedGpuMissing(inventory, 'auto')).toBe(false)
  })
})

describe('gpuRows', () => {
  it('marks the default and the engine status of each GPU', () => {
    const rows = gpuRows(inventory, probe({ [rtx4090.uuid]: 'supported', [rtx3060.uuid]: 'unsupported' }, 'SM86 不在构建里'), null, 'auto')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      name: 'NVIDIA GeForce RTX 4090',
      isDefault: true,
      status: 'ok',
      statusLabel: '正常',
      detail: '24 GB · 默认（自动选择）',
    })
    expect(rows[1]).toMatchObject({
      isDefault: false,
      status: 'error',
      statusLabel: '不能使用',
      reason: 'SM86 不在构建里',
      detail: '12 GB',
    })
  })

  it('shows 待检测 before the engine probe and a fixed default', () => {
    const rows = gpuRows(inventory, null, null, { uuid: rtx3060.uuid })
    expect(rows.map((row) => row.statusLabel)).toEqual(['待检测', '待检测'])
    expect(rows[1]!.detail).toBe('12 GB · 默认')
  })

  it('mentions running tasks', () => {
    const telemetry = gpuTelemetryFixture([rtx4090])
    telemetry.devices[0]!.runningTasks = 2
    expect(gpuRows(gpuInventoryFixture([rtx4090]), null, telemetry, 'auto')[0]!.detail).toContain('2 个任务进行中')
  })

  it('explains an empty list in plain words', () => {
    expect(gpuRows(null, null, null, 'auto')).toEqual([])
    expect(gpuEmptyMessage(null)).toMatch(/正在检测/)
    expect(gpuEmptyMessage(gpuInventoryFixture([]))).toMatch(/没有找到能运行引擎的显卡/)
    expect(gpuEmptyMessage({ scannedAt: FIXTURE_NOW, status: 'error', devices: [], error: 'nvidia-smi failed' })).toMatch(
      /nvidia-smi failed/,
    )
  })
})

describe('engine per GPU', () => {
  const multi = machineFixture('multiGpu')
  const plan = (overrides: Record<string, string> = {}, versions: LocalEngineVersion[] = []) =>
    enginePlanFor(multi, RELEASE_220, { engineDeviceOverrides: overrides, mossInferChannel: 'stable' }, versions)
  const readiness = engineReadyFixture({
    devices: [
      { deviceUuid: multi.gpus[0]!.id, name: multi.gpus[0]!.name, packageId: 'cu13', path: '/e/cu13' },
      { deviceUuid: multi.gpus[1]!.id, name: multi.gpus[1]!.name, packageId: null, path: null },
      { deviceUuid: multi.gpus[2]!.id, name: multi.gpus[2]!.name, packageId: 'vulkan', path: '/e/vk' },
    ],
  })

  it("shows which engine each GPU runs, with the plan's tips", () => {
    const rows = gpuRows(gpuInventoryFixture(inventoryDevicesFor(multi)), null, null, 'auto', gpuEngineInfo(readiness, plan()))
    expect(rows.map((row) => row.engine)).toEqual(['CUDA 13', undefined, '兼容模式 · 只能文生图'])
    expect(rows[2]).toMatchObject({ status: 'ok', statusLabel: '正常', tip: expect.stringContaining('ROCm 7') })
    // The CUDA probe has not run yet for the NVIDIA cards.
    expect(rows[0]!.statusLabel).toBe('待检测')
  })

  it("marks a GPU nothing runs on as unusable, with the plan's reason", () => {
    const intel = machineFixture('intel')
    const broken = {
      ...intel,
      gpus: [{ ...intel.gpus[0]!, vulkan: { index: 0, usable: false, discrete: true, reason: 'no shaderInt64' } }],
    }
    const unusable = enginePlanFor(broken, RELEASE_220, { engineDeviceOverrides: {}, mossInferChannel: 'stable' }, [])
    const [row] = gpuRows(
      gpuInventoryFixture(inventoryDevicesFor(broken)),
      null,
      null,
      'auto',
      gpuEngineInfo(engineMissingFixture(), unusable),
    )
    expect(row).toMatchObject({
      status: 'error',
      statusLabel: '不能使用',
      reason: 'Intel(R) Arc(TM) A770 Graphics 缺少引擎需要的 Vulkan 功能（shaderInt64），没法在它上面运行',
    })
  })

  it('replaces the memory mode / tier pickers of a Vulkan or HIP GPU with one quiet line', () => {
    expect(fixedEngineSettingsNote(readiness, multi.gpus[2]!.id)).toBe('兼容模式引擎使用固定设置')
    const hip = engineReadyFixture({ devices: [{ deviceUuid: 'vk-1002-744c-0', name: 'RX 7900 XTX', packageId: 'hip', path: '/e/hip' }] })
    expect(fixedEngineSettingsNote(hip, 'vk-1002-744c-0')).toBe('AMD 原生引擎使用固定设置')
    // CUDA GPUs, GPUs with nothing installed, unknown GPUs and no readiness keep their pickers.
    expect(fixedEngineSettingsNote(readiness, multi.gpus[0]!.id)).toBeNull()
    expect(fixedEngineSettingsNote(readiness, multi.gpus[1]!.id)).toBeNull()
    expect(fixedEngineSettingsNote(readiness, 'GPU-gone')).toBeNull()
    expect(fixedEngineSettingsNote(null, multi.gpus[2]!.id)).toBeNull()
  })

  it('an integrated GPU next to a discrete one is quietly unused, not broken', () => {
    const base = machineFixture('nvidia')
    const igpu = {
      id: 'vk-8086-46a6-0',
      name: 'Intel(R) UHD Graphics',
      vendor: 'intel' as const,
      vulkan: { index: 1, usable: true, discrete: false },
    }
    const laptop = { ...base, gpus: [...base.gpus, igpu] }
    const p = enginePlanFor(laptop, RELEASE_220, { engineDeviceOverrides: {}, mossInferChannel: 'stable' }, [])
    const rows = gpuRows(gpuInventoryFixture(inventoryDevicesFor(laptop)), null, null, 'auto', gpuEngineInfo(engineMissingFixture(), p))
    expect(rows[1]).toMatchObject({ status: 'unknown', statusLabel: '未使用', reason: expect.stringContaining('集成显卡') })
    expect(planLines(p)[1]).toMatchObject({ detail: '不使用（已有独立显卡）', skipped: true })
  })

  it('a GPU picker marks a card too small for the model, and only that one', () => {
    const GiB = 1024 ** 3
    expect(gpuPickerLabel({ name: 'NVIDIA GeForce MX250', index: 0, memoryTotalBytes: 2 * GiB })).toBe(
      'NVIDIA GeForce MX250 · 显卡 0（显存太小）',
    )
    expect(gpuPickerLabel({ name: 'NVIDIA GeForce RTX 4090', index: 1, memoryTotalBytes: 24 * GiB })).toBe(
      'NVIDIA GeForce RTX 4090 · 显卡 1',
    )
    // Unknown memory (an AMD or Intel GPU) is never called too small.
    expect(gpuPickerLabel({ name: 'Intel(R) UHD Graphics 620', index: 2 })).toBe('Intel(R) UHD Graphics 620 · 显卡 2')
  })

  it('a 2 GB card next to a GPU that runs is quietly unused, and says why', () => {
    const laptop = machineFixture('laptopSmallGpu')
    const p = enginePlanFor(laptop, RELEASE_220, { engineDeviceOverrides: {}, mossInferChannel: 'stable' }, [])
    const rows = gpuRows(gpuInventoryFixture(inventoryDevicesFor(laptop)), null, null, 'auto', gpuEngineInfo(engineMissingFixture(), p))
    expect(rows[0]).toMatchObject({
      status: 'unknown',
      statusLabel: '未使用',
      reason: 'NVIDIA GeForce MX250 只有 2 GB 显存，默认用另一块显卡（可在 高级 › 每块 GPU 的引擎 里选用它）',
    })
    expect(planLines(p)[0]).toMatchObject({ detail: '不使用（显存太小，用另一块显卡）', skipped: true })
    expect(planLines(p)[1]).toMatchObject({ detail: '兼容模式 · 599 KB', supported: true })
  })

  it('labels the engine in use', () => {
    expect(engineInUseLabel('cu12-sm70-system-cuda')).toBe('CUDA 12')
    expect(engineInUseLabel('hip')).toBe('AMD 原生 · 只能文生图')
    expect(engineInUseLabel('custom')).toBe('自定义引擎')
    expect(engineInUseLabel(null)).toBeUndefined()
  })

  it('offers 自动 plus only the packages that run on that GPU', () => {
    const p = plan()
    expect(engineOverrideOptions(p, multi.gpus[1]!.id).map((option) => option.value)).toEqual([
      'auto',
      'cu12-sm70',
      'cu12-sm70-system-cuda',
      'vulkan',
    ])
    expect(engineOverrideOptions(p, multi.gpus[2]!.id)).toEqual([
      { value: 'auto', label: '自动' },
      { value: 'vulkan', label: '兼容模式（Vulkan）', description: expect.stringContaining('只能文生图') },
    ])
    expect(engineOverrideOptions(null, 'x')).toEqual([{ value: 'auto', label: '自动' }])
  })

  it("stores and clears one GPU's choice", () => {
    const one = applyEngineOverride({}, 'GPU-a', 'vulkan')
    expect(one).toEqual({ 'GPU-a': 'vulkan' })
    expect(applyEngineOverride(one, 'GPU-a', 'auto')).toEqual({})
    expect(applyEngineOverride(one, 'GPU-a', 'cu11')).toBe(one)
  })
})

describe('applyGpuOverride', () => {
  it('sets, clears and drops per-GPU settings', () => {
    const one = applyGpuOverride({}, 'a', 'memoryMode', 'min_memory')
    expect(one).toEqual({ a: { memoryMode: 'min_memory' } })
    const two = applyGpuOverride(one, 'a', 'tier', 'turbo')
    expect(two).toEqual({ a: { memoryMode: 'min_memory', tier: 'turbo' } })
    expect(applyGpuOverride(two, 'a', 'tier', 'global')).toEqual({ a: { memoryMode: 'min_memory' } })
    expect(applyGpuOverride(one, 'a', 'memoryMode', 'global')).toEqual({})
  })

  it('ignores unknown values', () => {
    const overrides = { a: { tier: 'high' as const } }
    expect(applyGpuOverride(overrides, 'a', 'tier', 'ultra')).toBe(overrides)
  })
})

describe('remote hosts', () => {
  it('summarises a reachable host with its GPU and engine', () => {
    const host = sshHostFixture({
      devices: [
        {
          id: 'cuda:0',
          hostId: 'ssh-gpu',
          hostName: 'Linux GPU',
          name: 'RTX 4090',
          kind: 'cuda',
          detail: '',
          available: true,
          source: 'remote',
        },
      ],
    })
    const engine: RemoteEngineInfo = {
      online: true,
      available: true,
      version: '1.0.3',
      path: '',
      root: '',
      gpu: 'RTX 4090',
      checkedAt: FIXTURE_NOW,
    }
    expect(hostSummary(host, engine)).toEqual({
      status: 'ok',
      statusLabel: '在线',
      detail: 'moss@gpu.example.test · RTX 4090 · 引擎 1.0.3 已安装',
    })
  })

  it('shows the connection error of a failing host', () => {
    expect(hostSummary(sshHostFixture({ status: 'error', error: 'Permission denied', port: 2222 }), undefined)).toEqual({
      status: 'error',
      statusLabel: '连接失败',
      detail: 'moss@gpu.example.test:2222 · Permission denied',
    })
    expect(hostSummary(sshHostFixture({ status: 'unchecked' }), undefined).statusLabel).toBe('未测试')
  })

  it('leaves the remote package choice to the main process (it probes the host)', () => {
    expect(remoteInstallOptions()).toEqual({ channel: 'stable' })
  })
})
