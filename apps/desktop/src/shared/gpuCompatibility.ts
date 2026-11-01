import type {
  EngineGpuCompatibility,
  EngineGpuProbeSnapshot,
  GpuInventoryDevice,
} from './types'
import { matchEngineDevice, type EngineDevice } from './engineProtocol'

function compatibilityReason(reason: string | undefined, driverVersion: string | undefined): string | undefined {
  if (!reason || !/no\s+nvidia\s+driver|nvidia\s+driver.{0,30}(?:not|unavailable|load)|(?:driver|cuda).{0,30}(?:insufficient|too old|not loaded)/i.test(reason)) {
    return reason
  }
  const detectedDriver = driverVersion ? `系统检测到 NVIDIA 驱动 ${driverVersion}` : '系统能枚举到这张 NVIDIA GPU'
  return `${reason}。${detectedDriver}，但引擎未能初始化 CUDA 驱动接口。MossInfer CUDA 13 构建需要 R580 或更新版本；请更新 NVIDIA 显卡驱动后重新测试。`
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

/** 只负责把引擎 supported 结论映射到系统 GPU 快照，不再自行推断算力门槛。 */
export function mapEngineGpuProbe(
  inventory: GpuInventoryDevice[],
  candidates: EngineDevice[],
  enginePath: string,
  engineVersion?: string,
  checkedAt = new Date().toISOString(),
): EngineGpuProbeSnapshot {
  const devices: EngineGpuCompatibility[] = inventory.map((device) => {
    let candidate = matchEngineDevice(candidates, device)
    if (candidate && candidate.index !== device.index) {
      const inventoryNameMatches = inventory.filter(
        (item) => normalizedName(item.name) === normalizedName(device.name),
      )
      if (inventoryNameMatches.length !== 1) candidate = undefined
    }
    if (!candidate) {
      return { ...device, status: 'unknown', reason: '引擎 probe 未返回可唯一匹配的 GPU 结果' }
    }
    return {
      ...device,
      status: candidate.supported === true
        ? 'supported'
        : candidate.supported === false
          ? 'unsupported'
          : 'unknown',
      reason: compatibilityReason(candidate.unsupportedReason, device.driverVersion),
      freeMemoryBytes: candidate.freeMemoryBytes,
    }
  })
  return { enginePath, engineVersion, checkedAt, devices }
}
