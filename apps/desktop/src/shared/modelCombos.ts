import { localFilesBundle } from './localBundle'
import type { ModelBundle, ModelCombination, ModelEntry } from './types'

/**
 * 自己组合: a 主模型, a 文本编码器 and a VAE the person picks, saved as a model.
 *
 * The engine loads one folder for the configs and tokenizer (`model`), and any
 * part may instead be a single file that replaces that part of the folder
 * (`dit_file`, `text_encoder_file`, `vae_file`). So any part mixes with any
 * other: a set of folders needs only the pipeline configs beside them, and a
 * set with a single file in it needs the full config folder.
 */

// One definition: bundleFit (certified single-file models) needs it too, and it must not import this file.
import { RUNTIME_CONFIG_ID } from './bundleFit'
export { RUNTIME_CONFIG_ID }
export const PIPELINE_ID = 'moss-pipeline'

export type SlotKey = 'dit' | 'textEncoder' | 'vae'
export const SLOTS: readonly SlotKey[] = ['dit', 'textEncoder', 'vae']
export const SLOT_ROLE: Record<SlotKey, ModelEntry['role']> = { dit: 'dit', textEncoder: 'text_encoder', vae: 'vae' }
export const SLOT_LABEL: Record<SlotKey, string> = { dit: '主模型', textEncoder: '文本编码器', vae: 'VAE' }

/** A part the engine gets as its own file rather than inside the model folder. */
export const isSingleFile = (model: Pick<ModelEntry, 'format'>): boolean => model.format === 'comfyui'

/** The config files a set of parts needs beside them. */
export function supportFor(parts: readonly Pick<ModelEntry, 'format'>[]): string {
  return parts.some(isSingleFile) ? RUNTIME_CONFIG_ID : PIPELINE_ID
}

export function choiceLabel(model: Pick<ModelEntry, 'choice' | 'name'>): string {
  return model.choice ?? model.name
}

/** The model a saved combination becomes in the catalog. */
export function combinationBundle(combination: ModelCombination, models: readonly ModelEntry[]): ModelBundle {
  const { dit, textEncoder, vae } = combination.components
  const parts = [dit, textEncoder, vae]
    .map((id) => models.find((model) => model.id === id))
    .filter((model): model is ModelEntry => Boolean(model))
  return {
    id: combination.id,
    name: combination.name,
    description: parts.map(choiceLabel).join(' + '),
    components: { dit, textEncoder, vae },
    support: supportFor(parts),
    recommended: false,
    custom: true,
  }
}

/**
 * The scanned-files model older versions made by themselves, kept as a saved
 * combination so the 画面 that use it keep working.
 */
export function legacyLocalCombination(models: readonly ModelEntry[], now = new Date()): ModelCombination | null {
  const bundle = localFilesBundle(models)
  if (!bundle) return null
  return { id: bundle.id, name: '电脑上的模型', components: { ...bundle.components }, createdAt: now.toISOString() }
}

/** Old single-file exports of the FP16-fixed weights, which the engine cannot use. */
function isLegacyFile(model: ModelEntry): boolean {
  return model.provider !== 'local' && isSingleFile(model) && (model.precision === 'fp16' || model.tags.includes('fixed'))
}

export interface SlotChoice {
  /** The entry this choice uses. */
  id: string
  label: string
  /** Every entry behind the label (a folder and a single file of the same weights). */
  ids: string[]
  sizeBytes: number
  installed: boolean
  /** One of the person's own files, used where it is. */
  local: boolean
}

/**
 * What a slot offers: each downloadable part once under its label (the copy
 * already here first, else the folder version, which the official models
 * share), then the person's own files.
 */
export function slotChoices(
  models: readonly ModelEntry[],
  slot: SlotKey,
  isInstalled: (model: ModelEntry) => boolean = (model) => model.installed,
): SlotChoice[] {
  const role = SLOT_ROLE[slot]
  const downloads = new Map<string, ModelEntry[]>()
  for (const model of models) {
    if (model.role !== role || model.provider === 'local' || isLegacyFile(model)) continue
    const label = choiceLabel(model)
    downloads.set(label, [...(downloads.get(label) ?? []), model])
  }
  const choices: SlotChoice[] = [...downloads.entries()].map(([label, entries]) => {
    const pick = entries.find(isInstalled) ?? entries.find((entry) => !isSingleFile(entry)) ?? entries[0]!
    return {
      id: pick.id,
      label,
      ids: entries.map((entry) => entry.id),
      sizeBytes: pick.sizeBytes,
      installed: isInstalled(pick),
      local: false,
    }
  })
  for (const model of models) {
    if (model.role !== role || model.provider !== 'local' || !isSingleFile(model) || !isInstalled(model)) continue
    choices.push({ id: model.id, label: model.name, ids: [model.id], sizeBytes: model.sizeBytes, installed: true, local: true })
  }
  return choices
}

/** The parts a combination needs, its config files included, without duplicates. */
export function combinationIds(components: Record<SlotKey, string>, models: readonly ModelEntry[]): string[] {
  const parts = SLOTS.map((slot) => models.find((model) => model.id === components[slot])).filter((model): model is ModelEntry =>
    Boolean(model),
  )
  return [...new Set([...SLOTS.map((slot) => components[slot]), supportFor(parts)])]
}

/** Bytes still to download for a set of parts. */
export function missingBytes(
  ids: readonly string[],
  models: readonly ModelEntry[],
  isInstalled: (model: ModelEntry) => boolean = (model) => model.installed,
): number {
  return ids.reduce((sum, id) => {
    const model = models.find((entry) => entry.id === id)
    return model && !isInstalled(model) ? sum + (model.sizeBytes || 0) : sum
  }, 0)
}

/** A name for a new combination from its 主模型 and 文本编码器, e.g. "SFT INT8 + Qwen3.5 W4A8"; an own file by its name without the extension. */
export function suggestedName(components: Record<SlotKey, string>, models: readonly ModelEntry[]): string {
  const label = (id: string): string => {
    const model = models.find((entry) => entry.id === id)
    if (!model) return ''
    return model.provider === 'local' ? model.name.replace(/\.(safetensors|gguf)$/i, '') : choiceLabel(model).replace(/^MOSS-Image /, '')
  }
  return [label(components.dit), label(components.textEncoder)].filter(Boolean).join(' + ')
}

/**
 * Downloaded parts that no model needs: in no catalog model and no saved
 * combination. The person's own files and folders are never counted.
 */
export function unusedDownloads(
  models: readonly ModelEntry[],
  bundles: readonly ModelBundle[],
  isInstalled: (model: ModelEntry) => boolean = (model) => model.installed,
): ModelEntry[] {
  const used = new Set(bundles.flatMap((bundle) => [...Object.values(bundle.components), bundle.support]))
  return models.filter(
    (model) =>
      model.provider === 'hf' && model.role !== 'full' && !model.tags.includes('local-folder') && !used.has(model.id) && isInstalled(model),
  )
}
