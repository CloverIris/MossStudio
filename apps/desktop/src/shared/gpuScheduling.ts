import type { GpuInventoryDevice } from './types'

export interface GpuLoad {
  runningTasks: number
  queuedTasks: number
}

function compareRecommendedGpu(a: GpuInventoryDevice, b: GpuInventoryDevice): number {
  return (
    (b.computeCapability?.major ?? -1) - (a.computeCapability?.major ?? -1) ||
    (b.computeCapability?.minor ?? -1) - (a.computeCapability?.minor ?? -1) ||
    (b.memoryTotalBytes ?? 0) - (a.memoryTotalBytes ?? 0) ||
    a.index - b.index
  )
}

export function selectAutomaticGpu(
  devices: GpuInventoryDevice[],
  compatibleUuids: ReadonlySet<string>,
  loads: Readonly<Record<string, GpuLoad>>,
): GpuInventoryDevice | null {
  const compatible = devices
    .filter((device) => compatibleUuids.has(device.uuid))
    .slice()
    .sort(compareRecommendedGpu)
  const idle = compatible.find((device) => {
    const load = loads[device.uuid]
    return !load || (load.runningTasks === 0 && load.queuedTasks === 0)
  })
  if (idle) return idle

  return (
    compatible.sort((a, b) => {
      const loadA = loads[a.uuid] ?? { runningTasks: 0, queuedTasks: 0 }
      const loadB = loads[b.uuid] ?? { runningTasks: 0, queuedTasks: 0 }
      return loadA.runningTasks + loadA.queuedTasks - loadB.runningTasks - loadB.queuedTasks || compareRecommendedGpu(a, b)
    })[0] ?? null
  )
}
