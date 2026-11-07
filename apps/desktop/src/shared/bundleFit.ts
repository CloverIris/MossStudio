import { gpuRequiresBf16Tier, type ResolvedGpuProfile } from './gpuProfile'
import type { GpuInventoryDevice, ModelBundle, ModelEntry, Settings } from './types'

/**
 * Which models fit which computer. Pure, shared by main (job start, first-run
 * setup) and the renderer (模型 page, Studio), so they never disagree.
 */

/** The catalog entry holding the configs and tokenizer every single-file bundle loads next to. */
export const RUNTIME_CONFIG_ID = 'moss-runtime-config'

/** Below this much VRAM the INT8 model is the better everyday pick (the bf16 model peaks near 12 GiB). */
export const LIMITED_VRAM_BYTES = 16 * 1024 ** 3

/**
 * A bundle made of single weight files (ComfyUI layout, downloaded or found on
 * disk). The engine loads them as `dit_file` / `text_encoder_file` / `vae_file`
 * next to the runtime-config folder; only this computer's engine does that.
 */
export function isFileBundle(
  bundle: Pick<ModelBundle, 'components'>,
  models: readonly Pick<ModelEntry, 'id' | 'provider' | 'format'>[],
): boolean {
  return [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae].some((id) => {
    const model = models.find((entry) => entry.id === id)
    return model?.provider === 'local' || model?.format === 'comfyui'
  })
}

const isNvidia = (device: GpuInventoryDevice): boolean => !device.vendor || device.vendor === 'nvidia'

/** Why a bundle cannot run on this GPU, or null when it can. */
export function bundleGpuProblem(bundle: Pick<ModelBundle, 'tier' | 'requires'>, device: GpuInventoryDevice): string | null {
  const need = bundle.requires
  if (need) {
    const have = device.computeCapability
    if (!isNvidia(device) || !have || have.major !== need.computeCapability.major || have.minor !== need.computeCapability.minor) {
      return `只能在 ${need.label}上运行`
    }
  }
  if (bundle.tier) {
    if (!isNvidia(device)) return '需要 NVIDIA 显卡'
    if (gpuRequiresBf16Tier(device)) return `在 ${device.name} 上用不了，这张显卡只能运行官方模型`
  }
  return null
}

/**
 * Why a bundle runs on none of these GPUs, or null when one of them can run it
 * (or none is known yet: nothing is ruled out before the GPUs are read).
 */
export function bundleGpusProblem(bundle: Pick<ModelBundle, 'tier' | 'requires'>, devices: readonly GpuInventoryDevice[]): string | null {
  if (!devices.length) return null
  const problems = devices.map((device) => bundleGpuProblem(bundle, device))
  return problems.includes(null) ? null : problems[0]!
}

/** The GPUs this computer generates on: the one picked in 设置, otherwise every enabled one. */
export function generationGpus(
  devices: readonly GpuInventoryDevice[] | undefined,
  settings: Pick<Settings, 'gpuSelection' | 'disabledDevices'> | null | undefined,
): GpuInventoryDevice[] {
  const enabled = (devices ?? []).filter((device) => !settings?.disabledDevices?.includes(device.uuid))
  const selection = settings?.gpuSelection
  if (selection && selection !== 'auto') {
    const picked = enabled.find((device) => device.uuid === selection.uuid)
    if (picked) return [picked]
  }
  return enabled
}

export interface BestBundle {
  bundle: ModelBundle
  /** Why it suits this computer, in plain words; null when nothing about the GPU is known. */
  reason: string | null
}

/**
 * The certified model that suits this computer best: one made for its GPU
 * (NVFP4 on an RTX 50), the INT8 model when VRAM is limited, otherwise the
 * catalog's recommended official model. Without a known NVIDIA GPU it is the
 * recommended one.
 */
export function bestBundleFor(bundles: readonly ModelBundle[], devices: readonly GpuInventoryDevice[]): BestBundle | null {
  const certified = bundles.filter((bundle) => bundle.certified)
  const fallback =
    certified.find((bundle) => bundle.recommended) ?? bundles.find((bundle) => bundle.recommended) ?? certified[0] ?? bundles[0]
  if (!fallback) return null
  const gpu = devices
    .filter(isNvidia)
    .sort((a, b) => (b.memoryTotalBytes ?? 0) - (a.memoryTotalBytes ?? 0))
    .at(0)
  if (!gpu) return { bundle: fallback, reason: null }
  const runnable = certified.filter((bundle) => bundleGpuProblem(bundle, gpu) === null)
  const made = runnable.find((bundle) => bundle.requires)
  if (made) return { bundle: made, reason: `为 ${gpu.name} 这类显卡做的版本，速度最快` }
  const memory = gpu.memoryTotalBytes
  if (memory !== undefined && memory > 0 && memory < LIMITED_VRAM_BYTES) {
    const limited = runnable.find((bundle) => bundle.recommendedFor === 'limited-vram')
    if (limited) return { bundle: limited, reason: `${gpu.name} 显存不算多，这个版本更省显存，也更快` }
  }
  return { bundle: fallback, reason: `${gpu.name} 显存充足，可以用画质最原汁原味的官方模型` }
}

/**
 * The GPU profile a job runs with: a quantized model needs its own tier (INT8:
 * high; INT4 and NVFP4: turbo), whatever 设置 says; any other model keeps the
 * profile resolved for the GPU.
 */
export function profileForBundle(profile: ResolvedGpuProfile, bundle: Pick<ModelBundle, 'tier'> | null | undefined): ResolvedGpuProfile {
  return bundle?.tier ? { ...profile, tier: bundle.tier, source: 'bundle' } : profile
}
