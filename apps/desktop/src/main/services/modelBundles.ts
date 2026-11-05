import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelBinding, ModelBundle, Settings } from '@shared/types'
import { paths } from '../lib/paths'
import { componentSnapshot, getCatalog } from './models'
import { fileSize, linkInPlace, materialize, safePath } from './modelFiles'

export function bundleBinding(bundle: ModelBundle): ModelBinding {
  return { bundleId: bundle.id, ...bundle.components }
}

export async function validateBinding(
  binding: ModelBinding,
  settings: Settings,
): Promise<ModelBundle> {
  const catalog = await getCatalog(settings)
  const bundle = catalog.bundles.find((b) => b.id === binding.bundleId)
  if (!bundle) throw new Error('模型组合不存在，请重新选择')
  for (const [key, role] of [
    ['dit', 'dit'],
    ['textEncoder', 'text_encoder'],
    ['vae', 'vae'],
  ] as const) {
    const model = catalog.models.find((m) => m.id === binding[key])
    if (
      !model ||
      model.role !== role ||
      model.format !== 'diffusers' ||
      model.family !== 'moss-image'
    ) {
      throw new Error('请选择与 MOSS 兼容的 Diffusers 组件；ComfyUI 单文件仅支持下载')
    }
  }
  return bundle
}

/** A model source is either one materialized diffusers folder or three files. */
export interface PreparedModelSource {
  model: string | null
  ditFile?: string
  textEncoderFile?: string
  vaeFile?: string
}

/**
 * Resolve a binding to what the engine can load. A bundle whose components are
 * files registered by a directory scan (a user's ComfyUI folder) is passed as
 * `dit_file` / `text_encoder_file` / `vae_file`; nothing is copied or linked, so
 * the 27 GB set keeps living where the user installed it.
 */
export async function prepareModelSource(
  binding: ModelBinding,
  settings: Settings,
): Promise<PreparedModelSource> {
  const catalog = await getCatalog(settings)
  const bundle = catalog.bundles.find((b) => b.id === binding.bundleId)
  if (!bundle) throw new Error('模型组合不存在，请重新选择')
  const entries = [binding.dit, binding.textEncoder, binding.vae].map((id) =>
    catalog.models.find((model) => model.id === id),
  )
  const localCount = entries.filter((entry) => entry?.provider === 'local').length
  if (localCount > 0) {
    if (localCount !== 3) {
      throw new Error('本地文件组合需要同时准备 DiT、文本编码器和 VAE 三个文件')
    }
    const paths = entries.map((entry) => entry?.localPath)
    if (paths.some((path) => !path)) {
      throw new Error('本地模型缺少文件路径，请重新扫描登记')
    }
    return {
      model: null,
      ditFile: paths[0]!,
      textEncoderFile: paths[1]!,
      vaeFile: paths[2]!,
    }
  }
  return { model: await prepareModelBundle(binding, settings) }
}

export async function prepareModelBundle(
  binding: ModelBinding,
  settings: Settings,
): Promise<string> {
  const bundle = await validateBinding(binding, settings)
  const requests = [binding.dit, binding.textEncoder, binding.vae, bundle.support]
  const components = await Promise.all(requests.map((id) => componentSnapshot(id, settings)))
  const manifest = {
    version: 1,
    bundleId: binding.bundleId,
    components: components.map(({ model, record }) => ({
      id: model.id,
      role: model.role,
      repo: model.repo,
      revision: record.sha,
      precision: model.precision,
    })),
  }
  const text = JSON.stringify(manifest, null, 2)
  const key = createHash('sha256').update(text).digest('hex').slice(0, 24)
  const root = join(paths.models(settings.modelsRoot), 'bundles')
  let target = join(root, key)
  const expected: Array<{ source: string; path: string; local?: boolean }> = []
  for (const { model, record, root: snapshot, local } of components) {
    for (const file of record.entries) {
      let path: string
      if (model.role === 'support') path = file.path
      else if (model.role === 'text_encoder' && file.path.startsWith('tokenizer/')) path = file.path
      else {
        const prefix = model.subfolder ? `${model.subfolder}/` : ''
        if (!file.path.startsWith(prefix)) continue
        const folder =
          model.role === 'dit' ? 'transformer' : model.role === 'vae' ? 'vae' : 'text_encoder'
        path = `${folder}/${file.path.slice(prefix.length)}`
      }
      expected.push({ source: safePath(snapshot, file.path), path, ...(local ? { local } : {}) })
    }
  }
  const candidates = await readdir(root).catch(() => [] as string[])
  for (const name of candidates.filter(
    (name) => (name === key || name.startsWith(`${key}-`)) && !name.includes('.tmp-'),
  )) {
    const candidate = join(root, name)
    try {
      if (
        (await readFile(join(candidate, 'clover_model.json'), 'utf8')) === text &&
        (
          await Promise.all(
            expected.map(
              async (f) =>
                (await fileSize(safePath(candidate, f.path))) === (await fileSize(f.source)),
            ),
          )
        ).every(Boolean)
      )
        return candidate
    } catch {
      /* Ignore incomplete or damaged materializations. */
    }
  }
  if (candidates.includes(key)) target = join(root, `${key}-${randomUUID().slice(0, 8)}`)
  await mkdir(root, { recursive: true })
  const staging = join(root, `${key}.tmp-${randomUUID()}`)
  await mkdir(staging)
  try {
    // Files of a registered local folder are linked, never copied.
    for (const file of expected) await (file.local ? linkInPlace : materialize)(file.source, safePath(staging, file.path))
    await writeFile(join(staging, 'clover_model.json'), text)
    // Existing immutable bundles may still be open in another process. Leave them alone.
    try {
      await rename(staging, target)
    } catch (error) {
      if ((await fileSize(join(target, 'clover_model.json'))) < 0) throw error
      if ((await readFile(join(target, 'clover_model.json'), 'utf8')) !== text) throw error
      for (const file of expected)
        if ((await fileSize(safePath(target, file.path))) !== (await fileSize(file.source)))
          throw error
    }
    return target
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
