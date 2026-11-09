import { describe, expect, it } from 'vitest'
import {
  LIMITED_VRAM_BYTES,
  bestBundleFor,
  cliGpuUuids,
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
    // Every model the catalog offers is one the engine runs.
    expect(catalog.bundles.filter((item) => !item.certified).map((item) => item.id)).toEqual([])
  })

  it('builds each single-file model from an INT8 text encoder, the small FLUX.2 VAE and the runtime configs', () => {
    for (const item of catalog.bundles.filter((entry) => entry.tier)) {
      expect(item.components).toMatchObject({ textEncoder: 'qwen35-comfy-int8_convrot', vae: 'flux2-vae-comfy-small' })
      expect(item.support).toBe('moss-runtime-config')
      const parts = [item.components.dit, item.components.textEncoder, item.components.vae].map((id) =>
        catalog.models.find((model) => model.id === id)!,
      )
      expect(parts.every((model) => model.format === 'comfyui' && model.family === 'moss-image')).toBe(true)
      // Files added for certification are pinned to the revision the engine tested. The Comfy-Org
      // files older app versions already download stay on main: older versions read this catalog
      // from main and would otherwise list those downloads as missing (the files are unchanged).
      for (const model of parts) {
        if (model.repo === 'Comfy-Org/MOSS-Image') expect(model.revision, model.id).toBe('main')
        else expect(model.revision, model.id).toMatch(/^[a-f0-9]{40}$/)
      }
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

  it('runs INT8 and INT4 on Turing and Volta (their SM75 / SM70 engine builds), but not NVFP4', () => {
    const v100 = gpuDeviceFixture({ name: 'Tesla V100', computeCapability: { major: 7, minor: 0 } })
    for (const device of [rtx4090, GPU_GTX_1660(), v100]) {
      expect(bundleGpuProblem(bundle('moss-sft-int8'), device)).toBeNull()
      expect(bundleGpuProblem(bundle('moss-sft-int4'), device)).toBeNull()
    }
    expect(bundleGpuProblem(bundle('moss-sft-nvfp4'), GPU_GTX_1660())).toBe('只能在 RTX 50 系列显卡上运行')
  })

  it('keeps quantized models off GPUs moss-server does not run them on', () => {
    const pascal = gpuDeviceFixture({ name: 'GTX 1080', computeCapability: { major: 6, minor: 1 } })
    expect(bundleGpuProblem(bundle('moss-sft-int8'), pascal)).toBe('在 GTX 1080 上用不了，这张显卡只能运行官方模型')
    expect(bundleGpuProblem(bundle('moss-sft-int8'), radeon)).toBe('需要 NVIDIA 显卡')
    expect(bundleGpuProblem(bundle('moss-sft'), pascal)).toBeNull()
    expect(bundleGpuProblem(bundle('moss-sft'), radeon)).toBeNull()
  })

  it('keeps single files off a GPU that runs a CLI engine (兼容模式 / AMD 原生)', () => {
    const problem = `${rtx4090.name} 上的引擎只能运行官方模型`
    expect(bundleGpuProblem(bundle('moss-sft-int8'), rtx4090, { cli: true })).toBe(problem)
    // A scanned set has no tier: the caller says it is made of files.
    expect(bundleGpuProblem({}, rtx4090, { cli: true, files: true })).toBe(problem)
    expect(bundleGpuProblem(bundle('moss-sft'), rtx4090, { cli: true, files: false })).toBeNull()
    expect(bundleGpusProblem(bundle('moss-sft-int8'), [rtx4090, rtx5090], { cliGpus: new Set([rtx4090.uuid]) })).toBeNull()
    expect(bundleGpusProblem(bundle('moss-sft-int8'), [rtx4090], { cliGpus: new Set([rtx4090.uuid]) })).toBe(problem)
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

  it('picks the official SFT on an RTX 50 card with VRAM to spare, and INT8 (not NVFP4) on one without', () => {
    expect(pick([rtx5090])).toEqual({
      bundle: bundle('moss-sft'),
      reason: 'NVIDIA GeForce RTX 5090 显存充足，可以用画质最原汁原味的官方模型',
    })
    const rtx5060 = gpuDeviceFixture({
      uuid: 'GPU-5060',
      name: 'NVIDIA GeForce RTX 5060',
      computeCapability: { major: 12, minor: 0 },
      memoryTotalBytes: 8 * 1024 ** 3,
    })
    expect(pick([rtx5060])?.bundle.id).toBe('moss-sft-int8')
  })

  it('picks INT8 when VRAM is limited', () => {
    expect(GPU_RTX_3060().memoryTotalBytes).toBeLessThan(LIMITED_VRAM_BYTES)
    expect(pick([GPU_RTX_3060()])?.bundle.id).toBe('moss-sft-int8')
    expect(pick([GPU_RTX_3060()])?.reason).toMatch(/显存不算多/)
  })

  it('picks the official SFT on a card with plenty of VRAM', () => {
    expect(pick([rtx4090])).toEqual({ bundle: bundle('moss-sft'), reason: expect.stringMatching(/显存充足/) })
  })

  it('judges the GPU automatic assignment prefers: newest architecture first, then most memory', () => {
    expect(pick([GPU_RTX_3060(), rtx4090])?.bundle.id).toBe('moss-sft')
    expect(pick([rtx4090, rtx5090])?.bundle.id).toBe('moss-sft')
    // A 32 GB V100 loses to a 12 GB RTX 3060, as in the scheduler.
    const v100 = gpuDeviceFixture({
      uuid: 'GPU-v100',
      name: 'Tesla V100',
      computeCapability: { major: 7, minor: 0 },
      memoryTotalBytes: 32 * 1024 ** 3,
    })
    expect(pick([v100, GPU_RTX_3060()])?.bundle.id).toBe('moss-sft-int8')
  })

  it('picks INT8 on a Turing card with little VRAM', () => {
    expect(pick([GPU_GTX_1660()])?.bundle.id).toBe('moss-sft-int8')
  })

  it('picks the official model on a GPU that runs a CLI engine, preferring one that runs moss-server', () => {
    expect(bestBundleFor(catalog.bundles, [GPU_RTX_3060()], new Set([GPU_RTX_3060().uuid]))).toEqual({
      bundle: bundle('moss-sft'),
      reason: `${GPU_RTX_3060().name} 上的引擎只能运行官方模型`,
    })
    // The 5090 runs 兼容模式; the 3060 runs moss-server and is the one judged.
    expect(bestBundleFor(catalog.bundles, [rtx5090, GPU_RTX_3060()], new Set([rtx5090.uuid]))?.bundle.id).toBe('moss-sft-int8')
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
    expect(profileForBundle(profile, bundle('moss-sft-int4'))).toEqual({ memoryMode: 'balanced', tier: 'turbo', source: 'model-weights' })
    expect(profileForBundle({ ...profile, tier: 'reference' }, bundle('moss-sft-int8'))).toMatchObject({
      tier: 'high',
      source: 'model-weights',
    })
  })

  it('keeps the GPU profile for a folder model', () => {
    expect(profileForBundle({ ...profile, tier: 'reference' }, bundle('moss-sft'))).toEqual({ ...profile, tier: 'reference' })
    expect(profileForBundle(profile, undefined)).toBe(profile)
  })
})

describe('cliGpuUuids', () => {
  it('lists the GPUs whose installed package is a CLI engine', () => {
    const devices = [
      { deviceUuid: 'a', name: 'A', packageId: 'cu13', path: null },
      { deviceUuid: 'b', name: 'B', packageId: 'vulkan', path: null },
      { deviceUuid: 'c', name: 'C', packageId: 'hip', path: null },
      { deviceUuid: 'd', name: 'D', packageId: null, path: null },
    ]
    expect([...cliGpuUuids({ devices })]).toEqual(['b', 'c'])
    expect(cliGpuUuids(null).size).toBe(0)
  })
})
