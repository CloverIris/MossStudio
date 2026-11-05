import { describe, expect, it, vi } from 'vitest'
import type { GpuInventoryDevice } from '@shared/types'
import type { RunResult } from '@main/lib/run'
import { clearMachineProbeCache, nvidiaSetChanged, probeEngineMachine, readStoredMachineProbe, storeMachineProbe, withLiveNvidia, type MachineProbeDeps } from '@main/services/engineMachine'
import { useTempDir } from '@test/helpers/tempDir'

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })
const fail = (code = 1, stderr = 'boom', timedOut = false): RunResult => ({ code, stdout: '', stderr, timedOut })

const RTX: GpuInventoryDevice = { index: 0, uuid: 'GPU-rtx', name: 'NVIDIA GeForce RTX 4090', pciId: '10de:2684', computeCapability: { major: 8, minor: 9 }, driverVersion: '590.48.01', memoryTotalBytes: 24 }

/** A fake machine: files under /sys and /opt, program outputs, nvidia-smi rows. */
function deps(machine: {
  platform?: NodeJS.Platform
  nvidia?: GpuInventoryDevice[] | Error
  vulkan?: string | RunResult | null
  vulkanBinary?: string | null | Error
  files?: Record<string, string>
  ldconfig?: string
  /** Which ldconfig answers (desktop PATHs often lack /sbin). */
  ldconfigAt?: string
  systemCuda?: Array<'cu12' | 'cu13'>
  /** Device nodes this user may read and write. */
  rw?: string[]
  hipBinary?: string | null
  hipList?: string | RunResult
}): MachineProbeDeps & { calls: Array<{ file: string; args: string[]; timeoutMs: number; env?: Record<string, string> }> } {
  const files = machine.files ?? {}
  const calls: Array<{ file: string; args: string[]; timeoutMs: number; env?: Record<string, string> }> = []
  return {
    calls,
    platform: machine.platform ?? 'linux',
    run: vi.fn(async (file: string, args: string[], timeoutMs: number, env?: Record<string, string>) => {
      calls.push({ file, args, timeoutMs, ...(env ? { env } : {}) })
      if (file.endsWith('ldconfig')) return file === (machine.ldconfigAt ?? 'ldconfig') ? ok(machine.ldconfig ?? '') : fail(127, 'not found')
      if (file.endsWith('moss-infer-hip')) {
        const hip = machine.hipList ?? 'no HIP devices\n'
        return typeof hip === 'string' ? ok(hip) : hip
      }
      const vk = machine.vulkan
      if (vk === null || vk === undefined) return fail(127, 'not found')
      return typeof vk === 'string' ? ok(vk) : vk
    }),
    readFile: (path) => files[path] ?? null,
    readdir: (path) => {
      const prefix = path.endsWith('/') ? path : `${path}/`
      return [...new Set(Object.keys(files).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length).split('/')[0]!))]
    },
    exists: (path) => path in files,
    readWrite: (path) => (machine.rw ?? []).includes(path),
    hipBinary: () => machine.hipBinary ?? null,
    nvidia: async () => {
      if (machine.nvidia instanceof Error) throw machine.nvidia
      return machine.nvidia ?? []
    },
    systemCuda: async () => machine.systemCuda ?? [],
    vulkanBinary: async () => {
      if (machine.vulkanBinary instanceof Error) throw machine.vulkanBinary
      return machine.vulkanBinary === undefined ? '/probe/bin/moss-infer-vulkan' : machine.vulkanBinary
    },
  }
}

const kfd = (node: number, gfx: number, device: number): Record<string, string> => ({
  [`/sys/class/kfd/kfd/topology/nodes/${node}/properties`]: `simd_count 192\ngfx_target_version ${gfx}\nvendor_id 4098\ndevice_id ${device}\n`,
})

describe('probeEngineMachine', () => {
  it('matches nvidia-smi rows to Vulkan devices by PCI id (the real RTX 4090 output)', async () => {
    const d = deps({
      nvidia: [{ ...RTX, pciId: '10de:2757', name: 'NVIDIA GeForce RTX 4090 Laptop GPU' }],
      vulkan: 'device 0: NVIDIA GeForce RTX 4090 Laptop GPU [10de:2757] discrete\n  kernels: coop\n',
      systemCuda: ['cu13'],
    })
    const probe = await probeEngineMachine(d)
    expect(probe.machine).toEqual({
      os: 'linux',
      gpus: [{
        id: 'GPU-rtx', name: 'NVIDIA GeForce RTX 4090 Laptop GPU', vendor: 'nvidia', pciId: '10de:2757', memoryBytes: 24,
        computeCapability: { major: 8, minor: 9 }, driverVersion: '590.48.01', vulkan: { index: 0, usable: true, discrete: true, name: 'NVIDIA GeForce RTX 4090 Laptop GPU', kernels: 'coop' },
      }],
      systemCuda: ['cu13'], rocm7: false, hipAccess: false, vulkanProbed: true,
    })
    // Every probe runs a program with an argument array and a timeout.
    expect(d.calls).toEqual(expect.arrayContaining([
      { file: '/probe/bin/moss-infer-vulkan', args: ['--list-devices'], timeoutMs: 15_000 },
      { file: 'ldconfig', args: ['-p'], timeoutMs: 6000 },
    ]))
  })

  it('a mixed Linux box: NVIDIA, AMD with its gfx target and ROCm 7, Intel, and no llvmpipe', async () => {
    const probe = await probeEngineMachine(deps({
      nvidia: [RTX],
      vulkan: [
        'device 0: AMD Radeon RX 7900 XTX (RADV NAVI31) [1002:744c] discrete', '  kernels: coop-f16',
        'device 1: NVIDIA GeForce RTX 4090 [10de:2684] discrete', '  kernels: coop',
        'device 2: AMD Radeon RX 7900 XTX (RADV NAVI31) [1002:744c] discrete', '  kernels: coop-f16',
        'device 3: Intel(R) Arc(TM) A770 Graphics (DG2) [8086:56a0] discrete', '  kernels: plain',
        'device 4: llvmpipe (LLVM 19.1.7, 256 bits) [10005:0000]', '  kernels: plain',
      ].join('\n'),
      files: { ...kfd(1, 110000, 0x744c), ...kfd(2, 110000, 0x744c), '/opt/rocm/lib/libamdhip64.so.7': '', '/dev/dri/renderD128': '', '/dev/dri/card0': '' },
      ldconfig: '\tlibamdhip64.so.7 (libc6,x86-64) => /opt/rocm-7.0.2/lib/libamdhip64.so.7\n',
      ldconfigAt: '/sbin/ldconfig',
      rw: ['/dev/kfd', '/dev/dri/renderD128'],
    }))
    expect(probe.machine.gpus.map((gpu) => [gpu.id, gpu.vendor, gpu.vulkan?.index, gpu.gfxTarget])).toEqual([
      ['GPU-rtx', 'nvidia', 1, undefined],
      ['vk-1002-744c-0', 'amd', 0, 'gfx1100'],
      ['vk-1002-744c-1', 'amd', 2, 'gfx1100'],
      ['vk-8086-56a0-0', 'intel', 3, undefined],
    ])
    expect(probe.machine).toMatchObject({ rocm7: true, hipAccess: true })
    expect(probe.rocmLibDir).toBe('/opt/rocm-7.0.2/lib')
    expect(probe.vulkanDevices).toHaveLength(5)
  })

  it('finds ROCm 7 under /opt/rocm-* when ldconfig does not list it', async () => {
    const probe = await probeEngineMachine(deps({ vulkan: 'no Vulkan devices\n', files: { '/opt/rocm-7.1.0/lib/libamdhip64.so.7': '' } }))
    expect(probe).toMatchObject({ rocmLibDir: '/opt/rocm-7.1.0/lib', machine: { rocm7: true, gpus: [] } })
    const none = await probeEngineMachine(deps({ vulkan: 'no Vulkan devices\n', files: { '/opt/rocm-6.4.0/lib/libamdhip64.so.6': '' } }))
    expect(none.machine.rocm7).toBe(false)
  })

  it('without the Vulkan probe: AMD from KFD, Intel from DRM, usability unknown', async () => {
    const probe = await probeEngineMachine(deps({
      nvidia: [RTX],
      vulkan: fail(2, 'vkCreateInstance failed', false),
      files: {
        ...kfd(1, 120001, 0x7550),
        '/sys/class/drm/card0/device/vendor': '0x8086\n', '/sys/class/drm/card0/device/device': '0x46a6\n',
        '/sys/class/drm/card1/device/vendor': '0x10de\n', '/sys/class/drm/card1/device/device': '0x2684\n',
        '/sys/class/drm/card2/device/vendor': '0x1002\n', '/sys/class/drm/card2/device/device': '0x7550\n',
        '/sys/class/drm/card0-DP-1/device/vendor': '0x8086\n',
      },
    }))
    expect(probe.machine.vulkanProbed).toBe(false)
    expect(probe.machine.gpus.map((gpu) => [gpu.id, gpu.vendor, gpu.gfxTarget, gpu.vulkan])).toEqual([
      ['GPU-rtx', 'nvidia', undefined, undefined],
      ['vk-1002-7550-0', 'amd', 'gfx1201', undefined],
      ['vk-8086-46a6-0', 'intel', undefined, undefined],
    ])
    expect(probe.notes.join(' ')).toContain('退出码 2')
  })

  it('degrades when probes fail or time out', async () => {
    const timedOut = await probeEngineMachine(deps({ nvidia: new Error('nvidia-smi 失败'), vulkan: fail(-1, '', true) }))
    expect(timedOut.machine.gpus).toEqual([])
    expect(timedOut.notes.join(' ')).toMatch(/nvidia-smi 失败[\s\S]*超时/)
    const noBinary = await probeEngineMachine(deps({ nvidia: [RTX], vulkanBinary: new Error('offline') }))
    expect(noBinary.machine).toMatchObject({ vulkanProbed: false, gpus: [{ id: 'GPU-rtx' }] })
    expect(noBinary.notes[0]).toContain('offline')
  })

  it('Windows: no sysfs, no ROCm, Vulkan only', async () => {
    const d = deps({ platform: 'win32', vulkan: 'device 0: Intel(R) Arc(TM) A770 Graphics [8086:56a0] discrete\n  kernels: coop\n' })
    const probe = await probeEngineMachine(d)
    expect(probe.machine).toMatchObject({ os: 'windows', rocm7: false, gpus: [{ id: 'vk-8086-56a0-0', vendor: 'intel' }] })
    expect(d.calls.some((call) => call.file === 'ldconfig')).toBe(false)
  })

  it('macOS: nothing to probe', async () => {
    const d = deps({ platform: 'darwin' })
    expect((await probeEngineMachine(d)).machine).toEqual({ os: 'macos', gpus: [], systemCuda: [], rocm7: false, hipAccess: false, vulkanProbed: false })
    expect(d.calls).toEqual([])
  })
})

describe('probeEngineMachine — HIP access', () => {
  const amdBox = {
    vulkan: 'device 0: AMD Radeon RX 7900 XTX [1002:744c] discrete\n  kernels: coop-f16\ndevice 1: AMD Radeon RX 7900 XTX [1002:744c] discrete\n  kernels: coop-f16\n',
    files: { ...kfd(1, 110000, 0x744c), ...kfd(2, 110000, 0x744c), '/opt/rocm/lib/libamdhip64.so.7': '', '/dev/dri/renderD128': '' },
  }

  it('without read+write on /dev/kfd or any render node, HIP is not accessible', async () => {
    expect((await probeEngineMachine(deps({ ...amdBox, rw: ['/dev/dri/renderD128'] }))).machine.hipAccess).toBe(false)
    expect((await probeEngineMachine(deps({ ...amdBox, rw: ['/dev/kfd'] }))).machine.hipAccess).toBe(false)
    expect((await probeEngineMachine(deps({ ...amdBox, rw: ['/dev/kfd', '/dev/dri/renderD128'] }))).machine.hipAccess).toBe(true)
  })

  it('an installed moss-infer-hip lists the GPUs in its own order, matched by gfx target and position', async () => {
    const d = deps({
      ...amdBox,
      hipBinary: '/e/stable-v2.2.0-hip/bin/moss-infer-hip',
      hipList: 'device 0: AMD Radeon RX 7900 XTX (gfx1100), 24.0 GiB\n  kernels: gfx1100, wmma\ndevice 1: AMD Radeon RX 7900 XTX (gfx1100), 24.0 GiB\n  unusable: out of memory\n',
    })
    const probe = await probeEngineMachine(d)
    expect(probe.machine.gpus.map((gpu) => gpu.hip)).toEqual([{ index: 0, usable: true }, { index: 1, usable: false }])
    expect(d.calls.find((call) => call.file.endsWith('moss-infer-hip'))).toMatchObject({ args: ['--list-devices'], timeoutMs: 15_000 })
  })

  it('passes a ROCm library directory outside /opt/rocm/lib to the HIP listing; a failing listing is a note', async () => {
    const d = deps({
      ...amdBox,
      files: { ...amdBox.files, '/opt/rocm/lib/libamdhip64.so.7': undefined as unknown as string },
      ldconfig: '\tlibamdhip64.so.7 (libc6,x86-64) => /opt/rocm-7.0.2/lib/libamdhip64.so.7\n',
      hipBinary: '/e/hip/bin/moss-infer-hip',
      hipList: fail(127, 'libamdhip64.so.7: cannot open'),
    })
    const probe = await probeEngineMachine(d)
    expect(d.calls.find((call) => call.file.endsWith('moss-infer-hip'))?.env).toEqual({ LD_LIBRARY_PATH: '/opt/rocm-7.0.2/lib' })
    expect(probe.machine.gpus.every((gpu) => gpu.hip === undefined)).toBe(true)
    expect(probe.notes.join(' ')).toContain('moss-infer-hip --list-devices 失败')
  })

  it('tries /sbin and /usr/sbin when ldconfig is not on PATH', async () => {
    const d = deps({ vulkan: 'no Vulkan devices\n', ldconfigAt: '/usr/sbin/ldconfig', ldconfig: '\tlibamdhip64.so.7 (libc6,x86-64) => /opt/rocm/lib/libamdhip64.so.7\n' })
    expect((await probeEngineMachine(d)).rocmLibDir).toBe('/opt/rocm/lib')
    expect(d.calls.filter((call) => call.file.endsWith('ldconfig')).map((call) => call.file)).toEqual(['ldconfig', '/sbin/ldconfig', '/usr/sbin/ldconfig'])
  })
})

describe('machine probe cache', () => {
  const dir = useTempDir()
  it('stores the probe next to the engines and reads it back after a restart', async () => {
    clearMachineProbeCache()
    const probe = await probeEngineMachine(deps({ nvidia: [RTX], vulkan: 'no Vulkan devices\n' }))
    const stored = storeMachineProbe(dir(), probe, new Date('2026-11-05T00:00:00Z'))
    expect(stored.probedAt).toBe('2026-11-05T00:00:00.000Z')
    clearMachineProbeCache()
    expect(readStoredMachineProbe(dir())).toEqual(stored)
    clearMachineProbeCache()
    expect(readStoredMachineProbe(`${dir()}/elsewhere`)).toBeNull()
  })
})

describe('stored probe vs. what nvidia-smi says now', () => {
  const stored = {
    os: 'linux' as const, systemCuda: [], rocm7: false, vulkanProbed: true,
    gpus: [
      { id: 'GPU-rtx', name: 'RTX 4090', vendor: 'nvidia' as const, computeCapability: { major: 8, minor: 9 }, driverVersion: '560.35.03' },
      { id: 'vk-1002-744c-0', name: 'RX 7900 XTX', vendor: 'amd' as const },
    ],
  }

  it('the live driver and compute capability win (a driver update moves CUDA 12 to 13 without a re-probe)', () => {
    const live = withLiveNvidia(stored, [{ uuid: 'GPU-rtx', index: 0, name: 'RTX 4090', driverVersion: '590.48.01', computeCapability: { major: 8, minor: 9 } }])
    expect(live.gpus[0]).toMatchObject({ driverVersion: '590.48.01' })
    expect(live.gpus[1]).toBe(stored.gpus[1])
    expect(withLiveNvidia(stored, [])).toBe(stored)
  })

  it('notices a card added or removed, ignoring Vulkan-only ids', () => {
    const rtx = { uuid: 'GPU-rtx', index: 0, name: 'RTX 4090' }
    expect(nvidiaSetChanged(stored, [rtx, { uuid: 'vk-1002-744c-0', index: 1, name: 'RX', vendor: 'amd' as const }])).toBe(false)
    expect(nvidiaSetChanged(stored, [rtx, { uuid: 'GPU-new', index: 1, name: 'RTX 3060' }])).toBe(true)
    expect(nvidiaSetChanged(stored, [])).toBe(true)
  })
})

