import { RUNTIME_CONFIG_ID } from './bundleFit'
import type { ModelBundle, ModelEntry } from './types'

/**
 * A bundle made of files the user already has on disk.
 *
 * A scanned ComfyUI tree registers single-file components in place; when a DiT,
 * a text encoder and a VAE are all available the Models page offers them as one
 * bundle. The engine receives the three files as `dit_file` /
 * `text_encoder_file` / `vae_file`, so nothing is copied, linked or re-downloaded;
 * it still needs the configs and tokenizer of the small runtime-config download.
 */
export function localFilesBundle(models: readonly ModelEntry[]): ModelBundle | null {
  const pick = (role: ModelEntry['role']): ModelEntry | undefined =>
    models.find((model) => model.provider === 'local' && model.role === role && model.installed)
  const dit = pick('dit')
  const textEncoder = pick('text_encoder')
  const vae = pick('vae')
  if (!dit || !textEncoder || !vae) return null
  return {
    id: 'local-files',
    name: '本地文件（扫描）',
    description: '直接使用你添加到模型库的本地文件，不复制、不下载。',
    components: { dit: dit.id, textEncoder: textEncoder.id, vae: vae.id },
    support: RUNTIME_CONFIG_ID,
    recommended: false,
    ...localDitNeeds(dit),
  }
}

const RTX_50 = { computeCapability: { major: 12, minor: 0 }, label: 'RTX 50 系列显卡' }

/**
 * The tier a scanned DiT needs, when its precision or file name says what it
 * is: INT4 and NVFP4 run only under turbo (NVFP4 on an RTX 50), INT8 and GGUF
 * files under high. Unknown files keep the tier from 设置.
 */
export function localDitNeeds(dit: Pick<ModelEntry, 'name' | 'precision' | 'localPath' | 'files'>): Pick<ModelBundle, 'tier' | 'requires'> {
  const text = [dit.precision, dit.name, dit.localPath, ...(dit.files ?? [])].join(' ').toLowerCase()
  if (/nvfp4/.test(text)) return { tier: 'turbo', requires: RTX_50 }
  if (/int4/.test(text)) return { tier: 'turbo' }
  if (/int8|\.gguf\b/.test(text)) return { tier: 'high' }
  return {}
}
