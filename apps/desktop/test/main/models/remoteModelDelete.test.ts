import { describe, expect, it } from 'vitest'
import { assertSafeSteps, ownedPaths, planRemoteDelete, type RemoteEntryFiles } from '@main/services/remoteModelDelete'
import catalog from '../../../../../release/models.json'

const ROOT = '/home/u/.mossstudio/models'
const SFT = `${ROOT}/hf/hub/models--OpenMOSS-Team--MOSS-Image-SFT/snapshots/abc`
const FP16 = `${ROOT}/hf/hub/models--KBlueLeaf--MOSS-Image-FP16-fixed/snapshots/def`

const patterns = (id: string): string[] => (catalog.models.find((model) => model.id === id)?.files ?? []) as string[]
const entry = (id: string, base = SFT): RemoteEntryFiles => ({ id, base, patterns: patterns(id) })

/** What an SFT snapshot with the runtime config looks like on disk. */
const sftFiles = [
  'model_index.json', 'pipeline_moss_image.py', 'scheduler/scheduler_config.json',
  'transformer/config.json', 'transformer/diffusion_pytorch_model-00001-of-00002.safetensors', 'transformer/diffusion_pytorch_model-00002-of-00002.safetensors',
  'text_encoder/config.json', 'text_encoder/model.safetensors', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json', 'tokenizer/chat_template.jinja',
  'vae/config.json', 'vae/diffusion_pytorch_model.safetensors',
].map((file) => `${SFT}/${file}`)

describe('ownedPaths', () => {
  it('turns catalog patterns into owned folders and files', () => {
    expect(ownedPaths(['transformer/*'])).toEqual(['transformer'])
    expect(ownedPaths(['text_encoder/*', 'tokenizer/*'])).toEqual(['text_encoder', 'tokenizer'])
    expect(ownedPaths(['model_index.json', './scheduler/*'])).toEqual(['model_index.json', 'scheduler'])
    expect(ownedPaths([])).toEqual([''])
    expect(ownedPaths(['  '])).toEqual([''])
    expect(ownedPaths(['../escape/*', 'a/*/b'])).toEqual([])
  })
})

describe('planRemoteDelete', () => {
  it('deleting the SFT model keeps the shared encoder, VAE and configuration in the same snapshot', () => {
    const plan = planRemoteDelete([entry('moss-sft-dit')], [entry('qwen35-encoder'), entry('flux2-vae-small'), entry('moss-pipeline')], sftFiles)
    expect(plan.steps).toEqual([{ path: `${SFT}/transformer`, recursive: true }])
    expect(plan.steps.some((step) => step.path === SFT)).toBe(false)
  })

  it('removes only the files nobody keeps when a kept entry needs one inside the folder', () => {
    const plan = planRemoteDelete([entry('moss-sft-dit'), entry('qwen35-encoder')], [entry('moss-runtime-config')], sftFiles)
    expect(plan.steps).toEqual([
      { path: `${SFT}/transformer/diffusion_pytorch_model-00001-of-00002.safetensors`, recursive: false },
      { path: `${SFT}/transformer/diffusion_pytorch_model-00002-of-00002.safetensors`, recursive: false },
      { path: `${SFT}/text_encoder/model.safetensors`, recursive: false },
    ])
    expect(plan.kept).toEqual(expect.arrayContaining([`${SFT}/transformer`, `${SFT}/text_encoder`, `${SFT}/tokenizer`]))
  })

  it('leaves a path alone when a kept entry owns it or a folder around it', () => {
    const plan = planRemoteDelete([entry('moss-pipeline')], [entry('moss-runtime-config')], sftFiles)
    expect(plan.steps).toEqual([])
    expect(plan.kept.sort()).toEqual([`${SFT}/model_index.json`, `${SFT}/pipeline_moss_image.py`, `${SFT}/scheduler`].sort())
  })

  it('deletes the whole model when nothing else in the snapshot stays', () => {
    const all = ['moss-sft-dit', 'qwen35-encoder', 'flux2-vae-small', 'moss-pipeline'].map((id) => entry(id))
    const plan = planRemoteDelete(all, [], sftFiles)
    expect(plan.steps.map((step) => step.path).sort()).toEqual(
      ['transformer', 'text_encoder', 'tokenizer', 'vae', 'model_index.json', 'pipeline_moss_image.py', 'scheduler'].map((path) => `${SFT}/${path}`).sort(),
    )
    expect(plan.steps.every((step) => step.recursive)).toBe(true)
  })

  it('keeps the other FP16-fixed variant that shares the snapshot', () => {
    const files = ['base/transformer/a.safetensors', 'sft/transformer/b.safetensors', 'comfyui/moss_image_sft_fp16_fixed.safetensors'].map((file) => `${FP16}/${file}`)
    const plan = planRemoteDelete([entry('moss-sft-fp16-fixed', FP16)], [entry('moss-base-fp16-fixed', FP16), entry('moss-sft-fp16-fixed-comfy', FP16)], files)
    expect(plan.steps).toEqual([{ path: `${FP16}/sft/transformer`, recursive: true }])
  })

  it('ignores kept entries from other folders and deletes a folder with no patterns only when alone', () => {
    const other: RemoteEntryFiles = { id: 'x', base: `${ROOT}/plain/x`, patterns: [] }
    expect(planRemoteDelete([other], [entry('qwen35-encoder')], []).steps).toEqual([{ path: `${ROOT}/plain/x`, recursive: true }])
    expect(planRemoteDelete([other], [{ ...other, id: 'y' }], []).steps).toEqual([])
  })
})

describe('assertSafeSteps', () => {
  it('accepts steps inside the entry folder inside the root', () => {
    expect(() => assertSafeSteps([{ path: `${SFT}/transformer`, recursive: true }], ROOT, [SFT])).not.toThrow()
    expect(() => assertSafeSteps([{ path: SFT, recursive: true }], `${ROOT}/`, [SFT])).not.toThrow()
  })

  it('refuses anything outside, traversal and a base outside the root', () => {
    expect(() => assertSafeSteps([{ path: '/home/u/other', recursive: true }], ROOT, [SFT])).toThrow('不在模型文件夹中')
    expect(() => assertSafeSteps([{ path: `${SFT}/../../x`, recursive: true }], ROOT, [SFT])).toThrow('无效')
    expect(() => assertSafeSteps([], ROOT, ['/etc/models--x/snapshots/a'])).toThrow('不在模型目录中')
    expect(() => assertSafeSteps([], ROOT, [ROOT])).toThrow('不在模型目录中')
  })
})
