import { describe, expect, it } from 'vitest'
import {
  chooseEnginePackages,
  engineOsOf,
  installedAsRelease,
  type EngineAssetList,
  type EngineMachine,
  type EngineMachineGpu,
} from '@shared/engineChoice'
import { enginePackageId, parseEnginePackageId, type EngineOs } from '@shared/enginePackages'

/** Every asset of the real v2.2.0 release (its SHA256SUMS), Linux .zip duplicates included. */
const V220_ASSETS = [
  'mossinfer-2.2.0-linux-cu12-x86_64-sm70-system-cuda.zip',
  'mossinfer-2.2.0-linux-cu12-x86_64-sm70.zip',
  'mossinfer-2.2.0-linux-cu12-x86_64-system-cuda.zip',
  'mossinfer-2.2.0-linux-cu12-x86_64.zip',
  'mossinfer-2.2.0-linux-cu13-x86_64-system-cuda.zip',
  'mossinfer-2.2.0-linux-cu13-x86_64.zip',
  'mossinfer-2.2.0-windows-cu12-x86_64-system-cuda.zip',
  'mossinfer-2.2.0-windows-cu12-x86_64.zip',
  'mossinfer-2.2.0-windows-cu13-x86_64-sm75-system-cuda.zip',
  'mossinfer-2.2.0-windows-cu13-x86_64-sm75.zip',
  'mossinfer-2.2.0-windows-cu13-x86_64-system-cuda.zip',
  'mossinfer-2.2.0-windows-cu13-x86_64.zip',
  'mossinfer-2.2.0-windows-vulkan-x86_64.zip',
  'mossinfer-2.2.0-linux-cu12-x86_64-sm70-system-cuda.tar.gz',
  'mossinfer-2.2.0-linux-cu12-x86_64-sm70.tar.gz',
  'mossinfer-2.2.0-linux-cu12-x86_64-system-cuda.tar.gz',
  'mossinfer-2.2.0-linux-cu12-x86_64.tar.gz',
  'mossinfer-2.2.0-linux-cu13-x86_64-system-cuda.tar.gz',
  'mossinfer-2.2.0-linux-cu13-x86_64.tar.gz',
  'mossinfer-2.2.0-linux-hip-x86_64.tar.gz',
  'mossinfer-2.2.0-linux-vulkan-x86_64.tar.gz',
]

const release = (names: string[] = V220_ASSETS): EngineAssetList => ({
  version: 'v2.2.0',
  assets: names.map((name, index) => ({ name, size: 1_000_000 * (index + 1) })),
})

const without = (...patterns: RegExp[]): EngineAssetList => release(V220_ASSETS.filter((name) => !patterns.some((pattern) => pattern.test(name))))

const vk = (index: number, usable = true, discrete = true): EngineMachineGpu['vulkan'] => ({
  index, usable, discrete, ...(usable ? { kernels: 'coop' } : { reason: 'needs Vulkan 1.2' }),
})

function nvidia(cc: [number, number], driver: string | undefined, patch: Partial<EngineMachineGpu> = {}): EngineMachineGpu {
  return {
    id: `GPU-${cc.join('')}-${driver ?? 'none'}`,
    name: `NVIDIA SM${cc.join('')}`,
    vendor: 'nvidia',
    computeCapability: { major: cc[0], minor: cc[1] },
    driverVersion: driver,
    vulkan: vk(0),
    ...patch,
  }
}

const amd = (gfx: string | undefined, patch: Partial<EngineMachineGpu> = {}): EngineMachineGpu => ({
  id: `vk-1002-744c-0`, name: `AMD ${gfx ?? 'GPU'}`, vendor: 'amd', pciId: '1002:744c', gfxTarget: gfx, vulkan: vk(0), ...patch,
})

const intel = (patch: Partial<EngineMachineGpu> = {}): EngineMachineGpu => ({
  id: 'vk-8086-56a0-0', name: 'Intel Arc A770', vendor: 'intel', pciId: '8086:56a0', vulkan: vk(0), ...patch,
})

function machine(os: EngineOs, gpus: EngineMachineGpu[], patch: Partial<EngineMachine> = {}): EngineMachine {
  return { os, gpus, systemCuda: [], rocm7: false, hipAccess: true, vulkanProbed: true, ...patch }
}

/** The package id chosen for the single GPU of a machine, or null. */
function pick(os: EngineOs, gpu: EngineMachineGpu, patch: Partial<EngineMachine> = {}, assets = release()): string | null {
  return chooseEnginePackages(machine(os, [gpu], patch), assets).choices[0]!.packageId
}

describe('chooseEnginePackages — NVIDIA with a standard kernel image (8.x, 12.x)', () => {
  const ccs: Array<[number, number]> = [[8, 0], [8, 6], [8, 9], [12, 0], [12, 1]]
  for (const os of ['windows', 'linux'] as const) {
    for (const cc of ccs) {
      it(`${os} SM${cc.join('')}: CUDA 13 with an R580 driver`, () => {
        expect(pick(os, nvidia(cc, '581.42'))).toBe('cu13')
      })
      it(`${os} SM${cc.join('')}: CUDA 12 with an older driver, and a tip to update`, () => {
        const plan = chooseEnginePackages(machine(os, [nvidia(cc, '560.94')]), release())
        expect(plan.choices[0]).toMatchObject({ packageId: 'cu12', tip: expect.stringContaining('R580') })
      })
      it(`${os} SM${cc.join('')}: Vulkan with a driver too old for CUDA 12`, () => {
        const plan = chooseEnginePackages(machine(os, [nvidia(cc, '470.256.02')]), release())
        expect(plan.choices[0]).toMatchObject({ packageId: 'vulkan', tip: expect.stringContaining(os === 'linux' ? '525.60.13' : '527.41') })
      })
    }
  }

  it('uses the system-CUDA package when that CUDA major is installed', () => {
    expect(pick('linux', nvidia([8, 9], '590.48.01'), { systemCuda: ['cu13'] })).toBe('cu13-system-cuda')
    expect(pick('linux', nvidia([8, 9], '590.48.01'), { systemCuda: ['cu12'] })).toBe('cu13')
    expect(pick('windows', nvidia([8, 6], '566.36'), { systemCuda: ['cu12', 'cu13'] })).toBe('cu12-system-cuda')
  })
})

describe('chooseEnginePackages — driver edge values', () => {
  const cases: Array<[EngineOs, string | undefined, string | null]> = [
    ['linux', '580.65.06', 'cu13'],
    ['linux', '580.65.05', 'cu12'],
    ['linux', '580.65', 'cu12'],
    ['linux', '580.82.07', 'cu13'],
    ['linux', '525.60.13', 'cu12'],
    ['linux', '525.60.12', 'vulkan'],
    ['linux', '525.105.17', 'cu12'],
    ['windows', '580.88', 'cu13'],
    ['windows', '580.87', 'cu12'],
    ['windows', '527.41', 'cu12'],
    ['windows', '527.40', 'vulkan'],
    ['windows', '526.98', 'vulkan'],
    ['windows', undefined, 'vulkan'],
    ['linux', 'N/A', 'vulkan'],
  ]
  for (const [os, driver, expected] of cases) {
    it(`${os} driver ${driver ?? 'unknown'} → ${expected}`, () => {
      expect(pick(os, nvidia([8, 9], driver))).toBe(expected)
    })
  }
})

describe('chooseEnginePackages — NVIDIA Turing (7.5)', () => {
  it('Windows: CUDA 13 SM75 with R580', () => {
    expect(pick('windows', nvidia([7, 5], '581.42'))).toBe('cu13-sm75')
    expect(pick('windows', nvidia([7, 5], '581.42'), { systemCuda: ['cu13'] })).toBe('cu13-sm75-system-cuda')
  })
  it('Windows: Vulkan with an older driver, and a tip to update to R580', () => {
    const plan = chooseEnginePackages(machine('windows', [nvidia([7, 5], '566.36')]), release())
    expect(plan.choices[0]).toMatchObject({ packageId: 'vulkan', tip: expect.stringContaining('R580') })
  })
  it('Linux: CUDA 12 SM70 with any CUDA 12 driver, also an R580 one', () => {
    expect(pick('linux', nvidia([7, 5], '535.183.01'))).toBe('cu12-sm70')
    expect(pick('linux', nvidia([7, 5], '590.48.01'))).toBe('cu12-sm70')
    expect(pick('linux', nvidia([7, 5], '590.48.01'), { systemCuda: ['cu12'] })).toBe('cu12-sm70-system-cuda')
  })
  it('Linux: Vulkan with a driver too old for CUDA 12', () => {
    const plan = chooseEnginePackages(machine('linux', [nvidia([7, 5], '470.256.02')]), release())
    expect(plan.choices[0]).toMatchObject({ packageId: 'vulkan', tip: expect.stringContaining('525.60.13') })
  })
})

describe('chooseEnginePackages — NVIDIA Volta (7.0)', () => {
  it('Linux: CUDA 12 SM70', () => {
    expect(pick('linux', nvidia([7, 0], '550.54.15'))).toBe('cu12-sm70')
  })
  it('Linux: Vulkan with an old driver', () => {
    expect(pick('linux', nvidia([7, 0], '470.256.02'))).toBe('vulkan')
  })
  it('Windows: Vulkan, there is no Windows SM70 build', () => {
    const choice = chooseEnginePackages(machine('windows', [nvidia([7, 0], '581.42')]), release()).choices[0]!
    expect(choice.packageId).toBe('vulkan')
    expect(choice.tip).toBeUndefined()
  })
})

describe('chooseEnginePackages — NVIDIA without a CUDA kernel image', () => {
  const ccs: Array<[number, number]> = [[6, 1], [5, 2], [9, 0], [10, 0], [11, 0]]
  for (const os of ['windows', 'linux'] as const) {
    for (const cc of ccs) {
      it(`${os} SM${cc.join('')}: Vulkan when usable`, () => {
        expect(pick(os, nvidia(cc, '581.42'))).toBe('vulkan')
      })
      it(`${os} SM${cc.join('')}: unsupported when Vulkan cannot use it`, () => {
        const plan = chooseEnginePackages(machine(os, [nvidia(cc, '581.42', { vulkan: vk(0, false) })]), release())
        expect(plan.choices[0]).toMatchObject({ packageId: null, package: null })
        expect(plan.choices[0]!.reason).toContain('needs Vulkan 1.2')
        expect(plan.blocked).toBeTruthy()
      })
    }
  }
  it('an NVIDIA GPU whose compute capability is unknown is treated like one without a CUDA image', () => {
    expect(pick('linux', nvidia([8, 9], '581.42', { computeCapability: undefined }))).toBe('vulkan')
  })
})

describe('chooseEnginePackages — AMD', () => {
  for (const gfx of ['gfx1100', 'gfx1200', 'gfx1201']) {
    it(`Linux ${gfx}: HIP with ROCm 7`, () => {
      expect(pick('linux', amd(gfx), { rocm7: true })).toBe('hip')
    })
    it(`Linux ${gfx}: Vulkan without ROCm 7, with a ROCm tip`, () => {
      const choice = chooseEnginePackages(machine('linux', [amd(gfx)]), release()).choices[0]!
      expect(choice).toMatchObject({ packageId: 'vulkan', tip: expect.stringContaining('ROCm 7') })
    })
    it(`Windows ${gfx}: Vulkan`, () => {
      const choice = chooseEnginePackages(machine('windows', [amd(gfx)], { rocm7: true }), release()).choices[0]!
      expect(choice.packageId).toBe('vulkan')
      expect(choice.tip).toBeUndefined()
    })
  }
  for (const gfx of ['gfx1101', 'gfx1030', 'gfx90a', undefined]) {
    it(`Linux ${gfx ?? 'unknown gfx'}: Vulkan even with ROCm 7, no tip`, () => {
      const choice = chooseEnginePackages(machine('linux', [amd(gfx)], { rocm7: true }), release()).choices[0]!
      expect(choice.packageId).toBe('vulkan')
      expect(choice.tip).toBeUndefined()
    })
  }
  it('HIP still works when Vulkan cannot use the GPU', () => {
    expect(pick('linux', amd('gfx1100', { vulkan: undefined }), { rocm7: true })).toBe('hip')
  })
  it('without ROCm and without Vulkan: unsupported, still suggests ROCm', () => {
    const choice = chooseEnginePackages(machine('linux', [amd('gfx1201', { vulkan: undefined })]), release()).choices[0]!
    expect(choice.packageId).toBeNull()
    expect(choice.tip).toContain('ROCm 7')
  })
})

describe('chooseEnginePackages — Intel and other GPUs', () => {
  for (const os of ['windows', 'linux'] as const) {
    it(`${os}: Vulkan when usable`, () => {
      expect(pick(os, intel())).toBe('vulkan')
    })
    it(`${os}: unsupported when Vulkan says it is unusable`, () => {
      expect(pick(os, intel({ vulkan: vk(0, false, false) }))).toBeNull()
    })
    it(`${os}: unsupported when the Vulkan probe ran and did not list it`, () => {
      expect(pick(os, intel({ vulkan: undefined }))).toBeNull()
    })
    it(`${os}: assumes Vulkan works when the probe could not run`, () => {
      expect(pick(os, intel({ vulkan: undefined }), { vulkanProbed: false })).toBe('vulkan')
    })
  }
  it('other vendors go the same way', () => {
    expect(pick('linux', { id: 'vk-1234-0001-0', name: 'Other GPU', vendor: 'other', vulkan: vk(0) })).toBe('vulkan')
  })
})

describe('chooseEnginePackages — machines', () => {
  it('macOS: nothing runs locally, points to remote hosts', () => {
    const plan = chooseEnginePackages(machine('macos', [intel()]), release())
    expect(plan.choices).toEqual([])
    expect(plan.packages).toEqual([])
    expect(plan.blocked).toContain('远程主机')
  })

  it('no GPU at all', () => {
    const plan = chooseEnginePackages(machine('linux', []), release())
    expect(plan.blocked).toBeTruthy()
    expect(plan.packages).toEqual([])
  })

  it('mixed multi-GPU: one package per distinct choice, sizes added once', () => {
    const gpus = [
      nvidia([8, 9], '590.48.01', { id: 'GPU-a' }),
      nvidia([8, 6], '590.48.01', { id: 'GPU-b' }),
      nvidia([7, 0], '590.48.01', { id: 'GPU-c' }),
      amd('gfx1100', { id: 'vk-1002-744c-0' }),
      intel({ id: 'vk-8086-56a0-0' }),
    ]
    const assets = release()
    const plan = chooseEnginePackages(machine('linux', gpus, { rocm7: true }), assets)
    expect(plan.choices.map((choice) => [choice.gpuId, choice.packageId])).toEqual([
      ['GPU-a', 'cu13'], ['GPU-b', 'cu13'], ['GPU-c', 'cu12-sm70'], ['vk-1002-744c-0', 'hip'], ['vk-8086-56a0-0', 'vulkan'],
    ])
    expect(plan.packages.map((item) => [item.packageId, item.gpuIds])).toEqual([
      ['cu13', ['GPU-a', 'GPU-b']], ['cu12-sm70', ['GPU-c']], ['hip', ['vk-1002-744c-0']], ['vulkan', ['vk-8086-56a0-0']],
    ])
    const size = (name: string): number => assets.assets.find((asset) => asset.name === name)!.size
    expect(plan.totalBytes).toBe(
      size('mossinfer-2.2.0-linux-cu13-x86_64.tar.gz') + size('mossinfer-2.2.0-linux-cu12-x86_64-sm70.tar.gz') +
      size('mossinfer-2.2.0-linux-hip-x86_64.tar.gz') + size('mossinfer-2.2.0-linux-vulkan-x86_64.tar.gz'),
    )
    expect(plan.blocked).toBeUndefined()
  })

  it('a machine where one GPU works and one does not is not blocked', () => {
    const plan = chooseEnginePackages(machine('windows', [nvidia([8, 9], '581.42'), intel({ vulkan: vk(1, false) })]), release())
    expect(plan.blocked).toBeUndefined()
    expect(plan.choices.map((choice) => choice.packageId)).toEqual(['cu13', null])
  })

  it('picks the Windows .zip and the Linux .tar.gz', () => {
    expect(chooseEnginePackages(machine('windows', [nvidia([8, 9], '581.42')]), release()).packages[0]!.asset.name).toBe('mossinfer-2.2.0-windows-cu13-x86_64.zip')
    expect(chooseEnginePackages(machine('linux', [nvidia([8, 9], '581.42')]), release()).packages[0]!.asset.name).toBe('mossinfer-2.2.0-linux-cu13-x86_64.tar.gz')
  })
})

describe('chooseEnginePackages — releases missing assets', () => {
  it('falls back to the other runtime variant of the same build', () => {
    expect(pick('linux', nvidia([8, 9], '590.48.01'), { systemCuda: ['cu13'] }, without(/linux-cu13-x86_64-system-cuda/))).toBe('cu13')
    expect(pick('linux', nvidia([8, 9], '590.48.01'), {}, without(/linux-cu13-x86_64\.tar\.gz$/))).toBe('cu13-system-cuda')
  })
  it('falls back down the table when a whole build is missing', () => {
    expect(pick('linux', nvidia([8, 9], '590.48.01'), {}, without(/linux-cu13/))).toBe('cu12')
    expect(pick('linux', nvidia([8, 9], '590.48.01'), {}, without(/linux-cu1[23]/))).toBe('vulkan')
    expect(pick('windows', nvidia([7, 5], '581.42'), {}, without(/sm75/))).toBe('vulkan')
    expect(pick('linux', amd('gfx1100'), { rocm7: true }, without(/hip/))).toBe('vulkan')
  })
  it('a release without anything for this GPU leaves it unsupported', () => {
    const plan = chooseEnginePackages(machine('linux', [intel()]), without(/vulkan/))
    expect(plan.choices[0]!.packageId).toBeNull()
    expect(plan.blocked).toBeTruthy()
  })
  it('an older release with only CUDA 13 standard packages (v2.1)', () => {
    const old: EngineAssetList = { version: '2.1.1', assets: [
      { name: 'mossinfer-2.1.1-linux-cu13-x86_64.tar.gz', size: 1 },
      { name: 'mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz', size: 1 },
    ] }
    expect(pick('linux', nvidia([8, 9], '590.48.01'), {}, old)).toBe('cu13')
    expect(pick('linux', nvidia([8, 9], '560.35.03'), {}, old)).toBeNull()
  })
})

describe('chooseEnginePackages — compatible list and overrides', () => {
  it('lists every package that runs on the GPU, best first', () => {
    const choice = chooseEnginePackages(machine('linux', [nvidia([8, 9], '590.48.01')], { systemCuda: ['cu12'] }), release()).choices[0]!
    expect(choice.compatible.map(enginePackageId)).toEqual(['cu13', 'cu13-system-cuda', 'cu12-system-cuda', 'cu12', 'vulkan'])
  })
  it('Turing on Windows with an old driver can only use Vulkan', () => {
    const choice = chooseEnginePackages(machine('windows', [nvidia([7, 5], '560.94')]), release()).choices[0]!
    expect(choice.compatible.map(enginePackageId)).toEqual(['vulkan'])
  })
  it('applies a compatible override', () => {
    const gpu = nvidia([8, 9], '590.48.01', { id: 'GPU-x' })
    const plan = chooseEnginePackages(machine('linux', [gpu]), release(), { overrides: { 'GPU-x': 'vulkan' } })
    expect(plan.choices[0]!.packageId).toBe('vulkan')
    expect(plan.choices[0]!.overrideIgnored).toBeUndefined()
    expect(plan.packages.map((item) => item.packageId)).toEqual(['vulkan'])
  })
  it('ignores an override that does not run on the GPU, and says so', () => {
    const gpu = nvidia([7, 5], '560.94', { id: 'GPU-t' })
    const plan = chooseEnginePackages(machine('windows', [gpu]), release(), { overrides: { 'GPU-t': 'cu13-sm75' } })
    expect(plan.choices[0]).toMatchObject({ packageId: 'vulkan', overrideIgnored: true })
  })
  it('remote hosts consider CUDA builds only', () => {
    const plan = chooseEnginePackages(machine('linux', [amd('gfx1100')], { rocm7: true }), release(), { cudaOnly: true })
    expect(plan.choices[0]!.packageId).toBeNull()
    expect(plan.choices[0]!.reason).toContain('不是 NVIDIA')
    const old = chooseEnginePackages(machine('linux', [nvidia([8, 9], '470.256.02')]), release(), { cudaOnly: true })
    expect(old.choices[0]!.packageId).toBeNull()
    expect(old.choices[0]!.compatible).toEqual([])
  })
})

describe('installedAsRelease', () => {
  it('lets the chooser pick among installed packages only', () => {
    const installed = installedAsRelease('linux', ['cu12', 'vulkan'].map((id) => parseEnginePackageId(id)!))
    expect(pick('linux', nvidia([8, 9], '590.48.01'), {}, installed)).toBe('cu12')
    expect(pick('linux', amd('gfx1100'), { rocm7: true }, installed)).toBe('vulkan')
  })
})

describe('engineOsOf', () => {
  it('maps Node platforms', () => {
    expect(engineOsOf('win32')).toBe('windows')
    expect(engineOsOf('linux')).toBe('linux')
    expect(engineOsOf('darwin')).toBe('macos')
  })
})

describe('chooseEnginePackages — integrated GPUs next to a discrete one', () => {
  const igpu = intel({ id: 'vk-8086-46a6-0', name: 'Intel(R) UHD Graphics', vulkan: vk(1, true, false) })

  it('a laptop with an RTX and an integrated Intel GPU: only the RTX gets an engine', () => {
    const plan = chooseEnginePackages(machine('windows', [nvidia([8, 9], '581.42'), igpu]), release())
    expect(plan.choices.map((choice) => choice.packageId)).toEqual(['cu13', null])
    expect(plan.choices[1]).toMatchObject({ integratedSkipped: true, reason: expect.stringContaining('集成显卡') })
    // Still offered in 高级, so it can be picked by hand.
    expect(plan.choices[1]!.compatible.map(enginePackageId)).toEqual(['vulkan'])
    expect(plan.packages.map((item) => item.packageId)).toEqual(['cu13'])
    expect(plan.blocked).toBeUndefined()
  })

  it('an explicit override still runs the integrated GPU', () => {
    const plan = chooseEnginePackages(machine('windows', [nvidia([8, 9], '581.42'), igpu]), release(), { overrides: { [igpu.id]: 'vulkan' } })
    expect(plan.choices[1]!.packageId).toBe('vulkan')
    expect(plan.choices[1]!.integratedSkipped).toBeUndefined()
  })

  it('an integrated GPU alone, or next to a discrete GPU nothing runs on, keeps compatibility mode', () => {
    expect(pick('linux', igpu)).toBe('vulkan')
    const dead = nvidia([6, 1], '581.42', { vulkan: vk(0, false) })
    const plan = chooseEnginePackages(machine('linux', [dead, igpu]), release())
    expect(plan.choices.map((choice) => choice.packageId)).toEqual([null, 'vulkan'])
  })

  it('two discrete GPUs both keep theirs', () => {
    const plan = chooseEnginePackages(machine('linux', [nvidia([8, 9], '590.48.01'), amd('gfx1030')]), release())
    expect(plan.choices.map((choice) => choice.packageId)).toEqual(['cu13', 'vulkan'])
  })
})

describe('chooseEnginePackages — HIP needs the GPU device nodes', () => {
  it('ROCm 7 without access to /dev/kfd or a render node: Vulkan, with the render/video group tip', () => {
    const choice = chooseEnginePackages(machine('linux', [amd('gfx1100')], { rocm7: true, hipAccess: false }), release()).choices[0]!
    expect(choice.packageId).toBe('vulkan')
    expect(choice.tip).toMatch(/render.*video/)
    expect(choice.compatible.map(enginePackageId)).toEqual(['vulkan'])
  })

  it('moss-infer-hip listing the GPU is enough, and its refusal wins over device access', () => {
    expect(pick('linux', amd('gfx1100', { hip: { index: 0, usable: true } }), { rocm7: true, hipAccess: false })).toBe('hip')
    expect(pick('linux', amd('gfx1100', { hip: { index: 0, usable: false } }), { rocm7: true, hipAccess: true })).toBe('vulkan')
  })

  it('an older probe without the access check needs the HIP listing', () => {
    expect(pick('linux', amd('gfx1100'), { rocm7: true, hipAccess: undefined })).toBe('vulkan')
  })
})

