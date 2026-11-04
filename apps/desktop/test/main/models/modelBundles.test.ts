import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelBinding, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@main/services/settings'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { cacheDirFor, installOnDisk, rawModel, testSettings, writeCatalog } from './modelFixtures'

const localReleaseDir = vi.hoisted(() => vi.fn<() => string | null>())
vi.mock('@main/services/updates', () => ({ localReleaseDir }))
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
  dit: { model: rawModel({ id: 'dit-a', repo: 'org/dit', role: 'dit', subfolder: 'transformer' }), files: { 'transformer/config.json': '{"d":1}', 'transformer/model.safetensors': 'dit-weights' } },
  te: {
    model: rawModel({ id: 'te-a', repo: 'org/te', role: 'text_encoder', subfolder: 'text_encoder' }),
    files: { 'text_encoder/config.json': '{}', 'text_encoder/model.safetensors': 'te', 'tokenizer/tokenizer_config.json': '{}', 'tokenizer/tokenizer.json': '{}' },
  },
  vae: { model: rawModel({ id: 'vae-a', repo: 'org/vae', role: 'vae', subfolder: 'vae' }), files: { 'vae/config.json': '{}', 'vae/model.safetensors': 'vae' } },
  support: {
    model: rawModel({ id: 'support-a', repo: 'org/support', role: 'support' }),
    files: { 'model_index.json': '{}', 'pipeline_moss_image.py': '#', 'scheduler/scheduler_config.json': '{}' },
  },
}
const comfyDit = rawModel({ id: 'dit-comfy', repo: 'org/comfy', role: 'dit', format: 'comfyui' })
const otherFamily = rawModel({ id: 'dit-other', repo: 'org/other', role: 'dit', subfolder: 'transformer', family: 'flux' })
const bundle = { id: 'b1', name: 'B1', description: '', support: 'support-a', components: { dit: 'dit-a', textEncoder: 'te-a', vae: 'vae-a' } }
const binding: ModelBinding = { bundleId: 'b1', dit: 'dit-a', textEncoder: 'te-a', vae: 'vae-a' }

function installAll(): void {
  for (const { model, files } of Object.values(components)) {
    installOnDisk(modelsRoot(), { id: String(model['id']), repo: String(model['repo']), role: model['role'] as never }, SHA, files)
  }
}

beforeEach(async () => {
  vi.resetModules()
  localReleaseDir.mockReset().mockImplementation(() => releaseDir())
  writeCatalog(releaseDir(), {
    schema_version: 2,
    models: [...Object.values(components).map((c) => c.model), comfyDit, otherFamily],
    bundles: [bundle],
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
    ['a ComfyUI single file', { ...binding, dit: 'dit-comfy' }, /Diffusers/],
    ['a component of the wrong role', { ...binding, dit: 'vae-a' }, /Diffusers/],
    ['a different model family', { ...binding, dit: 'dit-other' }, /Diffusers/],
    ['a missing component', { ...binding, vae: 'gone' }, /Diffusers/],
  ])('rejects %s', async (_label, input, message) => {
    await expect(bundles.validateBinding(input, settings)).rejects.toThrow(message)
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

  it('passes three local files to the engine without copying anything', async () => {
    const ids = await registerLocal(['dit', 'text_encoder', 'vae'])
    const source = await bundles.prepareModelSource(
      { bundleId: 'local-files', dit: ids['dit']!, textEncoder: ids['text_encoder']!, vae: ids['vae']! },
      settings,
    )
    expect(source).toEqual({
      model: null,
      ditFile: join(dataRoot(), 'comfy', 'dit', 'dit.safetensors'),
      textEncoderFile: join(dataRoot(), 'comfy', 'text_encoder', 'text_encoder.safetensors'),
      vaeFile: join(dataRoot(), 'comfy', 'vae', 'vae.safetensors'),
    })
    expect(existsSync(join(modelsRoot(), 'bundles'))).toBe(false)
  })

  it('refuses a mix of local files and downloaded components', async () => {
    const ids = await registerLocal(['dit'])
    await expect(bundles.prepareModelSource({ ...binding, dit: ids['dit']! }, settings)).rejects.toThrow(/三个文件/)
  })

  it('rejects an unknown bundle', async () => {
    await expect(bundles.prepareModelSource({ ...binding, bundleId: 'nope' }, settings)).rejects.toThrow('模型组合不存在')
  })

  it('materializes a diffusers bundle for downloaded components', async () => {
    installAll()
    const source = await bundles.prepareModelSource(binding, settings)
    const bundlesDir = join(modelsRoot(), 'bundles')
    expect(dirname(source.model!)).toBe(bundlesDir)
    expect(basename(source.model!)).toMatch(/^[a-f0-9]{24}$/)
  })
})

describe('prepareModelBundle', () => {
  it('lays out a diffusers tree from the component snapshots and writes a manifest', async () => {
    installAll()
    const target = await bundles.prepareModelBundle(binding, settings)
    const files = (readdirSync(target, { recursive: true }) as string[]).filter((f) => statSync(join(target, f)).isFile()).sort()
    expect(files).toEqual([
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
    ].sort())
    const manifest = JSON.parse(readFileSync(join(target, 'clover_model.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 1, bundleId: 'b1' })
    expect(manifest.components.map((c: { id: string; revision: string }) => [c.id, c.revision])).toEqual([
      ['dit-a', SHA], ['te-a', SHA], ['vae-a', SHA], ['support-a', SHA],
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
