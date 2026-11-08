import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSingleFile, RUNTIME_CONFIG_ID } from '@shared/modelCombos'
import type { ModelBinding, ModelBundle, ModelEntry, Settings } from '@shared/types'
import { paths } from '../lib/paths'
import { componentSnapshot, getCatalog } from './models'
import { fileSize, linkInPlace, materialize, safePath } from './modelFiles'

export function bundleBinding(bundle: ModelBundle): ModelBinding {
  return { bundleId: bundle.id, ...bundle.components }
}

export async function validateBinding(binding: ModelBinding, settings: Settings): Promise<ModelBundle> {
  const catalog = await getCatalog(settings)
  const bundle = catalog.bundles.find((b) => b.id === binding.bundleId)
  if (!bundle) throw new Error('模型组合不存在，请重新选择')
  for (const [key, role] of [
    ['dit', 'dit'],
    ['textEncoder', 'text_encoder'],
    ['vae', 'vae'],
  ] as const) {
    const model = catalog.models.find((m) => m.id === binding[key])
    if (!model || model.role !== role || model.format !== 'diffusers' || model.family !== 'moss-image') {
      throw new Error('请选择与 MOSS 兼容的 Diffusers 组件；ComfyUI 单文件仅支持下载')
    }
  }
  return bundle
}

/**
 * What the engine loads: a folder with the configs and tokenizer (`model`),
 * and, for a part chosen as a single file, that file, which replaces the
 * part's weights in the folder.
 */
export interface PreparedModelSource {
  model: string
  ditFile?: string
  textEncoderFile?: string
  vaeFile?: string
}

const SLOT_ROLES = [
  ['dit', 'dit'],
  ['textEncoder', 'text_encoder'],
  ['vae', 'vae'],
] as const

/**
 * Resolve a binding to what the engine can load. Parts that are folders are
 * linked into a prepared bundle folder; a single file (a download from a
 * single-file repository, or the person's own file) goes to the engine where it
 * is, beside the config folder (`moss-runtime-config`). Nothing is copied.
 */
export async function prepareModelSource(binding: ModelBinding, settings: Settings): Promise<PreparedModelSource> {
  const catalog = await getCatalog(settings)
  const bundle = catalog.bundles.find((b) => b.id === binding.bundleId)
  if (!bundle) throw new Error('模型组合不存在，请重新选择')
  const parts = SLOT_ROLES.map(([key, role]) => {
    const model = catalog.models.find((entry) => entry.id === binding[key])
    if (!model || model.role !== role) throw new Error('模型组合里的部件不对，请重新选择')
    return model
  })
  const singles = parts.filter(isSingleFile)
  if (!singles.length) return { model: await prepareModelBundle(binding, settings) }
  const folderIds = [...parts.filter((part) => !isSingleFile(part)).map((part) => part.id), RUNTIME_CONFIG_ID]
  const model = await materializeBundle(binding.bundleId, folderIds, settings)
  const fileOf = async (part: ModelEntry): Promise<string | undefined> => {
    if (!isSingleFile(part)) return undefined
    if (part.provider === 'local') {
      if (!part.localPath) throw new Error(`找不到「${part.name}」的文件，请重新添加`)
      return part.localPath
    }
    const { record, root } = await componentSnapshot(part.id, settings)
    const file = record.entries[0]
    if (!file) throw new Error(`组件未就绪：${part.name}。请在模型库补齐组件。`)
    return safePath(root, file.path)
  }
  const [ditFile, textEncoderFile, vaeFile] = await Promise.all(parts.map(fileOf))
  return {
    model,
    ...(ditFile ? { ditFile } : {}),
    ...(textEncoderFile ? { textEncoderFile } : {}),
    ...(vaeFile ? { vaeFile } : {}),
  }
}

export async function prepareModelBundle(binding: ModelBinding, settings: Settings): Promise<string> {
  const bundle = await validateBinding(binding, settings)
  return materializeBundle(binding.bundleId, [binding.dit, binding.textEncoder, binding.vae, bundle.support], settings)
}

/**
 * A diffusers folder of these parts, hard-linked from their downloads (or the
 * person's folder) into `<models root>/bundles/<key>/`, reused while its
 * manifest and file sizes match. A path two parts share is taken from the first.
 */
async function materializeBundle(bundleId: string, ids: string[], settings: Settings): Promise<string> {
  const components = await Promise.all(ids.map((id) => componentSnapshot(id, settings)))
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
  const taken = new Set<string>()
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
      if (taken.has(path)) continue
      taken.add(path)
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
