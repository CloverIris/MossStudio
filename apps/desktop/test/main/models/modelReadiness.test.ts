import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyModelReady, resolveLegacyModelPath } from '@main/services/modelReadiness'
import { useTempDir } from '@test/helpers/tempDir'

const tempDir = useTempDir('mossstudio-legacy-model-')
const SHA = 'e'.repeat(40)

function put(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
}

const fullModel: Record<string, string> = {
  'model_index.json': '{}',
  'pipeline_moss_image.py': '#',
  'scheduler/scheduler_config.json': '{}',
  'transformer/config.json': '{}',
  'transformer/diffusion_pytorch_model.safetensors': 'dit',
  'text_encoder/config.json': '{}',
  'text_encoder/model.safetensors': 'te',
  'tokenizer/tokenizer_config.json': '{}',
  'tokenizer/tokenizer.json': '{}',
  'vae/config.json': '{}',
  'vae/diffusion_pytorch_model.safetensors': 'vae',
}

describe('resolveLegacyModelPath', () => {
  it('returns a diffusers folder as-is', async () => {
    put(tempDir(), { 'model_index.json': '{}' })
    expect(await resolveLegacyModelPath(tempDir())).toBe(tempDir())
  })

  it('follows refs/main into an HF cache snapshot', async () => {
    put(tempDir(), { 'refs/main': `${SHA}\n` })
    expect(await resolveLegacyModelPath(tempDir())).toBe(join(tempDir(), 'snapshots', SHA))
  })

  it('rejects a ref that is not a commit sha and a missing folder', async () => {
    put(tempDir(), { 'refs/main': '../../etc' })
    expect(await resolveLegacyModelPath(tempDir())).toBeNull()
    expect(await resolveLegacyModelPath(join(tempDir(), 'missing'))).toBeNull()
  })
})

describe('legacyModelReady', () => {
  it('accepts a complete full model in a cache snapshot', async () => {
    put(tempDir(), { 'refs/main': SHA })
    put(join(tempDir(), 'snapshots', SHA), fullModel)
    expect(await legacyModelReady(tempDir())).toBe(true)
  })

  it('accepts a plain diffusers folder and ignores partial downloads', async () => {
    put(tempDir(), { ...fullModel, 'vae/extra.safetensors.part': 'partial' })
    expect(await legacyModelReady(tempDir())).toBe(true)
  })

  it.each([
    'vae/config.json',
    'tokenizer/tokenizer.json',
    'scheduler/scheduler_config.json',
    'transformer/diffusion_pytorch_model.safetensors',
  ])('is not ready without %s', async (missing) => {
    const files = { ...fullModel }
    delete files[missing]
    put(tempDir(), files)
    expect(await legacyModelReady(tempDir())).toBe(false)
  })

  it('is not ready when the path cannot be resolved', async () => {
    expect(await legacyModelReady(join(tempDir(), 'missing'))).toBe(false)
  })
})
