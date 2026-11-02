export type MossInferArchitecture = 'standard' | 'sm75'
export type MossInferVariant = 'system-cuda' | 'bundled'
export type MossInferFlavour = 'cu12' | 'cu13'
export const DEFAULT_MOSSINFER_FLAVOUR: MossInferFlavour = 'cu13'

/**
 * Upstream repository that publishes the MossInfer engine releases.
 *
 * The project moved from `xycld/owoinfer` to `mossimage-cpp/mossimage.cpp`;
 * GitHub still redirects the old slug, but the canonical one keeps the release
 * lookup, the CI artifact lookup and the user-facing errors pointing at the
 * repository that actually exists. Release assets keep their `mossinfer-*` names
 * and the sidecar is still `moss-server`.
 */
export const MOSSINFER_REPO = 'mossimage-cpp/mossimage.cpp'

export function nvidiaDriverMajor(version: string | undefined): number | null {
  const match = /^(\d+)(?:\.|$)/.exec(version?.trim() ?? '')
  if (!match) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : null
}

export function mossInferDriverCompatibilityError(
  flavour: MossInferFlavour,
  driverVersion: string | undefined,
): string | null {
  const driverMajor = nvidiaDriverMajor(driverVersion)
  if (flavour !== 'cu13' || driverMajor === null || driverMajor >= 580) return null
  return `当前 NVIDIA 驱动为 ${driverVersion}，无法加载 CUDA 13 引擎。请将 NVIDIA 显卡驱动更新到 R580 或更新版本后重试。`
}

export function mossInferArchitectureForComputeCapability(
  major: number,
  minor: number,
): MossInferArchitecture | null {
  if (major === 7 && minor === 5) return 'sm75'
  if (major >= 8) return 'standard'
  return null
}

export function mossInferArchiveBase(
  version: string,
  os: 'linux' | 'windows',
  flavour: MossInferFlavour,
  variant: MossInferVariant,
  architecture: MossInferArchitecture,
): string {
  const target = architecture === 'sm75' ? '-sm75' : ''
  const cuda = variant === 'system-cuda' ? '-system-cuda' : ''
  return `mossinfer-${version}-${os}-${flavour}-x86_64${target}${cuda}`
}
