import { describe, expect, it } from 'vitest'
import {
  LIMITED_VRAM_BYTES,
  bestBundleFor,
  bundleGpuProblem,
  bundleGpusProblem,
  generationGpus,
  isFileBundle,
  profileForBundle,
} from '@shared/bundleFit'
import type { GpuInventoryDevice, ModelBundle } from '@shared/types'
import { GPU_GTX_1660, GPU_RTX_3060, catalogFixture, gpuDeviceFixture } from '@test/mocks/backend/fixtures'

const catalog = catalogFixture()
const bundle = (id: string): ModelBundle => catalog.bundles.find((item) => item.id === id)!
const rtx4090 = gpuDeviceFixture()
const rtx5090 = gpuDeviceFixture({
  uuid: 'GPU-5090',
  name: 'NVIDIA GeForce RTX 5090',
  computeCapability: { major: 12, minor: 0 },
  memoryTotalBytes: 32 * 1024 ** 3,
})
const radeon: GpuInventoryDevice = {
  uuid: 'vk-0',
  index: 0,
  name: 'AMD Radeon RX 7900 XTX',
  vendor: 'amd',
  memoryTotalBytes: 24 * 1024 ** 3,
}

describe('the certified catalog', () => {
  it('offers every model the engine certifies, single files with the tier they need', () => {
    const certified = catalog.bundles.filter((item) => item.certified)
    expect(certified.map((item) => [item.id, item.tier ?? null])).toEqual([
      ['moss-sft', null],
      ['moss-base', null],
      ['moss-sft-int8', 'high'],
      ['moss-sft-nvfp4', 'turbo'],
      ['moss-sft-int4', 'turbo'],
      ['moss-sft-turbo-int8', 'high'],
      ['moss-base-int8', 'high'],
    ])
    // The FP16-fixed community bundles are not on the engine's list.
    expect(catalog.bundles.filter((item) => !item.certified).map((item) => item.id)).toEqual(['moss-sft-fp16', 'moss-base-fp16'])
  })

  it('builds each single-file model from an INT8 text encoder, the small FLUX.2 VAE and the runtime configs', () => {
    for (const item of catalog.bundles.filter((entry) => entry.tier)) {
      expect(item.components).toMatchObject({ textEncoder: 'qwen35-comfy-int8_convrot', vae: 'flux2-vae-comfy-small' })
      expect(item.support).toBe('moss-runtime-config')
      const parts = [item.components.dit, item.components.textEncoder, item.components.vae].map((id) =>
        catalog.models.find((model) => model.id === id)!,
      )
      expect(parts.every((model) => model.format === 'comfyui' && model.family === 'moss-image')).toBe(true)
      // Pinned to the revision whose files the engine tested (a full commit sha).
      expect(parts.every((model) => /^[a-f0-9]{40}$/.test(model.revision))).toBe(true)
    }
  })

  it('gives Turbo its 8 steps and CFG 1, and NVFP4 its GPU', () => {
    expect(bundle('moss-sft-turbo-int8').defaults).toEqual({ steps: 8, cfg: 1 })
    expect(bundle('moss-sft-nvfp4').requires).toEqual({ computeCapability: { major: 12, minor: 0 }, label: 'RTX 50 系列显卡' })
  })
})

describe('isFileBundle', () => {
  it('tells single-file models from folder ones', () => {
    expect(isFileBundle(bundle('moss-sft-int8'), catalog.models)).toBe(true)
    expect(isFileBundle(bundle('moss-sft'), catalog.models)).toBe(false)
    expect(
      isFileBundle({ components: { dit: 'local-dit', textEncoder: 'x', vae: 'y' } }, [
        { id: 'local-dit', provider: 'local', format: 'comfyui' },
      ]),
    ).toBe(true)
  })
})

describe('bundleGpuProblem', () => {
  it('keeps NVFP4 to compute capability 12.0', () => {
    expect(bundleGpuProblem(bundle('moss-sft-nvfp4'), rtx5090)).toBeNull()
    expect(bundleGpuProblem(bundle('moss-sft-nvfp4'), rtx4090)).toBe('只能在 RTX 50 系列显卡上运行')
    expect(bundleGpuProblem(bundle('moss-sft-nvfp4'), gpuDeviceFixture({ computeCapability: { major: 12, minor: 1 } }))).not.toBeNull()
    expect(bundleGpuProblem(bundle('moss-sft-nvfp4'), gpuDeviceFixture({ computeCapability: undefined }))).not.toBeNull()
  })

  it('keeps quantized models off GPUs without the engine tiers they need', () => {
    expect(bundleGpuProblem(bundle('moss-sft-int8'), rtx4090)).toBeNull()
    expect(bundleGpuProblem(bundle('moss-sft-int8'), GPU_GTX_1660())).toBe('在 NVIDIA GeForce GTX 1660 上用不了，这张显卡只能运行官方模型')
    expect(bundleGpuProblem(bundle('moss-sft-int8'), radeon)).toBe('需要 NVIDIA 显卡')
    expect(bundleGpuProblem(bundle('moss-sft'), GPU_GTX_1660())).toBeNull()
    expect(bundleGpuProblem(bundle('moss-sft'), radeon)).toBeNull()
  })

  it('is fine when one of several GPUs runs it, and rules nothing out while they are unknown', () => {
    expect(bundleGpusProblem(bundle('moss-sft-nvfp4'), [rtx4090, rtx5090])).toBeNull()
    expect(bundleGpusProblem(bundle('moss-sft-nvfp4'), [rtx4090])).not.toBeNull()
    expect(bundleGpusProblem(bundle('moss-sft-nvfp4'), [])).toBeNull()
  })
})

describe('generationGpus', () => {
  it('uses the GPU picked in 设置, else every enabled one', () => {
    const devices = [rtx4090, rtx5090]
    expect(generationGpus(devices, { gpuSelection: 'auto', disabledDevices: [] })).toEqual(devices)
    expect(generationGpus(devices, { gpuSelection: 'auto', disabledDevices: [rtx5090.uuid] })).toEqual([rtx4090])
    expect(generationGpus(devices, { gpuSelection: { uuid: rtx5090.uuid }, disabledDevices: [] })).toEqual([rtx5090])
    // A picked GPU that is gone (or disabled) falls back to the others.
    expect(generationGpus(devices, { gpuSelection: { uuid: 'gone' }, disabledDevices: [] })).toEqual(devices)
    expect(generationGpus(undefined, null)).toEqual([])
  })
})

describe('bestBundleFor', () => {
  const pick = (devices: GpuInventoryDevice[]) => bestBundleFor(catalog.bundles, devices)

  it('picks NVFP4 on an RTX 50 card', () => {
    expect(pick([rtx5090])).toEqual({ bundle: bundle('moss-sft-nvfp4'), reason: '为 NVIDIA GeForce RTX 5090 这类显卡做的版本，速度最快' })
  })

  it('picks INT8 when VRAM is limited', () => {
    expect(GPU_RTX_3060().memoryTotalBytes).toBeLessThan(LIMITED_VRAM_BYTES)
    expect(pick([GPU_RTX_3060()])?.bundle.id).toBe('moss-sft-int8')
    expect(pick([GPU_RTX_3060()])?.reason).toMatch(/显存不算多/)
  })

  it('picks the official SFT on a card with plenty of VRAM', () => {
    expect(pick([rtx4090])).toEqual({ bundle: bundle('moss-sft'), reason: expect.stringMatching(/显存充足/) })
  })

  it('judges by the largest NVIDIA GPU', () => {
    expect(pick([GPU_RTX_3060(), rtx4090])?.bundle.id).toBe('moss-sft')
  })

  it('never picks a model the GPU cannot run', () => {
    // 6 GB, but only the official model runs on it.
    expect(pick([GPU_GTX_1660()])?.bundle.id).toBe('moss-sft')
  })

  it('falls back to the recommended model without a known NVIDIA GPU', () => {
    expect(pick([])).toEqual({ bundle: bundle('moss-sft'), reason: null })
    expect(pick([radeon])).toEqual({ bundle: bundle('moss-sft'), reason: null })
    expect(bestBundleFor([], [])).toBeNull()
  })

  it('works with a catalog that certifies nothing (an old one)', () => {
    const old = catalog.bundles.map((item) => ({ ...item, certified: undefined }))
    expect(bestBundleFor(old, [GPU_RTX_3060()])?.bundle.id).toBe('moss-sft')
  })
})

describe('profileForBundle', () => {
  const profile = { memoryMode: 'balanced' as const, tier: 'high' as const, source: 'global' as const }

  it('runs a quantized model with its own tier', () => {
    expect(profileForBundle(profile, bundle('moss-sft-int4'))).toEqual({ memoryMode: 'balanced', tier: 'turbo', source: 'bundle' })
    expect(profileForBundle({ ...profile, tier: 'reference' }, bundle('moss-sft-int8'))).toMatchObject({ tier: 'high', source: 'bundle' })
  })

  it('keeps the GPU profile for a folder model', () => {
    expect(profileForBundle({ ...profile, tier: 'reference' }, bundle('moss-sft'))).toEqual({ ...profile, tier: 'reference' })
    expect(profileForBundle(profile, undefined)).toBe(profile)
  })
})
