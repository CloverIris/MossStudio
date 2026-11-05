import { describe, expect, it } from 'vitest'
import {
  archRunsOn,
  driverMinimumLabel,
  driverSupports,
  engineAssetName,
  engineBinaryName,
  enginePackageId,
  enginePackageOptionLabel,
  enginePackageSummary,
  enginePackageTitle,
  isCliEngine,
  packageExistsFor,
  parseDriverVersion,
  parseEnginePackageId,
  releaseAssetVersion,
  sameEnginePackage,
  type EnginePackage,
} from '@shared/enginePackages'

const cuda = (flavour: 'cu12' | 'cu13', arch: 'standard' | 'sm75' | 'sm70', runtime: 'system-cuda' | 'bundled'): EnginePackage =>
  ({ kind: 'cuda', flavour, arch, runtime })

describe('package ids', () => {
  const all: EnginePackage[] = [
    { kind: 'vulkan' }, { kind: 'hip' },
    ...(['cu12', 'cu13'] as const).flatMap((flavour) => (['standard', 'sm75', 'sm70'] as const).flatMap((arch) =>
      (['system-cuda', 'bundled'] as const).map((runtime) => cuda(flavour, arch, runtime)))),
  ]
  it('round-trips every package', () => {
    for (const pkg of all) expect(parseEnginePackageId(enginePackageId(pkg))).toEqual(pkg)
  })
  it('names them like the install folders', () => {
    expect(enginePackageId(cuda('cu13', 'standard', 'bundled'))).toBe('cu13')
    expect(enginePackageId(cuda('cu13', 'sm75', 'system-cuda'))).toBe('cu13-sm75-system-cuda')
    expect(enginePackageId(cuda('cu12', 'sm70', 'bundled'))).toBe('cu12-sm70')
    expect(enginePackageId({ kind: 'vulkan' })).toBe('vulkan')
  })
  it('rejects anything else', () => {
    for (const id of ['', 'cu11', 'cu13-sm80', 'cuda', 'vulkan-x', 'cu13-system-cuda-sm75']) expect(parseEnginePackageId(id)).toBeNull()
  })
  it('compares by id', () => {
    expect(sameEnginePackage(cuda('cu13', 'standard', 'bundled'), parseEnginePackageId('cu13')!)).toBe(true)
    expect(sameEnginePackage({ kind: 'hip' }, { kind: 'vulkan' })).toBe(false)
  })
})

describe('release asset names (the v2.2.0 contract)', () => {
  it('builds every published name', () => {
    expect(engineAssetName('2.2.0', 'windows', cuda('cu13', 'sm75', 'system-cuda'))).toBe('mossinfer-2.2.0-windows-cu13-x86_64-sm75-system-cuda.zip')
    expect(engineAssetName('v2.2.0', 'linux', cuda('cu12', 'sm70', 'bundled'))).toBe('mossinfer-2.2.0-linux-cu12-x86_64-sm70.tar.gz')
    expect(engineAssetName('2.2.0', 'linux', cuda('cu13', 'standard', 'system-cuda'))).toBe('mossinfer-2.2.0-linux-cu13-x86_64-system-cuda.tar.gz')
    expect(engineAssetName('2.2.0', 'linux', { kind: 'hip' })).toBe('mossinfer-2.2.0-linux-hip-x86_64.tar.gz')
    expect(engineAssetName('2.2.0', 'windows', { kind: 'vulkan' })).toBe('mossinfer-2.2.0-windows-vulkan-x86_64.zip')
  })
  it('knows which packages exist per OS', () => {
    expect(packageExistsFor(cuda('cu13', 'sm75', 'bundled'), 'windows')).toBe(true)
    expect(packageExistsFor(cuda('cu13', 'sm75', 'bundled'), 'linux')).toBe(false)
    expect(packageExistsFor(cuda('cu12', 'sm75', 'bundled'), 'windows')).toBe(false)
    expect(packageExistsFor(cuda('cu12', 'sm70', 'bundled'), 'linux')).toBe(true)
    expect(packageExistsFor(cuda('cu12', 'sm70', 'bundled'), 'windows')).toBe(false)
    expect(packageExistsFor(cuda('cu13', 'sm70', 'bundled'), 'linux')).toBe(false)
    expect(packageExistsFor({ kind: 'hip' }, 'linux')).toBe(true)
    expect(packageExistsFor({ kind: 'hip' }, 'windows')).toBe(false)
    expect(packageExistsFor({ kind: 'vulkan' }, 'windows')).toBe(true)
    expect(packageExistsFor({ kind: 'vulkan' }, 'macos')).toBe(false)
  })
})

describe('binaries', () => {
  it('names each kind per platform', () => {
    expect(engineBinaryName('cuda', 'win32')).toBe('moss-server.exe')
    expect(engineBinaryName('vulkan', 'linux')).toBe('moss-infer-vulkan')
    expect(engineBinaryName('vulkan', 'win32')).toBe('moss-infer-vulkan.exe')
    expect(engineBinaryName('hip', 'linux')).toBe('moss-infer-hip')
  })
  it('marks the one-shot CLIs', () => {
    expect(isCliEngine('vulkan')).toBe(true)
    expect(isCliEngine({ kind: 'hip' })).toBe(true)
    expect(isCliEngine(cuda('cu13', 'standard', 'bundled'))).toBe(false)
  })
})

describe('NVIDIA drivers', () => {
  it('parses versions', () => {
    expect(parseDriverVersion('580.65.06')).toEqual([580, 65, 6])
    expect(parseDriverVersion(' 581.42 ')).toEqual([581, 42])
    expect(parseDriverVersion('N/A')).toBeNull()
    expect(parseDriverVersion(undefined)).toBeNull()
  })
  it('uses the engine probe minimums', () => {
    expect(driverMinimumLabel('cu12', 'linux')).toBe('525.60.13')
    expect(driverMinimumLabel('cu12', 'windows')).toBe('527.41')
    expect(driverMinimumLabel('cu13', 'linux')).toBe('580.65.06')
    expect(driverMinimumLabel('cu13', 'windows')).toBe('580.88')
    expect(driverSupports('cu13', 'linux', '580.65.06')).toBe(true)
    expect(driverSupports('cu13', 'linux', '580.65.05')).toBe(false)
    expect(driverSupports('cu13', 'windows', '580.97')).toBe(true)
    expect(driverSupports('cu12', 'windows', '527.41')).toBe(true)
    expect(driverSupports('cu12', 'windows', '527.37')).toBe(false)
    expect(driverSupports('cu12', 'linux', '1000')).toBe(true)
    expect(driverSupports('cu12', 'linux', '')).toBe(false)
  })
})

describe('archRunsOn', () => {
  it('standard builds: 8.x and 12.x+, not Hopper or data-centre Blackwell', () => {
    for (const [major, minor, expected] of [[8, 0, true], [8, 6, true], [8, 9, true], [12, 0, true], [12, 1, true], [9, 0, false], [10, 0, false], [11, 0, false], [7, 5, false], [7, 0, false]] as const) {
      expect(archRunsOn('standard', 'cu13', { major, minor })).toBe(expected)
    }
  })
  it('sm75 adds Turing only', () => {
    expect(archRunsOn('sm75', 'cu13', { major: 7, minor: 5 })).toBe(true)
    expect(archRunsOn('sm75', 'cu13', { major: 7, minor: 0 })).toBe(false)
  })
  it('sm70 adds Volta and Turing, CUDA 12 only', () => {
    expect(archRunsOn('sm70', 'cu12', { major: 7, minor: 0 })).toBe(true)
    expect(archRunsOn('sm70', 'cu12', { major: 7, minor: 5 })).toBe(true)
    expect(archRunsOn('sm70', 'cu13', { major: 7, minor: 0 })).toBe(false)
    expect(archRunsOn('sm70', 'cu12', { major: 6, minor: 1 })).toBe(false)
  })
})

describe('labels', () => {
  it('says plainly what each package is', () => {
    expect(enginePackageTitle({ kind: 'vulkan' })).toBe('兼容模式')
    expect(enginePackageTitle({ kind: 'hip' })).toBe('AMD 原生')
    expect(enginePackageTitle(cuda('cu13', 'sm75', 'bundled'))).toBe('CUDA 13')
    expect(enginePackageSummary({ kind: 'vulkan' })).toContain('只能文生图')
    expect(enginePackageSummary({ kind: 'vulkan' })).toContain('LoRA')
    expect(enginePackageSummary(cuda('cu13', 'standard', 'system-cuda'))).toContain('已有的 CUDA')
    expect(enginePackageOptionLabel(cuda('cu12', 'sm70', 'bundled'))).toBe('CUDA 12 · SM70 · 自带运行库')
    expect(enginePackageOptionLabel({ kind: 'hip' })).toBe('AMD 原生（ROCm）')
  })
})

describe('releaseAssetVersion', () => {
  it('takes the version from the asset names, not the tag (release candidates)', () => {
    expect(releaseAssetVersion('v2.2.0-rc1', ['SHA256SUMS', 'mossinfer-2.2.0-linux-cu13-x86_64.tar.gz'])).toBe('2.2.0')
    expect(releaseAssetVersion('v2.2.0', ['mossinfer-2.2.0-windows-vulkan-x86_64.zip'])).toBe('2.2.0')
    expect(releaseAssetVersion('v2.3.0', [])).toBe('2.3.0')
    expect(releaseAssetVersion('v2.3.0', ['notes.txt'])).toBe('2.3.0')
  })
})
