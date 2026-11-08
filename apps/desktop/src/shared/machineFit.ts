import type { EngineMachine, EngineMachineGpu, EnginePlan } from './engineChoice'

/**
 * Whether this computer can run MossStudio well, beyond "does an engine run on
 * its GPU" (engineChoice): GPU memory, system memory and disk space. Pure; the
 * first-run page turns the answers into words.
 */

const GiB = 1024 ** 3

/**
 * Below this much GPU memory the computer cannot run MossStudio. MossInfer's
 * leanest measured runs (min_memory at 1024², MossInfer docs/experiment-log.md
 * E14 and AC8) peak at about 2 GiB, and the desktop and other apps keep their
 * own share of the card on top of that.
 */
export const MIN_GPU_MEMORY_BYTES = 4 * GiB

/**
 * Below this it runs, slowly: under 8 GiB the engine cannot keep the DiT on the
 * card and streams its blocks from system memory every step (experiment-log E14,
 * the 8 GiB mode).
 */
export const SLOW_GPU_MEMORY_BYTES = 8 * GiB

/**
 * Below this it runs, slowly: streamed DiT blocks must come from RAM, and on a
 * PC with 16 GiB or less they fall back to disk speed (experiment-log, P4 rates).
 * Only a warning: the figure is an estimate, not a measured floor.
 */
export const SLOW_SYSTEM_MEMORY_BYTES = 16 * GiB

/** Memory in whole GB, as people know it: a 16 GB computer reports 15.6 GiB, an 8 GB card 8192 MiB. */
export function memoryGb(bytes: number): number {
  return Math.round(bytes / GiB)
}

function below(bytes: number, threshold: number): boolean {
  return memoryGb(bytes) < threshold / GiB
}

/**
 * The card's own memory, or null when it is not known. nvidia-smi reports real
 * VRAM; an integrated GPU's memory is a share of system RAM, so it never counts.
 */
export function dedicatedGpuMemory(gpu: Pick<EngineMachineGpu, 'memoryBytes' | 'vulkan'>): number | null {
  if (gpu.vulkan?.discrete === false) return null
  return gpu.memoryBytes && gpu.memoryBytes > 0 ? gpu.memoryBytes : null
}

/**
 * The GPU that is too small, when every GPU the plan runs on has known memory
 * under MIN_GPU_MEMORY_BYTES (the biggest of them). A GPU whose memory is not
 * known may be big enough, so it never blocks.
 */
export function tooLittleGpuMemory(plan: Pick<EnginePlan, 'choices'> & { machine: EngineMachine }): { name: string; bytes: number } | null {
  let best: { name: string; bytes: number } | null = null
  for (const choice of plan.choices) {
    if (!choice.package) continue
    const gpu = plan.machine.gpus.find((item) => item.id === choice.gpuId)
    const bytes = gpu ? dedicatedGpuMemory(gpu) : null
    if (bytes === null) return null
    if (!best || bytes > best.bytes) best = { name: choice.gpuName, bytes }
  }
  return best && below(best.bytes, MIN_GPU_MEMORY_BYTES) ? best : null
}

export type SlowReason = { kind: 'compatibility' } | { kind: 'gpuMemory'; bytes: number } | { kind: 'systemMemory'; bytes: number }

/**
 * Why the computer will run, but slowly: only the most important reason.
 * 兼容模式 (the Vulkan engine) first, then GPU memory, then system memory.
 */
export function slowReason(input: {
  compatibility: boolean
  gpuMemoryBytes: number | null | undefined
  systemMemoryBytes: number | null | undefined
}): SlowReason | null {
  if (input.compatibility) return { kind: 'compatibility' }
  const gpu = input.gpuMemoryBytes
  if (gpu && gpu > 0 && below(gpu, SLOW_GPU_MEMORY_BYTES)) return { kind: 'gpuMemory', bytes: gpu }
  const system = input.systemMemoryBytes
  if (system && system > 0 && below(system, SLOW_SYSTEM_MEMORY_BYTES)) return { kind: 'systemMemory', bytes: system }
  return null
}

/** Free space a download of `bytes` asks for: a tenth more for what unpacking and verifying need. */
export function freeSpaceNeeded(bytes: number): number {
  return bytes * 1.1
}
