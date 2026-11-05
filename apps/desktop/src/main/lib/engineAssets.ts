import { driverMinimumLabel, driverSupports, type CudaFlavour } from '@shared/enginePackages'

export const DEFAULT_MOSSINFER_FLAVOUR: CudaFlavour = 'cu13'

/**
 * Upstream repository that publishes the MossInfer engine releases.
 *
 * The project moved from `xycld/owoinfer` to `mossimage-cpp/mossimage.cpp`;
 * GitHub still redirects the old slug, but the canonical one keeps the release
 * lookup, the CI artifact lookup and the user-facing errors pointing at the
 * repository that actually exists. Release assets keep their `mossinfer-*` names
 * and the sidecar is still `moss-server`. Asset names: shared/enginePackages.ts.
 */
export const MOSSINFER_REPO = 'mossimage-cpp/mossimage.cpp'

/**
 * Why this NVIDIA driver cannot load a build of this CUDA major (the engine
 * probe's minimums), or null when it can or when the version is unknown.
 */
export function mossInferDriverCompatibilityError(
  flavour: CudaFlavour,
  driverVersion: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const os = platform === 'win32' ? 'windows' : 'linux'
  if (!driverVersion || !/^\d+(?:\.\d+)*$/.test(driverVersion.trim())) return null
  if (driverSupports(flavour, os, driverVersion)) return null
  return `当前 NVIDIA 驱动为 ${driverVersion}，无法加载 CUDA ${flavour.slice(2)} 引擎。请将 NVIDIA 显卡驱动更新到 ${flavour === 'cu13' ? `R580（${driverMinimumLabel(flavour, os)}）` : driverMinimumLabel(flavour, os)} 或更新版本后重试。`
}
