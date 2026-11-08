import { describe, expect, it } from 'vitest'
import {
  combinationBundle,
  combinationIds,
  legacyLocalCombination,
  missingBytes,
  slotChoices,
  suggestedName,
  supportFor,
  unusedDownloads,
} from '@shared/modelCombos'
import type { ModelEntry } from '@shared/types'
import { catalogFixture } from '../mocks/backend/fixtures'

const own = (id: string, role: ModelEntry['role'], overrides: Partial<ModelEntry> = {}): ModelEntry => ({
  id,
  name: `${id}.safetensors`,
  provider: 'local',
  repo: `D:/ComfyUI/models/${id}.safetensors`,
  revision: 'local',
  role,
  format: 'comfyui',
  family: 'local',
  precision: 'local',
  license: 'local',
  tags: ['local-import'],
  localPath: `D:/ComfyUI/models/${id}.safetensors`,
  installed: true,
  installedBytes: 5e9,
  sizeBytes: 5e9,
  ...overrides,
})

const models = (installed: string[] = [], extra: ModelEntry[] = []): ModelEntry[] => [...catalogFixture({ installed }).models, ...extra]
const labels = (list: { label: string }[]): string[] => list.map((choice) => choice.label)

describe('slotChoices', () => {
  it('lists each 主模型 once by its label, without the unusable FP16-fixed single files', () => {
    expect(labels(slotChoices(models(), 'dit'))).toEqual([
      'MOSS-Image SFT BF16',
      'MOSS-Image Base BF16',
      'MOSS-Image Base FP16 社区修复',
      'MOSS-Image SFT FP16 社区修复',
      'MOSS-Image Base INT8',
      'MOSS-Image SFT INT8',
      // The engine-certified single files (INT4, NVFP4, Turbo) are parts too.
      'MOSS-Image SFT INT4',
      'MOSS-Image SFT NVFP4',
      'MOSS-Image SFT Turbo INT8',
    ])
  })

  it('uses the folder version of a part both repositories offer, unless the single file is already here', () => {
    const fresh = slotChoices(models(), 'textEncoder').find((choice) => choice.label === 'Qwen3.5 BF16')!
    expect(fresh).toMatchObject({ id: 'qwen35-encoder', ids: ['qwen35-encoder', 'qwen35-comfy-bf16'], installed: false })
    const here = slotChoices(models(['qwen35-comfy-bf16']), 'textEncoder').find((choice) => choice.label === 'Qwen3.5 BF16')!
    expect(here).toMatchObject({ id: 'qwen35-comfy-bf16', installed: true })
    expect(labels(slotChoices(models(), 'vae'))).toEqual(['FLUX.2 VAE Small', 'FLUX.2 VAE Full'])
  })

  it('adds the person’s own single files that are still there, after the downloads', () => {
    const list = slotChoices(
      models([], [own('my-dit', 'dit'), own('gone-dit', 'dit', { installed: false }), own('my-folder', 'dit', { format: 'diffusers' })]),
      'dit',
    )
    expect(list.at(-1)).toMatchObject({ id: 'my-dit', label: 'my-dit.safetensors', local: true, installed: true })
    expect(list.filter((choice) => choice.local)).toHaveLength(1)
  })
})

describe('supportFor and combinationIds', () => {
  it('needs only the pipeline configs beside folders, and the full config folder once a part is a single file', () => {
    const all = models()
    const folders = { dit: 'moss-sft-dit', textEncoder: 'qwen35-encoder', vae: 'flux2-vae-small' }
    expect(combinationIds(folders, all)).toEqual(['moss-sft-dit', 'qwen35-encoder', 'flux2-vae-small', 'moss-pipeline'])
    const mixed = { ...folders, dit: 'moss-sft-comfy-int8_convrot' }
    expect(combinationIds(mixed, all)).toEqual(['moss-sft-comfy-int8_convrot', 'qwen35-encoder', 'flux2-vae-small', 'moss-runtime-config'])
    expect(supportFor([{ format: 'diffusers' }, { format: 'comfyui' }])).toBe('moss-runtime-config')
    expect(supportFor([])).toBe('moss-pipeline')
  })
})

describe('missingBytes', () => {
  it('counts only the parts not here yet', () => {
    const all = models(['flux2-vae-small'])
    const ids = combinationIds({ dit: 'moss-sft-comfy-int8_convrot', textEncoder: 'qwen35-comfy-w4a8_gptq', vae: 'flux2-vae-small' }, all)
    const size = (id: string) => all.find((model) => model.id === id)!.sizeBytes
    expect(missingBytes(ids, all)).toBe(size('moss-sft-comfy-int8_convrot') + size('qwen35-comfy-w4a8_gptq') + size('moss-runtime-config'))
  })
})

describe('combinationBundle', () => {
  it('becomes a model named by the person, described by its parts', () => {
    const all = models([], [own('my-dit', 'dit')])
    const bundle = combinationBundle(
      {
        id: 'combo-1',
        name: '我的 INT8',
        components: { dit: 'my-dit', textEncoder: 'qwen35-comfy-w4a8_gptq', vae: 'flux2-vae-small' },
        createdAt: '2026-11-08T00:00:00.000Z',
      },
      all,
    )
    expect(bundle).toEqual({
      id: 'combo-1',
      name: '我的 INT8',
      description: 'my-dit.safetensors + Qwen3.5 W4A8 + FLUX.2 VAE Small',
      components: { dit: 'my-dit', textEncoder: 'qwen35-comfy-w4a8_gptq', vae: 'flux2-vae-small' },
      support: 'moss-runtime-config',
      recommended: false,
      custom: true,
    })
  })

  it('suggests a name from the 主模型 and 文本编码器', () => {
    const name = suggestedName(
      { dit: 'moss-sft-comfy-int8_convrot', textEncoder: 'qwen35-comfy-w4a8_gptq', vae: 'flux2-vae-small' },
      models(),
    )
    expect(name).toBe('SFT INT8 + Qwen3.5 W4A8')
    const ownFile = suggestedName(
      { dit: 'my-dit', textEncoder: 'qwen35-encoder', vae: 'flux2-vae-small' },
      models([], [own('my-dit', 'dit')]),
    )
    expect(ownFile).toBe('my-dit + Qwen3.5 BF16')
  })
})

describe('legacyLocalCombination', () => {
  it('keeps the old scanned-files model under its id, and nothing without a full set', () => {
    const trio = [own('d', 'dit'), own('t', 'text_encoder'), own('v', 'vae')]
    expect(legacyLocalCombination(trio, new Date('2026-11-08T00:00:00.000Z'))).toEqual({
      id: 'local-files',
      name: '电脑上的模型',
      components: { dit: 'd', textEncoder: 't', vae: 'v' },
      createdAt: '2026-11-08T00:00:00.000Z',
    })
    expect(legacyLocalCombination(trio.slice(0, 2))).toBeNull()
  })
})

describe('unusedDownloads', () => {
  it('finds downloads no model or saved combination needs, never the person’s own files', () => {
    const catalog = catalogFixture({
      installed: ['moss-sft-dit', 'moss-sft-comfy-int8_convrot', 'qwen35-comfy-w4a8_gptq', 'moss-runtime-config'],
    })
    const all = [...catalog.models, own('my-vae', 'vae'), { ...catalog.models[0]!, id: 'linked', tags: ['local-folder'], installed: true }]
    // The INT8 single file and the runtime configs belong to the certified model SFT INT8; the W4A8 encoder to no model.
    expect(unusedDownloads(all, catalog.bundles).map((model) => model.id)).toEqual(['qwen35-comfy-w4a8_gptq'])
    const combo = combinationBundle(
      {
        id: 'c',
        name: 'c',
        components: { dit: 'moss-sft-comfy-int8_convrot', textEncoder: 'qwen35-comfy-w4a8_gptq', vae: 'my-vae' },
        createdAt: '',
      },
      all,
    )
    expect(unusedDownloads(all, [...catalog.bundles, combo])).toEqual([])
  })
})
