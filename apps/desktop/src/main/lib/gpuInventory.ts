import type { GpuInventoryDevice, GpuSelection } from '@shared/types'

function parseBytes(value: string | undefined): number | undefined {
  const mb = Number.parseFloat(value ?? '')
  return Number.isFinite(mb) && mb >= 0 ? Math.round(mb * 1024 * 1024) : undefined
}

export function parseNvidiaGpuRows(output: string): GpuInventoryDevice[] {
  return output.split(/\r?\n/).filter(Boolean).flatMap((row) => {
    const [indexText, uuidText, nameText, totalText, freeText, utilizationText, driverText] =
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
