import { describe, expect, it } from 'vitest'
import {
  applyGpuOverride,
  defaultGpuUuid,
  gpuEmptyMessage,
  gpuRows,
  hostSummary,
  remoteInstallOptions,
  savedGpuMissing,
} from '@renderer/pages/settings/devicesModel'
import type { EngineGpuProbeSnapshot, RemoteEngineInfo } from '@shared/types'
import { FIXTURE_NOW, GPU_RTX_3060, gpuDeviceFixture, gpuInventoryFixture, gpuTelemetryFixture, sshHostFixture } from '@test/mocks/backend/fixtures'

const rtx4090 = gpuDeviceFixture()
const rtx3060 = GPU_RTX_3060()
const inventory = gpuInventoryFixture([rtx4090, rtx3060])

function probe(statuses: Record<string, 'supported' | 'unsupported' | 'unknown'>, reason?: string): EngineGpuProbeSnapshot {
  return {
    enginePath: '/e', checkedAt: FIXTURE_NOW,
    devices: Object.entries(statuses).map(([uuid, status], index) => ({ uuid, index, name: uuid, status, reason: status === 'unsupported' ? reason : undefined })),
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
    expect(rows[0]).toMatchObject({ name: 'NVIDIA GeForce RTX 4090', isDefault: true, status: 'ok', statusLabel: '正常', detail: '24 GB · 默认（自动选择）' })
    expect(rows[1]).toMatchObject({ isDefault: false, status: 'error', statusLabel: '不能使用', reason: 'SM86 不在构建里', detail: '12 GB' })
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
    expect(gpuEmptyMessage(gpuInventoryFixture([]))).toMatch(/NVIDIA/)
    expect(gpuEmptyMessage({ scannedAt: FIXTURE_NOW, status: 'error', devices: [], error: 'nvidia-smi failed' })).toMatch(/nvidia-smi failed/)
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
    const host = sshHostFixture({ devices: [{ id: 'cuda:0', hostId: 'ssh-gpu', hostName: 'Linux GPU', name: 'RTX 4090', kind: 'cuda', detail: '', available: true, source: 'remote' }] })
    const engine: RemoteEngineInfo = { online: true, available: true, version: '1.0.3', path: '', root: '', gpu: 'RTX 4090', checkedAt: FIXTURE_NOW }
    expect(hostSummary(host, engine)).toEqual({ status: 'ok', statusLabel: '在线', detail: 'moss@gpu.example.test · RTX 4090 · 引擎 1.0.3 已安装' })
  })

  it('shows the connection error of a failing host', () => {
    expect(hostSummary(sshHostFixture({ status: 'error', error: 'Permission denied', port: 2222 }), undefined))
      .toEqual({ status: 'error', statusLabel: '连接失败', detail: 'moss@gpu.example.test:2222 · Permission denied' })
    expect(hostSummary(sshHostFixture({ status: 'unchecked' }), undefined).statusLabel).toBe('未测试')
  })

  it('picks remote install options from the CUDA check', () => {
    expect(remoteInstallOptions(undefined)).toEqual({ channel: 'stable', flavour: 'cu13', variant: 'bundled', architecture: 'auto' })
    const cuda = { checkedAt: FIXTURE_NOW, durationMs: 1, computeCapabilities: [], libraries: [], flavours: ['cu12' as const], recommendedFlavour: 'cu12' as const }
    expect(remoteInstallOptions({ online: true, available: false, path: '', root: '', gpu: '', checkedAt: FIXTURE_NOW, cuda }))
      .toMatchObject({ flavour: 'cu12', variant: 'system-cuda' })
    expect(remoteInstallOptions({ online: true, available: false, path: '', root: '', gpu: '', checkedAt: FIXTURE_NOW, cuda: { ...cuda, recommendedVariant: 'bundled' } }))
      .toMatchObject({ variant: 'bundled' })
  })
})
