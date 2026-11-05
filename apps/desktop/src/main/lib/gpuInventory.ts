import type { EngineMachineGpu } from '@shared/engineChoice'
import type { GpuInventoryDevice, GpuInventorySnapshot, GpuSelection } from '@shared/types'

function parseBytes(value: string | undefined): number | undefined {
  const mb = Number.parseFloat(value ?? '')
  return Number.isFinite(mb) && mb >= 0 ? Math.round(mb * 1024 * 1024) : undefined
}

/** nvidia-smi's `pci.device_id` (`0x275710DE`: device << 16 | vendor) → `10de:2757`. */
export function nvidiaPciId(value: string | undefined): string | null {
  const match = /^0x([0-9a-f]{4})([0-9a-f]{4})$/i.exec(value?.trim() ?? '')
  return match ? `${match[2]!.toLowerCase()}:${match[1]!.toLowerCase()}` : null
}

export function parseNvidiaGpuRows(output: string): GpuInventoryDevice[] {
  return output.split(/\r?\n/).filter(Boolean).flatMap((row) => {
    const [indexText, uuidText, nameText, totalText, freeText, utilizationText, driverText, pciText] =
      row.split(',').map((part) => part.trim())
    const index = Number.parseInt(indexText ?? '', 10)
    const uuid = uuidText?.trim()
    const name = nameText?.trim()
    if (!Number.isInteger(index) || !uuid || !name) return []
    const utilization = Number.parseInt(utilizationText ?? '', 10)
    return [{
      index,
      uuid,
      name,
      memoryTotalBytes: parseBytes(totalText),
      memoryFreeBytes: parseBytes(freeText),
      utilizationPercent: Number.isFinite(utilization) ? utilization : undefined,
      driverVersion: driverText && driverText !== 'N/A' ? driverText : undefined,
      ...(nvidiaPciId(pciText) ? { pciId: nvidiaPciId(pciText)! } : {}),
    }]
  })
}

export function parseNvidiaComputeCapabilities(
  output: string,
): Map<string, { major: number; minor: number }> {
  const capabilities = new Map<string, { major: number; minor: number }>()
  for (const row of output.split(/\r?\n/).filter(Boolean)) {
    const [uuid, value] = row.split(',').map((part) => part.trim())
    const match = /^(\d+)\.(\d+)$/.exec(value ?? '')
    if (uuid && match) {
      capabilities.set(uuid, { major: Number(match[1]), minor: Number(match[2]) })
    }
  }
  return capabilities
}

export function recommendedGpu(inventory: GpuInventoryDevice[]): GpuInventoryDevice | null {
  const nvidia = recommendedNvidiaGpu(inventory)
  if (nvidia) return nvidia
  // No NVIDIA GPU with a known compute capability: the first other GPU, discrete ones were listed first by Vulkan.
  return inventory.find((device) => device.vendor !== undefined) ?? null
}

function recommendedNvidiaGpu(inventory: GpuInventoryDevice[]): GpuInventoryDevice | null {
  return inventory
    .filter((device) => device.computeCapability !== undefined)
    .slice()
    .sort((a, b) => {
      const aCapability = a.computeCapability!
      const bCapability = b.computeCapability!
      return (
        bCapability.major - aCapability.major ||
        bCapability.minor - aCapability.minor ||
        (b.memoryTotalBytes ?? 0) - (a.memoryTotalBytes ?? 0) ||
        a.index - b.index
      )
    })[0] ?? null
}

export function resolveGpuSelection(
  inventory: GpuInventoryDevice[],
  selection: GpuSelection,
  canvasDeviceUuid?: string,
): GpuInventoryDevice | null {
  const uuid = canvasDeviceUuid ?? (typeof selection === 'object'
    ? selection.uuid
    : recommendedGpu(inventory)?.uuid)
  return uuid ? inventory.find((device) => device.uuid === uuid) ?? null : null
}

/**
 * The inventory plus what the engine's machine probe found: Vulkan indexes on
 * the NVIDIA rows, and the AMD / Intel / other GPUs nvidia-smi cannot list.
 */
export function mergeEngineGpus(snapshot: GpuInventorySnapshot, gpus: EngineMachineGpu[]): GpuInventorySnapshot {
  if (gpus.length === 0) return snapshot
  const byId = new Map(gpus.map((gpu) => [gpu.id, gpu]))
  const devices: GpuInventoryDevice[] = snapshot.devices.map((device) => {
    const gpu = byId.get(device.uuid)
    return gpu?.vulkan ? { ...device, vulkanIndex: gpu.vulkan.index } : device
  })
  const known = new Set(devices.map((device) => device.uuid))
  let index = devices.reduce((max, device) => Math.max(max, device.index), -1)
  for (const gpu of gpus) {
    // nvidia-smi rows are already there; an NVIDIA GPU only Vulkan saw (nouveau / NVK, no nvidia-smi) has a vk- id and is added.
    if (known.has(gpu.id) || (gpu.vendor === 'nvidia' && !gpu.id.startsWith('vk-'))) continue
    index += 1
    devices.push({
      uuid: gpu.id,
      index,
      name: gpu.name,
      vendor: gpu.vendor,
      ...(gpu.pciId ? { pciId: gpu.pciId } : {}),
      ...(gpu.memoryBytes ? { memoryTotalBytes: gpu.memoryBytes } : {}),
      ...(gpu.vulkan ? { vulkanIndex: gpu.vulkan.index } : {}),
      ...(gpu.gfxTarget ? { gfxTarget: gpu.gfxTarget } : {}),
    })
  }
  if (devices.length === snapshot.devices.length && devices.every((device, i) => device === snapshot.devices[i])) return snapshot
  const added = devices.length > snapshot.devices.length
  return {
    ...snapshot,
    ...(added && snapshot.status !== 'ok' ? { status: 'ok' as const, error: undefined } : {}),
    devices,
    recommendedGpuUuid: snapshot.recommendedGpuUuid ?? recommendedGpu(devices)?.uuid,
  }
}
