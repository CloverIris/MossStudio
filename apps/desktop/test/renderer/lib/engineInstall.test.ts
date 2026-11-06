import { describe, expect, it } from 'vitest'
import {
  engineDownloadActive,
  engineDownloadLabel,
  engineDownloadPercent,
  engineInstallError,
  packageLabel,
  planLines,
  planMissingBytes,
} from '@renderer/lib/engineInstall'
import type { LocalEngineVersion, MossInferDownloadState } from '@shared/types'
import { RELEASE_220, enginePlanFor, machineFixture, type MachineName } from '../../mocks/backend/machines'
import { engineDownloadFixture, engineMissingFixture, engineReadyFixture } from '../../mocks/backend'

const plan = (machine: MachineName, versions: LocalEngineVersion[] = [], overrides: Record<string, string> = {}) =>
  enginePlanFor(machineFixture(machine), RELEASE_220, { engineDeviceOverrides: overrides, mossInferChannel: 'stable' }, versions)
const managed = (name: string): LocalEngineVersion => ({ id: name, name, path: `/e/${name}`, current: true, source: 'managed' })

describe('lib/engineInstall planLines', () => {
  it('one line per GPU with the package and its size', () => {
    expect(planLines(plan('nvidia'))).toEqual([
      {
        gpuId: 'GPU-00000000-1111-2222-3333-444444444444',
        gpu: 'NVIDIA GeForce RTX 4090',
        detail: 'CUDA 13 引擎 · 352 MB',
        supported: true,
      },
    ])
  })

  it('explains the compatibility mode and passes the tip on', () => {
    const [line] = planLines(plan('nvidiaOldDriver'))
    expect(line).toMatchObject({ detail: 'CUDA 12 引擎 · 492 MB', tip: expect.stringContaining('R580') })
    const [vulkan] = planLines(plan('intel'))
    expect(vulkan).toMatchObject({ detail: '兼容模式 · 599 KB', note: expect.stringContaining('只能文生图') })
    const [amd] = planLines(plan('amd'))
    expect(amd!.tip).toContain('ROCm 7')
  })

  it('says when the package uses the CUDA runtime already on the computer', () => {
    const machine = { ...machineFixture('nvidia'), systemCuda: ['cu13' as const] }
    const view = enginePlanFor(machine, RELEASE_220, { engineDeviceOverrides: {}, mossInferChannel: 'stable' }, [])
    expect(planLines(view)[0]!.detail).toBe('CUDA 13 引擎（使用系统 CUDA 运行库） · 22 MB')
  })

  it('starts the download line at 0 MB of the known size, not 未知', () => {
    expect(engineDownloadLabel(engineDownloadFixture({ phase: 'downloading', bytes: 0, totalBytes: 24 * 1024 ** 2 }))).toBe(
      '正在下载 0 MB / 24 MB',
    )
  })

  it('names a package shared by several GPUs once and marks installed ones', () => {
    const lines = planLines(plan('multiGpu', [managed('stable-v2.2.0-cu13')]))
    expect(lines.map((line) => line.detail)).toEqual(['CUDA 13 引擎 · 已安装', 'CUDA 12 引擎 · 530 MB', '兼容模式 · 1.2 MB'])
  })

  it('macOS has no lines and is blocked', () => {
    expect(planLines(plan('macos'))).toEqual([])
    expect(plan('macos').blocked).toContain('远程主机')
  })

  it('counts only what is still missing', () => {
    expect(planMissingBytes(plan('multiGpu'))).toBe(386148983 + 556009175 + 1280514)
    expect(
      planMissingBytes(
        plan('multiGpu', [managed('stable-v2.2.0-cu13'), managed('stable-v2.2.0-cu12-sm70'), managed('stable-v2.2.0-vulkan')]),
      ),
    ).toBe(0)
  })

  it('labels package ids plainly', () => {
    expect(packageLabel('cu13-system-cuda')).toBe('CUDA 13')
    expect(packageLabel('vulkan')).toBe('兼容模式')
    expect(packageLabel('hip')).toBe('AMD 原生')
    expect(packageLabel('custom')).toBe('自定义引擎')
    expect(packageLabel(null)).toBeNull()
  })

  it('says which package of several is installing', () => {
    const state = engineDownloadFixture({
      phase: 'downloading',
      bytes: 0,
      totalBytes: 0,
      step: { index: 1, count: 2, packageId: 'vulkan' },
    })
    expect(engineDownloadLabel(state)).toBe('兼容模式（2/2）· 正在下载')
    expect(engineDownloadLabel({ ...state, step: { index: 0, count: 1, packageId: 'cu13' } })).toBe('正在下载')
  })
})

describe('lib/engineInstall progress helpers', () => {
  const phases: Array<MossInferDownloadState['phase']> = [
    'querying',
    'downloading',
    'verifying',
    'extracting',
    'cuda_libs',
    'done',
    'error',
    'canceled',
  ]

  it('only non-terminal phases are active', () => {
    expect(phases.filter((phase) => engineDownloadActive(engineDownloadFixture({ phase })))).toEqual([
      'querying',
      'downloading',
      'verifying',
      'extracting',
      'cuda_libs',
    ])
    expect(engineDownloadActive(null)).toBe(false)
    expect(engineDownloadActive(undefined)).toBe(false)
  })

  it('labels downloads with byte progress and other phases with their name', () => {
    expect(engineDownloadLabel(engineDownloadFixture({ phase: 'downloading', bytes: 186 * 1024 ** 2, totalBytes: 290 * 1024 ** 2 }))).toBe(
      '正在下载 186 MB / 290 MB',
    )
    expect(engineDownloadLabel(engineDownloadFixture({ phase: 'downloading', totalBytes: 0 }))).toBe('正在下载')
    expect(engineDownloadLabel(engineDownloadFixture({ phase: 'cuda_libs' }))).toBe('正在准备运行库')
    expect(new Set(phases.map((phase) => engineDownloadLabel(engineDownloadFixture({ phase, totalBytes: 0 })))).size).toBe(phases.length)
  })

  it('reports a measurable percent only while downloading, clamped to 0..100', () => {
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'downloading', percent: 42 }))).toBe(42)
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'downloading', percent: 140 }))).toBe(100)
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'downloading', percent: -3 }))).toBe(0)
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'downloading', totalBytes: 0, percent: 50 }))).toBeNull()
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'done', percent: 0 }))).toBe(100)
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'verifying', percent: 80 }))).toBeNull()
  })

  it('engineInstallError prefers the live download error, then a failed attempt on a missing engine', () => {
    const attempt = { at: '', error: '下载连接中断' }
    expect(engineInstallError(engineReadyFixture(), engineDownloadFixture({ phase: 'error', error: 'boom' }))).toBe('boom')
    expect(engineInstallError(null, engineDownloadFixture({ phase: 'error' }))).toBe('引擎安装失败')
    expect(engineInstallError(engineMissingFixture({ lastAttempt: attempt }), null)).toBe('下载连接中断')
    expect(engineInstallError(engineReadyFixture({ lastAttempt: attempt }), null)).toBeNull()
    expect(engineInstallError(engineMissingFixture(), engineDownloadFixture({ phase: 'downloading' }))).toBeNull()
    expect(engineInstallError(undefined, undefined)).toBeNull()
  })
})
