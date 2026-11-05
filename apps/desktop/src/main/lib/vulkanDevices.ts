/**
 * Parsing of `moss-infer-vulkan --list-devices` (vulkan/tools/moss_infer_vulkan.cpp list_devices):
 *
 *   device 0: NVIDIA GeForce RTX 4090 Laptop GPU [10de:2757] discrete
 *     kernels: coop
 *   device 1: Intel(R) Graphics [8086:a7a0]
 *     unusable: needs Vulkan 1.2
 *
 * ` discrete` is printed only for discrete GPUs (nothing for integrated ones),
 * the second line is `kernels: <coop|coop-f16|plain>[ (no coop: …)]` for a usable
 * device or `unusable: <reason>`, and an empty list prints `no Vulkan devices`.
 */

export interface VulkanDevice {
  index: number
  name: string
  vendorId: number
  deviceId: number
  /** `10de:2757` */
  pciId: string
  discrete: boolean
  usable: boolean
  kernels?: string
  reason?: string
  /** A software rasterizer (llvmpipe, SwiftShader): never a GPU to run on. */
  cpu: boolean
}

const HEADER = /^device (\d+): (.*) \[([0-9a-f]{4,8}):([0-9a-f]{4,8})\]( discrete)?\s*$/i

/** Mesa's and Google's CPU implementations, and the Vulkan "CPU" vendor id (VK_VENDOR_ID_MESA = 0x10005). */
function isCpuDevice(name: string, vendorId: number): boolean {
  return vendorId === 0x10005 || /llvmpipe|lavapipe|swiftshader/i.test(name)
}

export function parseVulkanDeviceList(stdout: string): VulkanDevice[] {
  const devices: VulkanDevice[] = []
  let currentDevice: VulkanDevice | null = null
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const header = HEADER.exec(line)
    if (header) {
      const [, index, name, vendor, device, discrete] = header
      const vendorId = Number.parseInt(vendor!, 16)
      const deviceId = Number.parseInt(device!, 16)
      currentDevice = {
        index: Number(index),
        name: name!.trim(),
        vendorId,
        deviceId,
        pciId: `${vendor!.toLowerCase().padStart(4, '0')}:${device!.toLowerCase().padStart(4, '0')}`,
        discrete: Boolean(discrete),
        // Usable once its `kernels:` line says so.
        usable: false,
        cpu: isCpuDevice(name!, vendorId),
      }
      devices.push(currentDevice)
      continue
    }
    if (!currentDevice) continue
    const detail = line.trim()
    const kernels = /^kernels: (\S+)/.exec(detail)
    if (kernels) {
      currentDevice.usable = true
      currentDevice.kernels = kernels[1]
      continue
    }
    const unusable = /^unusable: (.*)$/.exec(detail)
    if (unusable) {
      currentDevice.usable = false
      currentDevice.reason = unusable[1]!.trim()
    }
  }
  return devices
}

/** GPUs only: software rasterizers are dropped. */
export function vulkanGpus(devices: VulkanDevice[]): VulkanDevice[] {
  return devices.filter((device) => !device.cpu)
}
