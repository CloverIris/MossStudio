import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelBinding, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@main/services/settings'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { cacheDirFor, installOnDisk, rawModel, testSettings, writeCatalog } from './modelFixtures'

const contentDir = vi.hoisted(() => vi.fn<() => string | null>())
vi.mock('@main/lib/content', () => ({ contentDir }))
vi.mock('@main/services/supervisor', () => ({ listJobs: async () => [] }))
vi.mock('@main/services/network', () => ({ getLastNetwork: () => null }))
vi.mock('@main/services/hfNetwork', () => ({ fetchHf: (url: string) => fetch(url) }))

const dataRoot = useTempDataRoot()
type Bundles = typeof import('@main/services/modelBundles')
type Models = typeof import('@main/services/models')
let bundles: Bundles
let models: Models
let settings: Settings
const modelsRoot = (): string => join(dataRoot(), 'models')
const releaseDir = (): string => join(dataRoot(), 'release')
const SHA = 'f'.repeat(40)

const components = {
  dit: {
    model: rawModel({ id: 'dit-a', repo: 'org/dit', role: 'dit', subfolder: 'transformer' }),
    files: { 'transformer/config.json': '{"d":1}', 'transformer/model.safetensors': 'dit-weights' },
  },
  te: {
    model: rawModel({ id: 'te-a', repo: 'org/te', role: 'text_encoder', subfolder: 'text_encoder' }),
    files: {
      'text_encoder/config.json': '{}',
      'text_encoder/model.safetensors': 'te',
      'tokenizer/tokenizer_config.json': '{}',
      'tokenizer/tokenizer.json': '{}',
    },
  },
  vae: {
    model: rawModel({ id: 'vae-a', repo: 'org/vae', role: 'vae', subfolder: 'vae' }),
    files: { 'vae/config.json': '{}', 'vae/model.safetensors': 'vae' },
  },
  support: {
    model: rawModel({ id: 'support-a', repo: 'org/support', role: 'support' }),
    files: { 'model_index.json': '{}', 'pipeline_moss_image.py': '#', 'scheduler/scheduler_config.json': '{}' },
  },
}
const comfyDit = rawModel({
  id: 'dit-comfy',
  repo: 'org/comfy',
  role: 'dit',
  format: 'comfyui',
  files: ['diffusion_models/dit.safetensors'],
})
const comfyTe = rawModel({
  id: 'te-comfy',
  repo: 'org/comfy',
  role: 'text_encoder',
  format: 'comfyui',
  files: ['text_encoders/te.safetensors'],
})
const comfyVae = rawModel({ id: 'vae-comfy', repo: 'org/comfy', role: 'vae', format: 'comfyui', files: ['vae/vae.safetensors'] })
/** The configs and tokenizer a single-file bundle loads next to (as `moss-runtime-config`). */
const runtimeConfig = {
  model: rawModel({ id: 'moss-runtime-config', repo: 'OpenMOSS-Team/MOSS-Image-SFT', role: 'support' }),
  files: {
    'model_index.json': '{}',
    'pipeline_moss_image.py': '#',
    'scheduler/scheduler_config.json': '{}',
    'transformer/config.json': '{"t":1}',
    'text_encoder/config.json': '{}',
    'vae/config.json': '{}',
    'tokenizer/tokenizer.json': '{}',
    'tokenizer/tokenizer_config.json': '{}',
  },
}
const fileBundle = {
  id: 'files',
  name: 'Files',
  description: '',
  support: 'moss-runtime-config',
  components: { dit: 'dit-comfy', textEncoder: 'te-comfy', vae: 'vae-comfy' },
  tier: 'high',
}
const fileBinding: ModelBinding = { bundleId: 'files', dit: 'dit-comfy', textEncoder: 'te-comfy', vae: 'vae-comfy' }

function installRuntimeConfig(): void {
  installOnDisk(
    modelsRoot(),
    { id: 'moss-runtime-config', repo: 'OpenMOSS-Team/MOSS-Image-SFT', role: 'support' },
    SHA,
    runtimeConfig.files,
  )
}

function installFiles(): void {
  installRuntimeConfig()
  for (const [id, role, path] of [
    ['dit-comfy', 'dit', 'diffusion_models/dit.safetensors'],
    ['te-comfy', 'text_encoder', 'text_encoders/te.safetensors'],
    ['vae-comfy', 'vae', 'vae/vae.safetensors'],
  ] as const) {
    installOnDisk(modelsRoot(), { id, repo: 'org/comfy', role }, SHA, { [path]: `${id}-weights` })
  }
}
const otherFamily = rawModel({ id: 'dit-other', repo: 'org/other', role: 'dit', subfolder: 'transformer', family: 'flux' })
const bundle = {
  id: 'b1',
  name: 'B1',
  description: '',
  support: 'support-a',
  components: { dit: 'dit-a', textEncoder: 'te-a', vae: 'vae-a' },
}
const binding: ModelBinding = { bundleId: 'b1', dit: 'dit-a', textEncoder: 'te-a', vae: 'vae-a' }

function installAll(): void {
  for (const { model, files } of Object.values(components)) {
    installOnDisk(modelsRoot(), { id: String(model['id']), repo: String(model['repo']), role: model['role'] as never }, SHA, files)
  }
}

beforeEach(async () => {
  vi.resetModules()
  contentDir.mockReset().mockImplementation(() => releaseDir())
  writeCatalog(releaseDir(), {
    schema_version: 3,
    models: [...Object.values(components).map((c) => c.model), comfyDit, comfyTe, comfyVae, runtimeConfig.model, otherFamily],
    bundles: [bundle],
    single_file_bundles: [fileBundle],
  })
  bundles = await import('@main/services/modelBundles')
  models = await import('@main/services/models')
  settings = testSettings(DEFAULT_SETTINGS, { modelsRoot: modelsRoot() })
})

describe('bundleBinding / validateBinding', () => {
  it('derives a binding from a bundle', () => {
    expect(bundles.bundleBinding({ ...bundle, recommended: false })).toEqual(binding)
  })

  it('accepts a MOSS diffusers binding and returns its bundle', async () => {
    expect((await bundles.validateBinding(binding, settings)).id).toBe('b1')
  })

  it.each([
    ['an unknown bundle', { ...binding, bundleId: 'nope' }, '模型组合不存在'],
    ['a single file mixed with folders', { ...binding, dit: 'dit-comfy' }, /Diffusers/],
    ['a component of the wrong role', { ...binding, dit: 'vae-a' }, /Diffusers/],
    ['a different model family', { ...binding, dit: 'dit-other' }, /Diffusers/],
    ['a missing component', { ...binding, vae: 'gone' }, /Diffusers/],
  ])('rejects %s', async (_label, input, message) => {
    await expect(bundles.validateBinding(input, settings)).rejects.toThrow(message)
  })

  it('accepts three single files next to a runtime-config folder', async () => {
    expect((await bundles.validateBinding(fileBinding, settings)).id).toBe('files')
  })
})

describe('prepareModelSource', () => {
  async function registerLocal(roles: Array<'dit' | 'text_encoder' | 'vae'>): Promise<Record<string, string>> {
    const ids: Record<string, string> = {}
    for (const role of roles) {
      const path = join(dataRoot(), 'comfy', role, `${role}.safetensors`)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, role)
      await models.registerScannedModels(settings, [{ path, role, layout: 'comfyui-single-file' }])
      ids[role] = (await models.getCatalog(settings)).models.find((m) => m.provider === 'local' && m.role === role)!.id
    }
    return ids
  }

  const runtimeFiles = runtimeConfig.files
  const installRuntime = installRuntimeConfig
  const filesIn = (folder: string): string[] =>
    (readdirSync(folder, { recursive: true }) as string[]).filter((f) => statSync(join(folder, f)).isFile()).sort()

  it('passes three local files beside the config folder, which holds no weights', async () => {
    installRuntime()
    const ids = await registerLocal(['dit', 'text_encoder', 'vae'])
    // The scanned-files model older versions made by themselves is kept as a saved combination.
    const source = await bundles.prepareModelSource(
      { bundleId: 'local-files', dit: ids['dit']!, textEncoder: ids['text_encoder']!, vae: ids['vae']! },
      settings,
    )
    expect(source).toEqual({
      model: expect.stringContaining(join(modelsRoot(), 'bundles')),
      ditFile: join(dataRoot(), 'comfy', 'dit', 'dit.safetensors'),
      textEncoderFile: join(dataRoot(), 'comfy', 'text_encoder', 'text_encoder.safetensors'),
      vaeFile: join(dataRoot(), 'comfy', 'vae', 'vae.safetensors'),
      bundle: expect.objectContaining({ id: 'local-files' }),
    })
    expect(filesIn(source.model)).toEqual(
      ['clover_model.json', ...Object.keys(runtimeFiles).map((path) => join(...path.split('/')))].sort(),
    )
  })

  it('passes a downloaded single-file bundle as component files next to its runtime-config folder', async () => {
    installFiles()
    const source = await bundles.prepareModelSource(fileBinding, settings)
    const snapshot = (role: 'dit' | 'text_encoder' | 'vae', path: string) =>
      join(cacheDirFor(modelsRoot(), role, 'org/comfy'), 'snapshots', SHA, path)
    expect(source).toMatchObject({
      ditFile: snapshot('dit', 'diffusion_models/dit.safetensors'),
      textEncoderFile: snapshot('text_encoder', 'text_encoders/te.safetensors'),
      vaeFile: snapshot('vae', 'vae/vae.safetensors'),
      bundle: { id: 'files', tier: 'high' },
    })
    expect(readFileSync(source.ditFile!, 'utf8')).toBe('dit-comfy-weights')
    const manifest = JSON.parse(readFileSync(join(source.model, 'clover_model.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 1, bundleId: 'files', components: [{ id: 'moss-runtime-config', revision: SHA }] })
    expect(readFileSync(join(source.model, 'vae', 'config.json'), 'utf8')).toBe('{}')
  })

  it('says which part of a single-file bundle is missing', async () => {
    installRuntimeConfig()
    await expect(bundles.prepareModelSource(fileBinding, settings)).rejects.toThrow(/组件未就绪：dit-comfy/)
  })

  it('mixes downloaded folders with a single file, which replaces only its own part', async () => {
    installAll()
    installRuntime()
    const ids = await registerLocal(['dit'])
    const source = await bundles.prepareModelSource({ ...binding, dit: ids['dit']! }, settings)
    expect(source.ditFile).toBe(join(dataRoot(), 'comfy', 'dit', 'dit.safetensors'))
    expect(source.textEncoderFile).toBeUndefined()
    expect(source.vaeFile).toBeUndefined()
    const files = filesIn(source.model)
    expect(files).toContain(join('text_encoder', 'model.safetensors'))
    expect(files).toContain(join('vae', 'model.safetensors'))
    expect(files).toContain(join('transformer', 'config.json'))
    expect(files).not.toContain(join('transformer', 'model.safetensors'))
  })

  it('passes a downloaded single file from its download folder', async () => {
    installAll()
    installRuntime()
    installOnDisk(modelsRoot(), { id: 'dit-comfy', repo: 'org/comfy', role: 'dit' }, SHA, {
      'diffusion_models/dit_int8.safetensors': 'int8',
    })
    const source = await bundles.prepareModelSource({ ...binding, dit: 'dit-comfy' }, settings)
    expect(source.ditFile).toBe(
      join(cacheDirFor(modelsRoot(), 'dit', 'org/comfy'), 'snapshots', SHA, 'diffusion_models', 'dit_int8.safetensors'),
    )
  })

  it('asks for the config folder before a single file can run', async () => {
    installAll()
    const ids = await registerLocal(['dit'])
    await expect(bundles.prepareModelSource({ ...binding, dit: ids['dit']! }, settings)).rejects.toThrow(/moss-runtime-config/)
  })

  it('refuses a part in the wrong slot', async () => {
    await expect(bundles.prepareModelSource({ ...binding, dit: 'vae-a' }, settings)).rejects.toThrow('部件不对')
  })

  it('rejects an unknown bundle', async () => {
    await expect(bundles.prepareModelSource({ ...binding, bundleId: 'nope' }, settings)).rejects.toThrow('模型组合不存在')
  })

  it('materializes a diffusers bundle for downloaded components', async () => {
    installAll()
    const source = await bundles.prepareModelSource(binding, settings)
    const bundlesDir = join(modelsRoot(), 'bundles')
    expect(dirname(source.model)).toBe(bundlesDir)
    expect(basename(source.model)).toMatch(/^[a-f0-9]{24}$/)
    expect(source.ditFile).toBeUndefined()
  })
})

describe('prepareModelBundle', () => {
  it('lays out a diffusers tree from the component snapshots and writes a manifest', async () => {
    installAll()
    const target = await bundles.prepareModelBundle(binding, settings)
    const files = (readdirSync(target, { recursive: true }) as string[]).filter((f) => statSync(join(target, f)).isFile()).sort()
    expect(files).toEqual(
      [
        'clover_model.json',
        'model_index.json',
        'pipeline_moss_image.py',
        join('scheduler', 'scheduler_config.json'),
        join('text_encoder', 'config.json'),
        join('text_encoder', 'model.safetensors'),
        join('tokenizer', 'tokenizer.json'),
        join('tokenizer', 'tokenizer_config.json'),
        join('transformer', 'config.json'),
        join('transformer', 'model.safetensors'),
        join('vae', 'config.json'),
        join('vae', 'model.safetensors'),
      ].sort(),
    )
    const manifest = JSON.parse(readFileSync(join(target, 'clover_model.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 1, bundleId: 'b1' })
    expect(manifest.components.map((c: { id: string; revision: string }) => [c.id, c.revision])).toEqual([
      ['dit-a', SHA],
      ['te-a', SHA],
      ['vae-a', SHA],
      ['support-a', SHA],
    ])
    // Hard links: no extra copy of the weights.
    const blob = statSync(join(cacheDirFor(modelsRoot(), 'dit', 'org/dit'), 'snapshots', SHA, 'transformer', 'model.safetensors'))
    expect(statSync(join(target, 'transformer', 'model.safetensors')).ino).toBe(blob.ino)
    expect(readdirSync(join(modelsRoot(), 'bundles')).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('reuses an intact materialization and replaces a damaged one beside it', async () => {
    installAll()
    const first = await bundles.prepareModelBundle(binding, settings)
    expect(await bundles.prepareModelBundle(binding, settings)).toBe(first)
    writeFileSync(join(first, 'vae', 'model.safetensors.extra'), 'ignored')
    expect(await bundles.prepareModelBundle(binding, settings)).toBe(first)

    // A truncated file in the existing view must not be reused (it may be open elsewhere, so it stays).
    // (Replace the hard link instead of truncating it, which would corrupt the shared snapshot.)
    rmSync(join(first, 'transformer', 'config.json'))
    writeFileSync(join(first, 'transformer', 'config.json'), '')
    const second = await bundles.prepareModelBundle(binding, settings)
    expect(second).not.toBe(first)
    expect(second.startsWith(`${first}-`)).toBe(true)
    expect(existsSync(first)).toBe(true)
    expect(readFileSync(join(second, 'transformer', 'config.json'), 'utf8')).toBe('{"d":1}')
  })

  it('fails with a clear message when a component is not installed', async () => {
    await expect(bundles.prepareModelBundle(binding, settings)).rejects.toThrow(/组件未就绪/)
  })
})
