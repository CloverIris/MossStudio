import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EngineMachine, EngineMachineGpu } from '@shared/engineChoice'
import {
  listInstalledEnginePackages,
  machineFromInventory,
  newestPerPackage,
  engineChoiceChanged,
  resolveDeviceEngineFrom,
  type ResolveInput,
} from '@main/services/engineInstalls'
import { useTempDir } from '@test/helpers/tempDir'

const root = useTempDir()
const exe = process.platform === 'win32' ? '.exe' : ''

function install(name: string, program = 'moss-server'): string {
  const path = join(root(), name, 'bin', `${program}${exe}`)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!')
  return path
}

const rtx: EngineMachineGpu = { id: 'GPU-rtx', name: 'RTX 4090', vendor: 'nvidia', computeCapability: { major: 8, minor: 9 }, driverVersion: '590.48.01', vulkan: { index: 1, usable: true, discrete: true, name: 'NVIDIA GeForce RTX 4090' } }
const v100: EngineMachineGpu = { id: 'GPU-v100', name: 'V100', vendor: 'nvidia', computeCapability: { major: 7, minor: 0 }, driverVersion: '590.48.01' }
const amd: EngineMachineGpu = { id: 'vk-1002-744c-0', name: 'RX 7900 XTX', vendor: 'amd', gfxTarget: 'gfx1100', vulkan: { index: 0, usable: true, discrete: true } }
const machine = (gpus: EngineMachineGpu[], patch: Partial<EngineMachine> = {}): EngineMachine =>
  ({ os: 'linux', gpus, systemCuda: [], rocm7: true, hipAccess: true, vulkanProbed: true, ...patch })

function input(patch: Partial<ResolveInput> = {}): ResolveInput {
  return {
    platform: 'linux',
    machine: machine([rtx, v100, amd]),
    installed: listInstalledEnginePackages(root()),
    settings: { engineDeviceOverrides: {}, mossInferServerPath: null },
    root: root(),
    ...patch,
  }
}

describe('listInstalledEnginePackages', () => {
  it('lists each install with its package and program, newest first, skipping incomplete folders', () => {
    install('stable-v2.1.1-cu13')
    install('stable-v2.2.0-cu13')
    install('stable-v2.2.0-vulkan', 'moss-infer-vulkan')
    install('dev-run9-abcdef12-hip', 'moss-infer-hip')
    mkdirSync(join(root(), 'stable-v2.2.0-cu12-sm70', 'bin'), { recursive: true })
    install('my-engine')
    install('.staging/stable-v2.3.0-cu13')
    const installed = listInstalledEnginePackages(root())
    expect(installed.map((item) => [item.id, item.packageId, item.channel, item.tag]).sort()).toEqual([
      ['dev-run9-abcdef12-hip', 'hip', 'dev', 'run9-abcdef12'],
      ['stable-v2.1.1-cu13', 'cu13', 'stable', 'v2.1.1'],
      ['stable-v2.2.0-cu13', 'cu13', 'stable', 'v2.2.0'],
      ['stable-v2.2.0-vulkan', 'vulkan', 'stable', 'v2.2.0'],
    ])
    expect([...newestPerPackage(installed).values()].map((item) => item.id).sort()).toEqual(['dev-run9-abcdef12-hip', 'stable-v2.2.0-cu13', 'stable-v2.2.0-vulkan'])
    expect(listInstalledEnginePackages(join(root(), 'missing'))).toEqual([])
  })
})

describe('newestPerPackage', () => {
  const item = (id: string, channel: 'stable' | 'dev', tag: string, installedAt: number) =>
    ({ id, packageId: 'cu13', package: { kind: 'cuda' as const, flavour: 'cu13' as const, arch: 'standard' as const, runtime: 'bundled' as const }, channel, tag, installDir: id, binaryPath: id, installedAt })
  it('a release by its tag, a CI build against it by install time', () => {
    const v211 = item('stable-v2.1.1-cu13', 'stable', 'v2.1.1', 300)
    const v220 = item('stable-v2.2.0-cu13', 'stable', 'v2.2.0', 100)
    expect(newestPerPackage([v211, v220]).get('cu13')).toBe(v220)
    const dev = item('dev-run9-abcdef12-cu13', 'dev', 'run9-abcdef12', 200)
    expect(newestPerPackage([v220, dev]).get('cu13')).toBe(dev)
    expect(newestPerPackage([dev, { ...v220, installedAt: 400 }]).get('cu13')!.id).toBe('stable-v2.2.0-cu13')
  })
})

describe('resolveDeviceEngineFrom', () => {
  it('each GPU runs the newest install of its own package', () => {
    install('stable-v2.1.1-cu13')
    const cu13 = install('stable-v2.2.0-cu13')
    const sm70 = install('stable-v2.2.0-cu12-sm70')
    const hip = install('stable-v2.2.0-hip', 'moss-infer-hip')
    install('stable-v2.2.0-vulkan', 'moss-infer-vulkan')
    expect(resolveDeviceEngineFrom('GPU-rtx', input())).toMatchObject({ packageId: 'cu13', binaryPath: cu13, version: 'v2.2.0', vulkanIndex: 1 })
    expect(resolveDeviceEngineFrom('GPU-v100', input())).toMatchObject({ packageId: 'cu12-sm70', binaryPath: sm70 })
    expect(resolveDeviceEngineFrom('vk-1002-744c-0', input())).toMatchObject({ packageId: 'hip', binaryPath: hip, gfxTarget: 'gfx1100', vulkanIndex: 0 })
    expect(resolveDeviceEngineFrom('vk-1002-744c-0', input())?.env).toBeUndefined()
  })

  it('passes a ROCm library directory outside /opt/rocm/lib to HIP', () => {
    install('stable-v2.2.0-hip', 'moss-infer-hip')
    expect(resolveDeviceEngineFrom('vk-1002-744c-0', input({ rocmLibDir: '/opt/rocm-7.0.2/lib' }))?.env?.['LD_LIBRARY_PATH']).toMatch(/^\/opt\/rocm-7\.0\.2\/lib/)
  })

  it('uses what is installed when the best package is not (e.g. right after an upgrade)', () => {
    const vulkan = install('stable-v2.2.0-vulkan', 'moss-infer-vulkan')
    expect(resolveDeviceEngineFrom('GPU-rtx', input())).toMatchObject({ packageId: 'vulkan', binaryPath: vulkan, vulkanIndex: 1, expectedVulkanName: 'NVIDIA GeForce RTX 4090' })
    // A Volta GPU cannot run a standard CUDA build: nothing for it.
    install('stable-v2.2.0-cu13')
    expect(resolveDeviceEngineFrom('GPU-v100', input({ machine: machine([v100], { vulkanProbed: true }) }))).toBeNull()
  })

  it('honours the per-GPU override among installed packages', () => {
    install('stable-v2.2.0-cu13')
    const vulkan = install('stable-v2.2.0-vulkan', 'moss-infer-vulkan')
    const settings = { engineDeviceOverrides: { 'GPU-rtx': 'vulkan', 'GPU-v100': 'cu13' }, mossInferServerPath: null }
    expect(resolveDeviceEngineFrom('GPU-rtx', input({ settings }))).toMatchObject({ packageId: 'vulkan', binaryPath: vulkan })
    // An override that does not run there is ignored.
    expect(resolveDeviceEngineFrom('GPU-v100', input({ settings, machine: machine([v100], { vulkanProbed: false }) }))).toMatchObject({ packageId: 'vulkan' })
  })

  it('a pinned moss-server serves the NVIDIA GPUs it runs on', () => {
    const old = install('stable-v2.1.1-cu13')
    install('stable-v2.2.0-cu13')
    const sm70 = install('stable-v2.2.0-cu12-sm70')
    const settings = { engineDeviceOverrides: {}, mossInferServerPath: old }
    expect(resolveDeviceEngineFrom('GPU-rtx', input({ settings }))).toMatchObject({ packageId: 'cu13', binaryPath: old, version: 'v2.1.1' })
    expect(resolveDeviceEngineFrom('GPU-v100', input({ settings }))).toMatchObject({ binaryPath: sm70 })
    const custom = join(root(), '..', `custom-${Date.now()}`, 'bin', 'moss-server')
    expect(resolveDeviceEngineFrom('GPU-rtx', input({ settings: { engineDeviceOverrides: {}, mossInferServerPath: custom }, exists: () => true })))
      .toMatchObject({ packageId: 'custom', binaryPath: custom, version: '自定义' })
  })

  it('falls back to a moss-server found the old way for NVIDIA GPUs only', () => {
    const legacy = '/usr/local/bin/moss-server'
    const options = input({ fallbackServerPath: () => legacy, exists: (path) => path === legacy })
    expect(resolveDeviceEngineFrom('GPU-rtx', options)).toMatchObject({ packageId: 'custom', binaryPath: legacy })
    expect(resolveDeviceEngineFrom('vk-1002-744c-0', options)).toBeNull()
  })

  it('unknown GPUs and macOS have no engine', () => {
    install('stable-v2.2.0-cu13')
    expect(resolveDeviceEngineFrom('GPU-gone', input())).toBeNull()
    expect(resolveDeviceEngineFrom('GPU-rtx', input({ machine: machine([rtx], { os: 'macos' }) }))).toBeNull()
  })
})

describe('machineFromInventory', () => {
  it('turns the GPU inventory into a machine with Vulkan usability unknown', () => {
    expect(machineFromInventory('win32', [
      { uuid: 'GPU-a', index: 0, name: 'RTX 2080', computeCapability: { major: 7, minor: 5 }, driverVersion: '581.42' },
      { uuid: 'vk-8086-56a0-0', index: 1, name: 'Arc', vendor: 'intel', pciId: '8086:56a0' },
    ])).toEqual({
      os: 'windows', systemCuda: [], rocm7: false, vulkanProbed: false,
      gpus: [
        { id: 'GPU-a', name: 'RTX 2080', vendor: 'nvidia', computeCapability: { major: 7, minor: 5 }, driverVersion: '581.42' },
        { id: 'vk-8086-56a0-0', name: 'Arc', vendor: 'intel', pciId: '8086:56a0' },
      ],
    })
  })
})

describe('engineChoiceChanged (settings → release stale moss-servers)', () => {
  const base = { engineDeviceOverrides: { 'GPU-a': 'cu13' }, mossInferServerPath: null }
  it('a per-GPU engine choice or the pinned moss-server changing counts', () => {
    expect(engineChoiceChanged(base, { ...base, engineDeviceOverrides: { 'GPU-a': 'vulkan' } })).toBe(true)
    expect(engineChoiceChanged(base, { ...base, engineDeviceOverrides: {} })).toBe(true)
    expect(engineChoiceChanged(base, { ...base, mossInferServerPath: '/e/bin/moss-server' })).toBe(true)
  })
  it('anything else does not (same choices in another key order included)', () => {
    const two = { engineDeviceOverrides: { a: 'cu13', b: 'vulkan' }, mossInferServerPath: null }
    expect(engineChoiceChanged(two, { engineDeviceOverrides: { b: 'vulkan', a: 'cu13' }, mossInferServerPath: null })).toBe(false)
    expect(engineChoiceChanged(base, { ...base })).toBe(false)
  })
})

