import { describe, expect, it } from 'vitest'
import type { EngineAssetList } from '@shared/engineChoice'
import type { RemoteCudaProbe, RemoteEngineInfo } from '@shared/types'
import { remoteMachine } from '@main/services/remoteCuda'
import { chooseRemotePackage, sha256FromSums } from '@main/services/remoteEngineInstall'

const LINUX_220: EngineAssetList = {
  version: '2.2.0',
  assets: [
    'mossinfer-2.2.0-linux-cu12-x86_64-sm70-system-cuda.tar.gz',
    'mossinfer-2.2.0-linux-cu12-x86_64-sm70.tar.gz',
    'mossinfer-2.2.0-linux-cu12-x86_64-system-cuda.tar.gz',
    'mossinfer-2.2.0-linux-cu12-x86_64.tar.gz',
    'mossinfer-2.2.0-linux-cu13-x86_64-system-cuda.tar.gz',
    'mossinfer-2.2.0-linux-cu13-x86_64.tar.gz',
    'mossinfer-2.2.0-linux-hip-x86_64.tar.gz',
    'mossinfer-2.2.0-linux-vulkan-x86_64.tar.gz',
  ].map((name) => ({ name, size: 1 })),
}

function host(cuda: Partial<RemoteCudaProbe>): Pick<RemoteEngineInfo, 'cuda' | 'gpu'> {
  return { gpu: '', cuda: { checkedAt: '', durationMs: 1, computeCapabilities: [], libraries: [], flavours: [], ...cuda } }
}

describe('remoteMachine', () => {
  it('one NVIDIA GPU per nvidia-smi row plus the other display devices', () => {
    expect(remoteMachine(host({
      gpuNames: ['NVIDIA A100-SXM4-80GB', 'Tesla V100'], computeCapabilities: ['8.0', '7.0'], driverVersion: '550.163.01', flavours: ['cu12'],
      pciIds: ['10de:20b2', '10de:1db4', '1a03:2000', '1002:744c'],
    }))).toEqual({
      os: 'linux', systemCuda: ['cu12'], rocm7: false, vulkanProbed: true,
      gpus: [
        { id: 'remote-nvidia-0', name: 'NVIDIA A100-SXM4-80GB', vendor: 'nvidia', computeCapability: { major: 8, minor: 0 }, driverVersion: '550.163.01' },
        { id: 'remote-nvidia-1', name: 'Tesla V100', vendor: 'nvidia', computeCapability: { major: 7, minor: 0 }, driverVersion: '550.163.01' },
        { id: 'remote-1a03:2000-0', name: '显卡', vendor: 'other', pciId: '1a03:2000' },
        { id: 'remote-1002:744c-0', name: 'AMD 显卡', vendor: 'amd', pciId: '1002:744c' },
      ],
    })
  })
})

describe('chooseRemotePackage', () => {
  it('CUDA 13 with a new driver, the system-CUDA package when the host has CUDA 13', () => {
    expect(chooseRemotePackage(host({ gpuNames: ['RTX 4090'], computeCapabilities: ['8.9'], driverVersion: '590.48.01' }), LINUX_220))
      .toEqual({ kind: 'cuda', flavour: 'cu13', arch: 'standard', runtime: 'bundled' })
    expect(chooseRemotePackage(host({ gpuNames: ['RTX 4090'], computeCapabilities: ['8.9'], driverVersion: '590.48.01', flavours: ['cu13'] }), LINUX_220))
      .toMatchObject({ flavour: 'cu13', runtime: 'system-cuda' })
  })

  it('CUDA 12 for an older driver, SM70 for Volta and Turing', () => {
    expect(chooseRemotePackage(host({ computeCapabilities: ['8.6'], driverVersion: '535.183.01' }), LINUX_220)).toMatchObject({ flavour: 'cu12', arch: 'standard' })
    expect(chooseRemotePackage(host({ computeCapabilities: ['7.0'], driverVersion: '550.163.01' }), LINUX_220)).toMatchObject({ flavour: 'cu12', arch: 'sm70' })
    expect(chooseRemotePackage(host({ computeCapabilities: ['7.5'], driverVersion: '590.48.01' }), LINUX_220)).toMatchObject({ flavour: 'cu12', arch: 'sm70' })
  })

  it('serves the most GPUs of a mixed host', () => {
    expect(chooseRemotePackage(host({ computeCapabilities: ['8.9', '7.0', '7.0'], driverVersion: '590.48.01' }), LINUX_220)).toMatchObject({ arch: 'sm70' })
  })

  it('a host with only an AMD GPU says so', () => {
    expect(() => chooseRemotePackage(host({ pciIds: ['1002:744c'] }), LINUX_220)).toThrow(/只有非 NVIDIA 显卡/)
  })

  it('an NVIDIA GPU that no CUDA build runs on, or a driver too old for CUDA 12', () => {
    expect(() => chooseRemotePackage(host({ gpuNames: ['GTX 1080'], computeCapabilities: ['6.1'], driverVersion: '590.48.01' }), LINUX_220)).toThrow(/GTX 1080 没有可用的 CUDA 引擎/)
    expect(() => chooseRemotePackage(host({ computeCapabilities: ['8.9'], driverVersion: '470.256.02' }), LINUX_220)).toThrow(/470\.256\.02/)
  })

  it('a timed-out nvidia-smi says so instead of "no GPU"', () => {
    expect(() => chooseRemotePackage(host({ nvidiaSmiTimedOut: true }), LINUX_220)).toThrow(/15 秒内没有响应/)
  })

  it('no GPU at all', () => {
    expect(() => chooseRemotePackage(host({}), LINUX_220)).toThrow(/没有检测到显卡/)
  })
})

describe('sha256FromSums', () => {
  it('finds the hash of one file in SHA256SUMS', () => {
    const sums = `${'a'.repeat(64)}  mossinfer-2.2.0-linux-cu13-x86_64.tar.gz\n${'b'.repeat(64)} *dist/mossinfer-2.2.0-linux-cu12-x86_64.tar.gz\n`
    expect(sha256FromSums(sums, 'mossinfer-2.2.0-linux-cu13-x86_64.tar.gz')).toBe('a'.repeat(64))
    expect(sha256FromSums(sums, 'mossinfer-2.2.0-linux-cu12-x86_64.tar.gz')).toBe('b'.repeat(64))
    expect(sha256FromSums(sums, 'mossinfer-2.2.0-linux-hip-x86_64.tar.gz')).toBeNull()
  })
})
