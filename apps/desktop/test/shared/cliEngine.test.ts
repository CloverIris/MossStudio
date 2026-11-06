import { describe, expect, it } from 'vitest'
import type { ModelEntry } from '@shared/types'
import {
  CLI_ENGINE_KINDS,
  cliBundleProblem,
  cliEngineFeatures,
  cliEngineNote,
  cliSamplingAccepted,
  isCliEngineKind,
} from '@shared/cliEngine'

type Part = Pick<ModelEntry, 'id' | 'provider' | 'format' | 'precision' | 'role'>
const part = (id: string, role: ModelEntry['role'], patch: Partial<Part> = {}): Part => ({
  id,
  provider: 'hf',
  format: 'diffusers',
  precision: 'bf16',
  role,
  ...patch,
})
const bundle = { name: 'MOSS-Image SFT', components: { dit: 'dit', textEncoder: 'te', vae: 'vae' } }
const parts = (patch: Partial<Record<'dit' | 'te' | 'vae', Partial<Part>>> = {}): Part[] => [
  part('dit', 'dit', patch.dit),
  part('te', 'text_encoder', patch.te),
  part('vae', 'vae', { precision: 'fp32', ...patch.vae }),
]

describe('cliEngineFeatures', () => {
  it.each(CLI_ENGINE_KINDS)('%s: text to image only, no preview, no LoRA', (kind) => {
    expect(cliEngineFeatures(kind)).toEqual({
      preview: false,
      imageInput: false,
      control: false,
      references: false,
      hires: false,
      samplers: false,
      lora: false,
      cli: kind,
      values: { sampler: ['euler'], scheduler: ['moss'] },
    })
  })

  it('names the engine in plain words in the quiet note', () => {
    expect(cliEngineNote('vulkan')).toBe(
      '这台设备用兼容模式引擎，只能文生图：LoRA、起始图、遮罩、控制、参考图、高清修复和更换采样器都不可用。',
    )
    expect(cliEngineNote('hip')).toContain('AMD 原生引擎')
    expect(isCliEngineKind('vulkan')).toBe(true)
    expect(isCliEngineKind('cuda')).toBe(false)
  })
})

describe('cliBundleProblem', () => {
  it('accepts the bf16 diffusers bundles (fp32 VAE included)', () => {
    expect(cliBundleProblem('vulkan', bundle, parts())).toBeNull()
  })

  it('refuses a fp16 DiT or a non-bf16 text encoder', () => {
    expect(cliBundleProblem('vulkan', bundle, parts({ dit: { precision: 'fp16' } }))).toBe(
      '「MOSS-Image SFT」不是 bf16 模型，兼容模式引擎只能用 bf16 的 MOSS-Image，请换一个模型',
    )
    expect(cliBundleProblem('hip', bundle, parts({ te: { precision: 'int8' } }))).toBe(
      '「MOSS-Image SFT」不是 bf16 模型，AMD 原生引擎只能用 bf16 的 MOSS-Image，请换一个模型',
    )
  })

  it('refuses scanned single files and ComfyUI files, whatever their precision', () => {
    const scanned = '「MOSS-Image SFT」是扫描到的单个模型文件，兼容模式引擎只能用完整的模型包，请在模型库下载 MOSS-Image（bf16）'
    expect(cliBundleProblem('vulkan', bundle, parts({ dit: { provider: 'local' } }))).toBe(scanned)
    expect(cliBundleProblem('vulkan', bundle, parts({ vae: { format: 'comfyui' } }))).toBe(scanned)
  })

  it('refuses a bundle whose parts the catalog does not describe: its precision cannot be checked', () => {
    expect(cliBundleProblem('vulkan', bundle, parts().slice(1))).toBe(
      '「MOSS-Image SFT」的模型文件不在模型库里，无法确认它是 bf16 模型包，兼容模式引擎用不了，请在模型库下载 MOSS-Image（bf16）',
    )
  })

  it('accepts no sampling choice, or exactly euler / moss', () => {
    expect(cliSamplingAccepted(undefined)).toBe(true)
    expect(cliSamplingAccepted({})).toBe(true)
    expect(cliSamplingAccepted({ sampler: 'euler', scheduler: 'moss' })).toBe(true)
    expect(cliSamplingAccepted({ sampler: 'heun' })).toBe(false)
    expect(cliSamplingAccepted({ sampler: 'euler', scheduler: 'karras' })).toBe(false)
  })
})
