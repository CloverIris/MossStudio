import { describe, expect, it } from 'vitest'
import { parseVulkanDeviceList, vulkanGpus } from '@main/lib/vulkanDevices'
import { drmPciId, gfxTargetName, hasRocm7Runtime, kfdGpuNodes, parseKfdProperties, pciIdOf } from '@main/lib/amdGpus'
import { mergeEngineGpus, nvidiaPciId, parseNvidiaGpuRows, recommendedGpu } from '@main/lib/gpuInventory'

/** Captured from moss-infer-vulkan 2.2.0 --list-devices on an RTX 4090 Laptop GPU (Linux). */
const REAL_RTX_4090 = 'device 0: NVIDIA GeForce RTX 4090 Laptop GPU [10de:2757] discrete\n  kernels: coop\n'

describe('parseVulkanDeviceList', () => {
  it('reads the real output of moss-infer-vulkan', () => {
    expect(parseVulkanDeviceList(REAL_RTX_4090)).toEqual([
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 4090 Laptop GPU',
        vendorId: 0x10de,
        deviceId: 0x2757,
        pciId: '10de:2757',
        discrete: true,
        usable: true,
        kernels: 'coop',
        cpu: false,
      },
    ])
  })

  it('reads integrated, unusable and software devices', () => {
    const devices = parseVulkanDeviceList(
      [
        'device 0: AMD Radeon RX 7900 XTX (RADV NAVI31) [1002:744c] discrete',
        '  kernels: coop-f16',
        'device 1: Intel(R) Graphics (ADL GT2) [8086:46a6]',
        '  kernels: plain (no coop: no VK_KHR_cooperative_matrix)',
        'device 2: Intel(R) HD Graphics 530 [8086:1912]',
        '  unusable: needs Vulkan 1.2',
        'device 3: llvmpipe (LLVM 19.1.7, 256 bits) [10005:0000]',
        '  kernels: plain',
      ].join('\r\n'),
    )
    expect(
      devices.map((device) => [device.index, device.pciId, device.discrete, device.usable, device.kernels ?? device.reason, device.cpu]),
    ).toEqual([
      [0, '1002:744c', true, true, 'coop-f16', false],
      [1, '8086:46a6', false, true, 'plain', false],
      [2, '8086:1912', false, false, 'needs Vulkan 1.2', false],
      [3, '10005:0000', false, true, 'plain', true],
    ])
    expect(vulkanGpus(devices).map((device) => device.index)).toEqual([0, 1, 2])
  })

  it('an empty list and garbage give no devices; a device without a second line is not usable', () => {
    expect(parseVulkanDeviceList('no Vulkan devices\n')).toEqual([])
    expect(parseVulkanDeviceList('vulkan: error\nsomething else')).toEqual([])
    expect(parseVulkanDeviceList('device 0: X [1234:5678]')[0]).toMatchObject({ usable: false, discrete: false })
  })
})

describe('AMD sysfs', () => {
  const props = (gfx: number, vendor = 4098, device = 29772): string =>
    `cpu_cores_count 0\nsimd_count 192\ngfx_target_version ${gfx}\nvendor_id ${vendor}\ndevice_id ${device}\nlocation_id 768\n`

  it('names gfx targets from gfx_target_version', () => {
    expect(gfxTargetName(110000)).toBe('gfx1100')
    expect(gfxTargetName(110001)).toBe('gfx1101')
    expect(gfxTargetName(120000)).toBe('gfx1200')
    expect(gfxTargetName(120001)).toBe('gfx1201')
    expect(gfxTargetName(90010)).toBe('gfx90a')
    expect(gfxTargetName(90402)).toBe('gfx942')
    expect(gfxTargetName(0)).toBeNull()
    expect(gfxTargetName(-1)).toBeNull()
  })

  it('keeps only GPU nodes of the KFD topology, in node order', () => {
    const nodes = kfdGpuNodes([
      { node: 2, properties: props(120001, 4098, 0x7550) },
      { node: 0, properties: 'cpu_cores_count 16\ngfx_target_version 0\nvendor_id 0\n' },
      { node: 1, properties: props(110000) },
    ])
    expect(nodes).toEqual([
      { node: 1, gfxTarget: 'gfx1100', vendorId: 0x1002, deviceId: 29772, pciId: '1002:744c' },
      { node: 2, gfxTarget: 'gfx1201', vendorId: 0x1002, deviceId: 0x7550, pciId: '1002:7550' },
    ])
    expect(parseKfdProperties('a 1\nbad line\nb -2\n')).toEqual(
      new Map([
        ['a', 1],
        ['b', -2],
      ]),
    )
  })

  it('reads DRM PCI ids and finds ROCm 7', () => {
    expect(drmPciId('0x1002\n', '0x744c\n')).toBe('1002:744c')
    expect(drmPciId('0x8086', 'nope')).toBeNull()
    expect(pciIdOf(0x10de, 0x2757)).toBe('10de:2757')
    expect(hasRocm7Runtime('\tlibamdhip64.so.7 (libc6,x86-64) => /opt/rocm/lib/libamdhip64.so.7\n')).toBe(true)
    expect(hasRocm7Runtime('\tlibamdhip64.so.6 (libc6,x86-64) => /opt/rocm-6.4.0/lib/libamdhip64.so.6\n')).toBe(false)
  })
})

describe('NVIDIA PCI ids and the merged inventory', () => {
  it('reads pci.device_id from nvidia-smi', () => {
    expect(nvidiaPciId('0x275710DE')).toBe('10de:2757')
    expect(nvidiaPciId('N/A')).toBeNull()
    const [row] = parseNvidiaGpuRows('0, GPU-a, NVIDIA GeForce RTX 4090 Laptop GPU, 16376, 15000, 3, 615.78.08, 0x275710DE\n')
    expect(row).toMatchObject({ uuid: 'GPU-a', driverVersion: '615.78.08', pciId: '10de:2757' })
    // Older rows without the column still parse.
    expect(parseNvidiaGpuRows('0, GPU-a, RTX, 1, 1, 1, 560.10\n')[0]!.pciId).toBeUndefined()
  })

  it('adds the GPUs nvidia-smi cannot list and Vulkan indexes', () => {
    const snapshot = {
      scannedAt: '',
      status: 'ok' as const,
      devices: [{ uuid: 'GPU-a', index: 0, name: 'RTX 4090', computeCapability: { major: 8, minor: 9 } }],
      recommendedGpuUuid: 'GPU-a',
    }
    const merged = mergeEngineGpus(snapshot, [
      { id: 'GPU-a', name: 'RTX 4090', vendor: 'nvidia', vulkan: { index: 1, usable: true, discrete: true } },
      {
        id: 'vk-1002-744c-0',
        name: 'RX 7900 XTX',
        vendor: 'amd',
        pciId: '1002:744c',
        gfxTarget: 'gfx1100',
        vulkan: { index: 0, usable: true, discrete: true },
      },
    ])
    expect(merged.devices).toEqual([
      { uuid: 'GPU-a', index: 0, name: 'RTX 4090', computeCapability: { major: 8, minor: 9 }, vulkanIndex: 1 },
      { uuid: 'vk-1002-744c-0', index: 1, name: 'RX 7900 XTX', vendor: 'amd', pciId: '1002:744c', vulkanIndex: 0, gfxTarget: 'gfx1100' },
    ])
    expect(merged.recommendedGpuUuid).toBe('GPU-a')
  })

  it("replaces nvidia-smi's pick when it is too small and the probe found a GPU that can run", () => {
    const snapshot = {
      scannedAt: '',
      status: 'ok' as const,
      devices: [{ uuid: 'GPU-mx', index: 0, name: 'MX250', memoryTotalBytes: 2 * 1024 ** 3, computeCapability: { major: 6, minor: 1 } }],
      recommendedGpuUuid: 'GPU-mx',
    }
    const merged = mergeEngineGpus(snapshot, [
      { id: 'GPU-mx', name: 'MX250', vendor: 'nvidia', vulkan: { index: 0, usable: true, discrete: true } },
      { id: 'vk-8086-5917-0', name: 'UHD 620', vendor: 'intel', pciId: '8086:5917', vulkan: { index: 1, usable: true, discrete: false } },
    ])
    expect(merged.recommendedGpuUuid).toBe('vk-8086-5917-0')
  })

  it('an AMD-only machine gets an ok inventory with the AMD GPU recommended', () => {
    const merged = mergeEngineGpus({ scannedAt: '', status: 'unavailable', devices: [], error: '未找到 nvidia-smi' }, [
      { id: 'vk-1002-744c-0', name: 'RX 7900 XTX', vendor: 'amd', pciId: '1002:744c' },
    ])
    expect(merged).toMatchObject({ status: 'ok', error: undefined, recommendedGpuUuid: 'vk-1002-744c-0' })
    expect(recommendedGpu([])).toBeNull()
  })

  it('adds an NVIDIA GPU only Vulkan saw (no nvidia-smi), but not a stale nvidia-smi row', () => {
    const merged = mergeEngineGpus({ scannedAt: '', status: 'unavailable', devices: [] }, [
      {
        id: 'vk-10de-1e87-0',
        name: 'NVIDIA GeForce RTX 2080 (NVK TU104)',
        vendor: 'nvidia',
        pciId: '10de:1e87',
        vulkan: { index: 0, usable: true, discrete: true },
      },
      { id: 'GPU-gone', name: 'RTX 4090', vendor: 'nvidia' },
    ])
    expect(merged.devices).toEqual([
      {
        uuid: 'vk-10de-1e87-0',
        index: 0,
        name: 'NVIDIA GeForce RTX 2080 (NVK TU104)',
        vendor: 'nvidia',
        pciId: '10de:1e87',
        vulkanIndex: 0,
      },
    ])
    expect(merged).toMatchObject({ status: 'ok', recommendedGpuUuid: 'vk-10de-1e87-0' })
  })

  it('returns the same snapshot when there is nothing to add', () => {
    const snapshot = { scannedAt: '', status: 'ok' as const, devices: [] }
    expect(mergeEngineGpus(snapshot, [])).toBe(snapshot)
  })
})
