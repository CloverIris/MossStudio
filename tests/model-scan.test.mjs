import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanModelDirectory } from '../apps/desktop/src/main/services/modelScan.ts'

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'moss-model-scan-'))
  for (const [relativePath, size] of Object.entries(files)) {
    const target = join(root, relativePath)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, Buffer.alloc(size, 1))
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('a ComfyUI tree is recognised by its directory names', async (t) => {
  const { root, cleanup } = await fixture({
    'diffusion_models/moss_image_sft_bf16.safetensors': 32,
    'text_encoders/qwen3.5_9b.safetensors': 16,
    'vae/flux2_vae_small.safetensors': 8,
    'loras/style.safetensors': 4,
  })
  t.after(cleanup)
  const result = await scanModelDirectory(root)
  assert.equal(result.files, 4)
  const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]))
  assert.equal(byName.get('moss_image_sft_bf16.safetensors')?.role, 'dit')
  assert.equal(byName.get('qwen3.5_9b.safetensors')?.role, 'text_encoder')
  assert.equal(byName.get('flux2_vae_small.safetensors')?.role, 'vae')
  assert.equal(byName.get('style.safetensors')?.role, 'lora')
  assert.ok(result.candidates.every((candidate) => candidate.layout === 'comfyui-single-file'))
})

test('a diffusers folder is reported as one package and not walked into', async (t) => {
  const { root, cleanup } = await fixture({
    'MOSS-Image-SFT/model_index.json': 2,
    'MOSS-Image-SFT/transformer/config.json': 2,
    'MOSS-Image-SFT/transformer/diffusion_pytorch_model.safetensors': 64,
  })
  t.after(cleanup)
  const result = await scanModelDirectory(root)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].layout, 'diffusers-folder')
  assert.equal(result.candidates[0].role, 'full')
  assert.equal(result.candidates[0].relativePath, 'MOSS-Image-SFT')
})

test('scanning never writes into the scanned directory', async (t) => {
  const { root, cleanup } = await fixture({
    'diffusion_models/model.safetensors': 16,
  })
  t.after(cleanup)
  const before = await readdir(root, { recursive: true })
  await scanModelDirectory(root)
  const after = await readdir(root, { recursive: true })
  assert.deepEqual(after.sort(), before.sort())
})

test('unknown roles are marked low confidence instead of being dropped', async (t) => {
  const { root, cleanup } = await fixture({ 'misc/weights.safetensors': 8 })
  t.after(cleanup)
  const result = await scanModelDirectory(root)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].role, 'full')
  assert.equal(result.candidates[0].confidence, 'low')
})
