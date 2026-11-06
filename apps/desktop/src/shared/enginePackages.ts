/**
 * The MossInfer release packages: what kinds exist, how their release assets
 * and install folders are named, and which NVIDIA drivers they need.
 *
 * Facts from the engine (mossimage-cpp/mossimage.cpp v2.2.0):
 * - CUDA builds (moss-server) carry SASS for sm_80, sm_89 and sm_120 plus
 *   compute_120 PTX (CMakePresets.json release-base). A device runs SASS of its
 *   own major version with a minor ≤ its own, and PTX of a lower-or-equal
 *   version (src/backend/probe.cpp compatible_image): so the standard build
 *   runs on compute capability 8.x and 12.x and newer, but NOT on 9.x
 *   (Hopper) or 10.x/11.x (data-centre Blackwell, Thor).
 * - `-sm75` (Windows CUDA 13 only) adds 75-real; `-sm70` (Linux CUDA 12 only)
 *   adds 70-real, whose SASS also runs on 7.5 (cmake/modules/backend.cmake).
 * - Driver minimums (probe.cpp min_driver_release, CUDA minor-version
 *   compatibility): CUDA 12 — Linux ≥ 525.60.13, Windows ≥ 527.41;
 *   CUDA 13 — Linux ≥ 580.65.06, Windows ≥ 580.88.
 * - moss-infer-vulkan (Linux, Windows) and moss-infer-hip (Linux; gfx1100,
 *   gfx1200, gfx1201; needs ROCm 7's libamdhip64.so.7) are one-shot CLIs.
 */

export type CudaFlavour = 'cu12' | 'cu13'
/** standard = sm_80/89/120; sm75 = + Turing (Windows CUDA 13); sm70 = + Volta and Turing (Linux CUDA 12). */
export type CudaArch = 'standard' | 'sm75' | 'sm70'
/** system-cuda loads the CUDA libraries installed on the computer; bundled ships them. */
export type CudaRuntime = 'system-cuda' | 'bundled'

export type EnginePackage =
  { kind: 'cuda'; flavour: CudaFlavour; arch: CudaArch; runtime: CudaRuntime } | { kind: 'vulkan' } | { kind: 'hip' }

export type EnginePackageKind = EnginePackage['kind']
export type EngineOs = 'windows' | 'linux' | 'macos'

export const HIP_GFX_TARGETS = ['gfx1100', 'gfx1200', 'gfx1201'] as const

/** `cu13`, `cu13-sm75-system-cuda`, `cu12-sm70`, `vulkan`, `hip`. Also the suffix of the install folder. */
export function enginePackageId(pkg: EnginePackage): string {
  if (pkg.kind !== 'cuda') return pkg.kind
  return `${pkg.flavour}${pkg.arch === 'standard' ? '' : `-${pkg.arch}`}${pkg.runtime === 'system-cuda' ? '-system-cuda' : ''}`
}

const CUDA_ID = /^(cu12|cu13)(?:-(sm75|sm70))?(-system-cuda)?$/

export function parseEnginePackageId(id: string): EnginePackage | null {
  if (id === 'vulkan' || id === 'hip') return { kind: id }
  const match = CUDA_ID.exec(id)
  if (!match) return null
  const [, flavour, arch, systemCuda] = match
  return {
    kind: 'cuda',
    flavour: flavour as CudaFlavour,
    arch: (arch ?? 'standard') as CudaArch,
    runtime: systemCuda ? 'system-cuda' : 'bundled',
  }
}

export function sameEnginePackage(a: EnginePackage, b: EnginePackage): boolean {
  return enginePackageId(a) === enginePackageId(b)
}

/** Vulkan and HIP run one job per process (moss-infer-vulkan / moss-infer-hip), not the moss-server protocol. */
export function isCliEngine(pkg: EnginePackage | EnginePackageKind): boolean {
  const kind = typeof pkg === 'string' ? pkg : pkg.kind
  return kind === 'vulkan' || kind === 'hip'
}

export function engineBinaryName(kind: EnginePackageKind, platform: string): string {
  const base = kind === 'cuda' ? 'moss-server' : kind === 'vulkan' ? 'moss-infer-vulkan' : 'moss-infer-hip'
  return platform === 'win32' ? `${base}.exe` : base
}

/** Whether the release publishes this package for this OS at all. */
export function packageExistsFor(pkg: EnginePackage, os: EngineOs): boolean {
  if (os === 'macos') return false
  if (pkg.kind === 'vulkan') return true
  if (pkg.kind === 'hip') return os === 'linux'
  if (pkg.arch === 'sm75') return os === 'windows' && pkg.flavour === 'cu13'
  if (pkg.arch === 'sm70') return os === 'linux' && pkg.flavour === 'cu12'
  return true
}

/**
 * The version inside a release's asset names. A release candidate's tag
 * (`v2.2.0-rc1`) is not in them: CPack names the archives after the header
 * version (`mossinfer-2.2.0-linux-…`). Falls back to the tag without its `v`.
 */
export function releaseAssetVersion(tag: string, assetNames: string[]): string {
  for (const name of assetNames) {
    const match = /^mossinfer-(\d+(?:\.\d+)*)-(?:linux|windows)-/.exec(name)
    if (match) return match[1]!
  }
  return tag.replace(/^v/i, '')
}

/** Every package a release publishes for this OS (CUDA flavours × archs × runtimes, Vulkan, HIP). */
export function allEnginePackages(os: EngineOs): EnginePackage[] {
  const cuda = (['cu13', 'cu12'] as const).flatMap((flavour) =>
    (['standard', 'sm75', 'sm70'] as const).flatMap((arch) =>
      (['bundled', 'system-cuda'] as const).map((runtime): EnginePackage => ({ kind: 'cuda', flavour, arch, runtime })),
    ),
  )
  const cli: EnginePackage[] = [{ kind: 'vulkan' }, { kind: 'hip' }]
  return [...cuda, ...cli].filter((pkg) => packageExistsFor(pkg, os))
}

/**
 * The release asset name, e.g. `mossinfer-2.2.0-windows-cu13-x86_64-sm75-system-cuda.zip`,
 * `mossinfer-2.2.0-linux-vulkan-x86_64.tar.gz`. Windows ships .zip, Linux .tar.gz.
 */
export function engineAssetName(version: string, os: Exclude<EngineOs, 'macos'>, pkg: EnginePackage): string {
  const v = version.replace(/^v/i, '')
  const ext = os === 'windows' ? 'zip' : 'tar.gz'
  if (pkg.kind !== 'cuda') return `mossinfer-${v}-${os}-${pkg.kind}-x86_64.${ext}`
  const arch = pkg.arch === 'standard' ? '' : `-${pkg.arch}`
  const runtime = pkg.runtime === 'system-cuda' ? '-system-cuda' : ''
  return `mossinfer-${v}-${os}-${pkg.flavour}-x86_64${arch}${runtime}.${ext}`
}

/* ------------------------------------------------------------------ */
/* NVIDIA drivers                                                      */
/* ------------------------------------------------------------------ */

const DRIVER_MINIMUM: Record<CudaFlavour, Record<'windows' | 'linux', number[]>> = {
  cu12: { linux: [525, 60, 13], windows: [527, 41] },
  cu13: { linux: [580, 65, 6], windows: [580, 88] },
}

/** `"580.65.06"` → [580, 65, 6]; null when it is not a driver version. */
export function parseDriverVersion(version: string | undefined | null): number[] | null {
  const text = version?.trim() ?? ''
  if (!/^\d+(?:\.\d+)*$/.test(text)) return null
  return text.split('.').map(Number)
}

export function driverMinimumLabel(flavour: CudaFlavour, os: 'windows' | 'linux'): string {
  const parts = DRIVER_MINIMUM[flavour][os]
  return parts.map((part, index) => (index === 2 ? String(part).padStart(2, '0') : String(part))).join('.')
}

/** Whether this NVIDIA driver can load a build of this CUDA major. Unknown drivers cannot. */
export function driverSupports(flavour: CudaFlavour, os: 'windows' | 'linux', version: string | undefined | null): boolean {
  const parts = parseDriverVersion(version)
  if (!parts) return false
  const minimum = DRIVER_MINIMUM[flavour][os]
  for (let index = 0; index < minimum.length; index += 1) {
    const have = parts[index] ?? 0
    if (have !== minimum[index]) return have > minimum[index]!
  }
  return true
}

/**
 * Whether a CUDA build of this architecture family has a kernel image for the
 * device (probe.cpp compatible_image with the release architecture lists).
 */
export function archRunsOn(arch: CudaArch, flavour: CudaFlavour, cc: { major: number; minor: number }): boolean {
  const { major, minor } = cc
  if (major === 8 || major >= 12) return true
  if (arch === 'sm75') return major === 7 && minor >= 5
  // sm70 is CUDA 12 only: CUDA 13 dropped Volta.
  if (arch === 'sm70') return flavour === 'cu12' && major === 7
  return false
}

/* ------------------------------------------------------------------ */
/* Plain-language labels                                                */
/* ------------------------------------------------------------------ */

/** Short name people see: "CUDA 13", "兼容模式", "AMD 原生". */
export function enginePackageTitle(pkg: EnginePackage): string {
  if (pkg.kind === 'vulkan') return '兼容模式'
  if (pkg.kind === 'hip') return 'AMD 原生'
  return `CUDA ${pkg.flavour.slice(2)}`
}

/** One line under the title: what this package is good and bad at. */
export function enginePackageSummary(pkg: EnginePackage): string {
  if (pkg.kind === 'vulkan') return '通用显卡模式，速度较慢，只能文生图（不支持 LoRA、起始图、遮罩、控制、参考图、高清修复和采样器选择）'
  if (pkg.kind === 'hip') return 'AMD 显卡原生运行，只能文生图（不支持 LoRA、起始图、遮罩、控制、参考图、高清修复和采样器选择）'
  const runtime = pkg.runtime === 'system-cuda' ? '使用电脑上已有的 CUDA 运行库' : '自带运行库'
  const arch = pkg.arch === 'sm75' ? '含 RTX 20 / GTX 16 系列支持，' : pkg.arch === 'sm70' ? '含 Volta / Turing 支持，' : ''
  return `全部功能，${arch}${runtime}`
}

/** Label for a package in a picker, e.g. "CUDA 13 · 自带运行库". */
export function enginePackageOptionLabel(pkg: EnginePackage): string {
  if (pkg.kind === 'vulkan') return '兼容模式（Vulkan）'
  if (pkg.kind === 'hip') return 'AMD 原生（ROCm）'
  const arch = pkg.arch === 'sm75' ? ' · SM75' : pkg.arch === 'sm70' ? ' · SM70' : ''
  return `CUDA ${pkg.flavour.slice(2)}${arch} · ${pkg.runtime === 'system-cuda' ? '系统运行库' : '自带运行库'}`
}
