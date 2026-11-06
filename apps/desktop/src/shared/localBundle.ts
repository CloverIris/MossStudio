import type { ModelBundle, ModelEntry } from './types'

/**
 * A bundle made of files the user already has on disk.
 *
 * A scanned ComfyUI tree registers single-file components in place; when a DiT,
 * a text encoder and a VAE are all available the Models page offers them as one
 * bundle. The engine receives the three files as `dit_file` /
 * `text_encoder_file` / `vae_file`, so nothing is copied, linked or re-downloaded.
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
    support: '',
    recommended: false,
  }
}
