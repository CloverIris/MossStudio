import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelBinding, ModelBundle, Settings } from '@shared/types'
import { paths } from '../lib/paths'
import { RUNTIME_CONFIG_ID } from '@shared/bundleFit'
import { componentSnapshot, getCatalog } from './models'
import { fileSize, linkInPlace, materialize, safePath } from './modelFiles'

export function bundleBinding(bundle: ModelBundle): ModelBinding {
  return { bundleId: bundle.id, ...bundle.components }
}

const ROLES = [
  ['dit', 'dit'],
  ['textEncoder', 'text_encoder'],
  ['vae', 'vae'],
] as const

/**
 * A binding the engine can load: three MOSS-Image parts of the right roles,
 * either all diffusers folders or all single files (which load next to the
 * bundle's runtime-config folder).
 */
export async function validateBinding(binding: ModelBinding, settings: Settings): Promise<ModelBundle> {
  const catalog = await getCatalog(settings)
  const bundle = catalog.bundles.find((b) => b.id === binding.bundleId)
  if (!bundle) throw new Error('模型组合不存在，请重新选择')
  const parts = ROLES.map(([key, role]) => {
    const model = catalog.models.find((m) => m.id === binding[key])
    return model && model.role === role && model.family === 'moss-image' ? model : null
  })
  const formats = new Set(parts.map((model) => model?.format))
  const support = catalog.models.find((m) => m.id === bundle.support)
  const valid =
    parts.every(Boolean) && formats.size === 1 && (formats.has('diffusers') || (formats.has('comfyui') && support?.role === 'support'))
  if (!valid) throw new Error('请选择与 MOSS 兼容的组件：主模型、文本编码器和 VAE 需要都是 Diffusers 文件夹，或都是单文件')
  return bundle
}

/** What the engine loads: the bundle folder (`model`), and the component files that replace its weights. */
export interface PreparedModelSource {
  model: string
  ditFile?: string
  textEncoderFile?: string
  vaeFile?: string
  /** The resolved bundle: its tier and hardware needs decide how the job runs. */
  bundle: ModelBundle
}

/** The one weight file of a downloaded single-file part. */
async function componentFile(id: string, settings: Settings): Promise<string> {
  const { model, record, root } = await componentSnapshot(id, settings)
  const weights = record.entries.filter((file) => file.path.endsWith('.safetensors'))
  if (weights.length !== 1) throw new Error(`组件文件不完整：${model.name}。请在模型库修复组件。`)
  return safePath(root, weights[0]!.path)
}

/**
 * Resolve a binding to what the engine can load. Single files (a user's
 * ComfyUI folder registered in place, or a downloaded single-file bundle) go as
 * `dit_file` / `text_encoder_file` / `vae_file`; nothing is copied, so they keep
 * living where they are. The engine still reads the configs and tokenizer from
 * `model`, which is then the bundle's runtime-config folder.
 */
export async function prepareModelSource(binding: ModelBinding, settings: Settings): Promise<PreparedModelSource> {
  const catalog = await getCatalog(settings)
  const bundle = catalog.bundles.find((b) => b.id === binding.bundleId)
  if (!bundle) throw new Error('模型组合不存在，请重新选择')
  const entries = [binding.dit, binding.textEncoder, binding.vae].map((id) => catalog.models.find((model) => model.id === id))
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
      model: await prepareSupportFolder(binding.bundleId, bundle.support || RUNTIME_CONFIG_ID, settings),
      ditFile: paths[0]!,
      textEncoderFile: paths[1]!,
      vaeFile: paths[2]!,
      bundle,
    }
  }
  await validateBinding(binding, settings)
  if (entries.every((entry) => entry?.format === 'comfyui')) {
    // One after another, so a missing part is named in the order DiT, text encoder, VAE.
    const ditFile = await componentFile(binding.dit, settings)
    const textEncoderFile = await componentFile(binding.textEncoder, settings)
    const vaeFile = await componentFile(binding.vae, settings)
    return { model: await prepareSupportFolder(binding.bundleId, bundle.support, settings), ditFile, textEncoderFile, vaeFile, bundle }
  }
  return { model: await prepareModelBundle(binding, settings), bundle }
}

export async function prepareModelBundle(binding: ModelBinding, settings: Settings): Promise<string> {
  const bundle = await validateBinding(binding, settings)
  const requests = [binding.dit, binding.textEncoder, binding.vae, bundle.support]
  return materializeBundle(binding.bundleId, await Promise.all(requests.map((id) => componentSnapshot(id, settings))), settings)
}

/** The configs and tokenizer of a single-file bundle, laid out as the engine's `model` folder. */
async function prepareSupportFolder(bundleId: string, supportId: string, settings: Settings): Promise<string> {
  return materializeBundle(bundleId, [await componentSnapshot(supportId, settings)], settings)
}

/** Lay out component snapshots as one immutable folder (links, not copies) with a manifest. */
async function materializeBundle(
  bundleId: string,
  components: Array<Awaited<ReturnType<typeof componentSnapshot>>>,
  settings: Settings,
): Promise<string> {
  const manifest = {
    version: 1,
    bundleId,
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
        const folder = model.role === 'dit' ? 'transformer' : model.role === 'vae' ? 'vae' : 'text_encoder'
        path = `${folder}/${file.path.slice(prefix.length)}`
      }
      expected.push({ source: safePath(snapshot, file.path), path, ...(local ? { local } : {}) })
    }
  }
  const candidates = await readdir(root).catch(() => [] as string[])
  for (const name of candidates.filter((name) => (name === key || name.startsWith(`${key}-`)) && !name.includes('.tmp-'))) {
    const candidate = join(root, name)
    try {
      if (
        (await readFile(join(candidate, 'clover_model.json'), 'utf8')) === text &&
        (await Promise.all(expected.map(async (f) => (await fileSize(safePath(candidate, f.path))) === (await fileSize(f.source))))).every(
          Boolean,
        )
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
      for (const file of expected) if ((await fileSize(safePath(target, file.path))) !== (await fileSize(file.source))) throw error
    }
    return target
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
