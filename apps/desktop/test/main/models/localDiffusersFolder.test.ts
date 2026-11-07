import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelBinding, Settings } from '@shared/types'
import { cliBundleProblem } from '@shared/cliEngine'
import { installedBundles } from '@renderer/pages/studio/readiness'
import { DEFAULT_SETTINGS } from '@main/services/settings'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'
import { rawModel, testSettings, writeCatalog } from './modelFixtures'

const localReleaseDir = vi.hoisted(() => vi.fn<() => string | null>())
vi.mock('@main/services/updates', () => ({ localReleaseDir }))
vi.mock('@main/services/supervisor', () => ({ listJobs: async () => [] }))
vi.mock('@main/services/network', () => ({ getLastNetwork: () => null }))
vi.mock('@main/services/hfNetwork', () => ({ fetchHf: (url: string) => fetch(url) }))

const dataRoot = useTempDataRoot()
const userDisk = useTempDir('mossstudio-user-models-')
let models: typeof import('@main/services/models')
let bundles: typeof import('@main/services/modelBundles')
let imports: typeof import('@main/services/modelImports')
let settings: Settings

const SFT = 'OpenMOSS-Team/MOSS-Image-SFT'
const BASE = 'OpenMOSS-Team/MOSS-Image-Base'
/** The real catalog's MOSS-Image components (release/models.json), trimmed to what matters. */
const catalog = {
  schema_version: 2,
  models: [
    rawModel({ id: 'moss-sft-dit', repo: SFT, role: 'dit', subfolder: 'transformer', files: ['transformer/*'] }),
    rawModel({ id: 'moss-base-dit', repo: BASE, role: 'dit', subfolder: 'transformer', files: ['transformer/*'] }),
    rawModel({
      id: 'qwen35-encoder',
      repo: SFT,
      role: 'text_encoder',
      subfolder: 'text_encoder',
      files: ['text_encoder/*', 'tokenizer/*'],
    }),
    rawModel({ id: 'flux2-vae-small', repo: SFT, role: 'vae', subfolder: 'vae', precision: 'fp32', files: ['vae/*'] }),
    rawModel({
      id: 'moss-pipeline',
      repo: SFT,
      role: 'support',
      subfolder: '',
      precision: 'mixed',
      files: ['model_index.json', 'pipeline_moss_image.py', 'scheduler/*'],
    }),
  ],
  bundles: [
    {
      id: 'moss-sft',
      name: 'MOSS-Image SFT',
      description: '',
      support: 'moss-pipeline',
      components: { dit: 'moss-sft-dit', textEncoder: 'qwen35-encoder', vae: 'flux2-vae-small' },
    },
    {
      id: 'moss-base',
      name: 'MOSS-Image Base',
      description: '',
      support: 'moss-pipeline',
      components: { dit: 'moss-base-dit', textEncoder: 'qwen35-encoder', vae: 'flux2-vae-small' },
    },
  ],
}

/** A safetensors file: 8-byte header length, JSON header, then the tensor bytes. */
function safetensors(dtype: 'BF16' | 'F16' | 'F32', bytes = 64): Buffer {
  const header = Buffer.from(JSON.stringify({ __metadata__: {}, weight: { dtype, shape: [bytes / 2], data_offsets: [0, bytes] } }))
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(header.length))
  return Buffer.concat([length, header, Buffer.alloc(bytes, 1)])
}

/** The layout of /workspace/Models/MOSS-Image/sft: diffusers folder with sharded transformer and text encoder. */
function diffusersFolder(name: string, title = 'MOSS-Image-SFT', dtype: 'BF16' | 'F16' = 'BF16'): string {
  const root = join(userDisk(), name)
  const files: Record<string, string | Buffer> = {
    'README.md': `---\nlicense: apache-2.0\n---\n# ${title}\n`,
    'model_index.json': '{"_class_name":"MOSSImagePipeline"}',
    'pipeline_moss_image.py': '# pipeline',
    'scheduler/scheduler_config.json': '{}',
    'transformer/config.json': '{"num_layers":42}',
    'transformer/diffusion_pytorch_model-00001-of-00002.safetensors': safetensors(dtype),
    'transformer/diffusion_pytorch_model-00002-of-00002.safetensors': safetensors(dtype),
    'transformer/diffusion_pytorch_model.safetensors.index.json': JSON.stringify({
      weight_map: {
        a: 'diffusion_pytorch_model-00001-of-00002.safetensors',
        b: 'diffusion_pytorch_model-00002-of-00002.safetensors',
      },
    }),
    'text_encoder/config.json': '{}',
    'text_encoder/model.safetensors': safetensors(dtype),
    'tokenizer/tokenizer.json': '{}',
    'tokenizer/tokenizer_config.json': '{}',
    'vae/config.json': '{}',
    'vae/diffusion_pytorch_model.safetensors': safetensors('F32'),
    '__pycache__/pipeline_moss_image.cpython-312.pyc': 'cache',
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const index = async (): Promise<string> => join((await import('@main/lib/paths')).paths.modelImports(settings.modelsRoot), 'index.json')

beforeEach(async () => {
  vi.resetModules()
  localReleaseDir.mockReset().mockImplementation(() => join(dataRoot(), 'release'))
  writeCatalog(join(dataRoot(), 'release'), catalog)
  models = await import('@main/services/models')
  bundles = await import('@main/services/modelBundles')
  imports = await import('@main/services/modelImports')
  settings = testSettings(DEFAULT_SETTINGS, { modelsRoot: join(dataRoot(), 'models') })
})

describe('inspectDiffusersFolder', () => {
  it('recognises a complete MOSS-Image diffusers folder, its flavour and its weight dtype', async () => {
    const info = await imports.inspectDiffusersFolder(diffusersFolder('sft'))
    expect(info).toMatchObject({ flavor: 'sft', dtype: 'bf16' })
    expect(info!.files.some((file) => file.path.startsWith('__pycache__'))).toBe(false)
    expect(await imports.inspectDiffusersFolder(diffusersFolder('my-base', 'MOSS-Image-Base', 'F16'))).toMatchObject({
      flavor: 'base',
      dtype: 'fp16',
    })
  })

  it('is null for an incomplete folder or a file', async () => {
    const root = diffusersFolder('broken')
    writeFileSync(join(root, 'vae', 'config.json'), '')
    expect(await imports.inspectDiffusersFolder(root)).toBeNull()
    expect(await imports.inspectDiffusersFolder(join(root, 'model_index.json'))).toBeNull()
  })
})

describe('using an existing diffusers folder in place', () => {
  it('a scan offers the folder by name (not "."), with its size', async () => {
    const root = diffusersFolder('sft')
    const scan = await models.scanModels(root)
    expect(scan.candidates).toHaveLength(1)
    expect(scan.candidates[0]).toMatchObject({
      layout: 'diffusers-folder',
      name: 'MOSS-Image SFT（sft）',
      relativePath: 'sft',
      role: 'full',
    })
    expect(scan.candidates[0]!.size).toBeGreaterThan(0)
  })

  it('registers the folder as one installed model, and the matching catalog bundle becomes ready', async () => {
    const root = diffusersFolder('sft')
    const scan = await models.scanModels(root)
    const result = await models.registerScannedModels(
      settings,
      scan.candidates.map((candidate) => ({
        path: candidate.path,
        role: candidate.role as 'full',
        layout: candidate.layout as 'diffusers-folder',
        name: candidate.name,
        relativePath: candidate.relativePath,
      })),
    )
    expect(result).toEqual({ added: 1, updated: 0, missing: [] })

    const loaded = await models.getCatalog(settings, true)
    const local = loaded.models.filter((model) => model.provider === 'local')
    expect(local).toHaveLength(1)
    expect(local[0]).toMatchObject({
      name: 'MOSS-Image SFT（sft）',
      role: 'full',
      format: 'diffusers',
      precision: 'bf16',
      installed: true,
      localPath: root,
    })
    // The SFT components are served by the folder; the Base DiT is not (another fine-tune).
    const installed = (id: string) => loaded.models.find((model) => model.id === id)!
    for (const id of ['moss-sft-dit', 'qwen35-encoder', 'flux2-vae-small', 'moss-pipeline']) {
      expect(installed(id)).toMatchObject({ installed: true, installState: 'ready', provider: 'hf', localPath: root })
    }
    expect(installed('moss-base-dit').installed).toBe(false)
    // The CLI engines (Vulkan / HIP) accept it: a complete bf16 bundle.
    const sft = loaded.bundles.find((bundle) => bundle.id === 'moss-sft')!
    expect(cliBundleProblem('vulkan', sft, loaded.models)).toBeNull()
    // The Studio's model picker offers it.
    expect(installedBundles(loaded).map((bundle) => bundle.id)).toEqual(['moss-sft'])
  })

  it('the Studio bundle is built from links to the folder, never copies', async () => {
    const root = diffusersFolder('sft')
    await models.registerScannedModels(settings, [{ path: root, role: 'full', layout: 'diffusers-folder' }])
    const binding: ModelBinding = { bundleId: 'moss-sft', dit: 'moss-sft-dit', textEncoder: 'qwen35-encoder', vae: 'flux2-vae-small' }
    const source = await bundles.prepareModelSource(binding, settings)
    expect(source.model).toBeTruthy()
    const shard = join(source.model!, 'transformer', 'diffusion_pytorch_model-00001-of-00002.safetensors')
    const original = join(root, 'transformer', 'diffusion_pytorch_model-00001-of-00002.safetensors')
    // Same file (hard link) or a symbolic link to it.
    const linked = lstatSync(shard).isSymbolicLink() || statSync(shard).ino === statSync(original).ino
    expect(linked).toBe(true)
    expect(readFileSync(join(source.model!, 'clover_model.json'), 'utf8')).toContain('moss-sft-dit')
    expect(statSync(join(source.model!, 'tokenizer', 'tokenizer.json')).size).toBe(2)
  })

  it('a Base folder serves the Base bundle; an unknown folder is registered but serves no catalog bundle', async () => {
    const base = diffusersFolder('downloads', 'MOSS-Image-Base')
    const other = diffusersFolder('something-else', 'My fine-tune')
    await models.registerScannedModels(settings, [
      { path: base, role: 'full', layout: 'diffusers-folder' },
      { path: other, role: 'full', layout: 'diffusers-folder' },
    ])
    const loaded = await models.getCatalog(settings, true)
    expect(loaded.models.find((model) => model.id === 'moss-base-dit')).toMatchObject({ installed: true, localPath: base })
    expect(loaded.models.find((model) => model.id === 'moss-sft-dit')!.installed).toBe(false)
    expect(
      loaded.models
        .filter((model) => model.provider === 'local')
        .map((model) => model.name)
        .sort(),
    ).toEqual(['MOSS-Image Base（downloads）', 'something-else'])
  })

  it('a folder that lost a part is no longer installed', async () => {
    const root = diffusersFolder('sft')
    await models.registerScannedModels(settings, [{ path: root, role: 'full', layout: 'diffusers-folder' }])
    writeFileSync(join(root, 'vae', 'diffusion_pytorch_model.safetensors'), safetensors('F32', 128))
    const loaded = await models.getCatalog(settings, true)
    expect(loaded.models.find((model) => model.provider === 'local')!.installed).toBe(false)
  })

  it('添加整个模型文件夹: picking a folder registers each diffusers folder inside it as one model', async () => {
    diffusersFolder('sft')
    diffusersFolder('base', 'MOSS-Image-Base')
    const result = await models.importModelFolder(userDisk(), settings)
    expect(result).toMatchObject({ added: 2, duplicates: 0, folders: ['MOSS-Image Base（base）', 'MOSS-Image SFT（sft）'] })
    const records = await imports.readImportedModels(await index())
    expect(records.map((record) => [record.layout, record.role])).toEqual([
      ['diffusers-folder', 'full'],
      ['diffusers-folder', 'full'],
    ])
    // Nothing was hashed (that would read 27 GB): the records carry no sha256.
    expect(records.every((record) => record.sha256 === undefined)).toBe(true)
    // Picking it again updates instead of adding rows.
    expect(await models.importModelFolder(userDisk(), settings)).toMatchObject({ added: 0, duplicates: 2 })
  })
})
