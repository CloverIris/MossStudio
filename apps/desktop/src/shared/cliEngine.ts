import type { EngineFeatures, ModelBundle, ModelEntry } from './types'

/**
 * The one-shot CLI engines of a MossInfer release: `moss-infer-vulkan`
 * (Windows + Linux, any Vulkan GPU) and `moss-infer-hip` (Linux, AMD through
 * ROCm 7). Each runs one text-to-image job per process with the euler sampler
 * on the bundle's bf16 files; nothing else the server does is available.
 */

export type CliEngineKind = 'vulkan' | 'hip'

export const CLI_ENGINE_KINDS: readonly CliEngineKind[] = ['vulkan', 'hip']

/** The one sampler and schedule the CLI runs (the official euler with the MOSS schedule). */
export const CLI_SAMPLER = 'euler'
export const CLI_SCHEDULER = 'moss'

/**
 * Whether a job's sampler/scheduler choice is one a CLI engine runs: none, or
 * exactly its own euler / moss.
 */
export function cliSamplingAccepted(sampling: { sampler?: string; scheduler?: string } | undefined): boolean {
  return (!sampling?.sampler || sampling.sampler === CLI_SAMPLER) && (!sampling?.scheduler || sampling.scheduler === CLI_SCHEDULER)
}

/** What the UI calls each CLI engine. */
export const CLI_ENGINE_LABEL: Record<CliEngineKind, string> = {
  vulkan: '兼容模式',
  hip: 'AMD 原生',
}

/** The quiet explanation next to the inputs the Studio hides for a CLI engine. */
export function cliEngineNote(kind: CliEngineKind): string {
  return `这台设备用${CLI_ENGINE_LABEL[kind]}引擎，只能文生图：LoRA、起始图、遮罩、控制、参考图、高清修复和更换采样器都不可用。`
}

export function isCliEngineKind(value: unknown): value is CliEngineKind {
  return value === 'vulkan' || value === 'hip'
}

/** A CLI engine's features: text to image only, no preview, no LoRA. */
export function cliEngineFeatures(kind: CliEngineKind): EngineFeatures {
  return {
    preview: false,
    imageInput: false,
    control: false,
    references: false,
    hires: false,
    samplers: false,
    lora: false,
    cli: kind,
    values: { sampler: [CLI_SAMPLER], scheduler: [CLI_SCHEDULER] },
  }
}

/**
 * Why a bundle cannot run on a CLI engine, or null when it can. The CLI reads
 * a diffusers folder (`transformer/`, `text_encoder/`, `vae/`, `tokenizer/`)
 * and refuses a DiT or text encoder that is not bf16; single files found by a
 * folder scan are not a bundle folder. A part the catalog does not describe
 * cannot be checked, so it is refused too (main also reads the files' dtypes).
 */
export function cliBundleProblem(
  kind: CliEngineKind,
  bundle: Pick<ModelBundle, 'name' | 'components'>,
  models: readonly Pick<ModelEntry, 'id' | 'provider' | 'format' | 'precision' | 'role'>[],
): string | null {
  const parts = [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae]
    .map((id) => models.find((model) => model.id === id))
  if (parts.some((model) => !model)) {
    return `「${bundle.name}」的模型文件不在模型库里，无法确认它是 bf16 模型包，${CLI_ENGINE_LABEL[kind]}引擎用不了，请在模型库下载 MOSS-Image（bf16）`
  }
  if (parts.some((model) => model!.provider === 'local' || model!.format === 'comfyui')) {
    return `「${bundle.name}」是扫描到的单个模型文件，${CLI_ENGINE_LABEL[kind]}引擎只能用完整的模型包，请在模型库下载 MOSS-Image（bf16）`
  }
  const [dit, textEncoder] = parts
  if (dit!.precision !== 'bf16' || textEncoder!.precision !== 'bf16') {
    return `「${bundle.name}」不是 bf16 模型，${CLI_ENGINE_LABEL[kind]}引擎只能用 bf16 的 MOSS-Image，请换一个模型`
  }
  return null
}
