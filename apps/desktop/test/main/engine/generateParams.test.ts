import { describe, expect, it } from 'vitest'
import type { JobParams } from '@shared/types'
import {
  MASK_ENCODING,
  buildGenerateParams,
  jobInputFiles,
  outputSizeOf,
  previewEveryFor,
  rewriteJobInputPaths,
} from '@main/services/generateParams'

const base: JobParams = {
  prompt: 'a cat',
  negativePrompt: 'blurry',
  width: 1024,
  height: 768,
  steps: 30,
  cfg: 4.5,
  seed: 7,
  profile: 'base',
}

const full: JobParams = {
  ...base,
  initImage: { path: '/p/assets/init.png', strength: 0.6, resize: 'fit' },
  mask: { path: '/p/assets/mask-c1-ab.png' },
  control: {
    adapter: '/m/control.safetensors',
    loraStrength: 0.8,
    images: [
      { kind: 'depth', path: '/p/assets/depth.png', strength: 1, start: 0, end: 1 },
      { kind: 'canny', path: '/p/assets/edges.png', strength: 0.5, start: 0.1, end: 0.7 },
    ],
  },
  references: { paths: ['/p/assets/ref1.png', '/p/assets/ref2.jpg'], maxEdge: 1024 },
  sampling: {
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
    shift: 3,
    hires: { width: 1536, height: 1152, steps: 12, strength: 0.4 },
    stepCache: 'fbcache',
    cfgTruncation: 0.5,
  },
}

describe('buildGenerateParams', () => {
  it('sends only the base request when nothing else is set', () => {
    expect(buildGenerateParams(base, { output: '/o/x.png' })).toEqual({
      output: '/o/x.png',
      prompt: 'a cat',
      negative_prompt: 'blurry',
      width: 1024,
      height: 768,
      steps: 30,
      cfg: 4.5,
      seed: 7,
      save_metadata: true,
      include_prompts: true,
    })
  })

  it('maps every input to the engine spelling (main.cpp request_params)', () => {
    const out = buildGenerateParams(full, {
      output: '/o/x.png',
      loras: [{ path: '/m/style.safetensors', strength: 0.7 }],
      previewOutput: '/cache/previews/job-1.png',
      previewEvery: 2,
    })
    expect(out).toMatchObject({
      loras: [{ path: '/m/style.safetensors', strength: 0.7 }],
      init_image: '/p/assets/init.png',
      denoise_strength: 0.6,
      resize: 'fit',
      mask: '/p/assets/mask-c1-ab.png',
      mask_encoding: 'u8',
      control: {
        adapter: '/m/control.safetensors',
        lora_strength: 0.8,
        images: [
          { kind: 'depth', path: '/p/assets/depth.png', strength: 1, start: 0, end: 1 },
          { kind: 'canny', path: '/p/assets/edges.png', strength: 0.5, start: 0.1, end: 0.7 },
        ],
      },
      references: { images: ['/p/assets/ref1.png', '/p/assets/ref2.jpg'], max_edge: 1024 },
      sampler: 'dpmpp_2m',
      scheduler: 'karras',
      shift: 3,
      hires: { width: 1536, height: 1152, steps: 12, strength: 0.4 },
      step_cache: 'fbcache',
      cfg_truncation: 0.5,
      preview_output: '/cache/previews/job-1.png',
      preview_every: 2,
    })
    // Only parameters generate() accepts (its p.only list), never our own names.
    const accepted = new Set([
      'output',
      'prompt',
      'negative_prompt',
      'width',
      'height',
      'steps',
      'cfg',
      'shift',
      'seed',
      'sampler',
      'scheduler',
      'loras',
      'save_metadata',
      'include_prompts',
      'preview_output',
      'preview_every',
      'init_image',
      'mask',
      'mask_encoding',
      'denoise_strength',
      'resize',
      'hires',
      'control',
      'cfg_truncation',
      'step_cache',
      'references',
    ])
    expect(Object.keys(out).filter((key) => !accepted.has(key))).toEqual([])
  })

  it('masks our 8-bit white-is-repaint PNGs with the u8 encoding', () => {
    expect(MASK_ENCODING).toBe('u8')
  })

  it('leaves out every optional member that is not set', () => {
    const out = buildGenerateParams(
      {
        ...base,
        initImage: { path: '/a.png', strength: 0 },
        control: { adapter: '/c.safetensors', images: [] },
        references: { paths: ['/r.png'] },
        sampling: { hires: { width: 1024, height: 768 } },
      },
      { output: '/o.png', loras: [] },
    )
    expect(out['init_image']).toBe('/a.png')
    expect(out['denoise_strength']).toBe(0)
    expect(out).not.toHaveProperty('resize')
    expect(out).not.toHaveProperty('mask')
    expect(out).not.toHaveProperty('mask_encoding')
    expect(out).not.toHaveProperty('loras')
    expect(out['control']).toEqual({ adapter: '/c.safetensors' })
    expect(out['references']).toEqual({ images: ['/r.png'] })
    expect(out['hires']).toEqual({ width: 1024, height: 768 })
    for (const key of ['sampler', 'scheduler', 'shift', 'step_cache', 'cfg_truncation', 'preview_output', 'preview_every']) {
      expect(out).not.toHaveProperty(key)
    }
  })

  it('never sends a mask without a start picture (the engine refuses one)', () => {
    expect(buildGenerateParams({ ...base, mask: { path: '/m.png' } }, { output: '/o.png' })).not.toHaveProperty('mask')
  })

  it('keeps preview_every out without a preview file', () => {
    expect(buildGenerateParams(base, { output: '/o.png', previewEvery: 2 })).not.toHaveProperty('preview_every')
    expect(buildGenerateParams(base, { output: '/o.png', previewOutput: '/p.png' })).toMatchObject({ preview_output: '/p.png' })
  })
})

describe('outputSizeOf', () => {
  it('is the requested size, or the hires pass size when there is one', () => {
    expect(outputSizeOf(base)).toEqual({ width: 1024, height: 768 })
    expect(outputSizeOf(full)).toEqual({ width: 1536, height: 1152 })
    expect(outputSizeOf({ ...base, sampling: { sampler: 'euler' } })).toEqual({ width: 1024, height: 768 })
  })
})

describe('previewEveryFor', () => {
  it('previews every step on short runs and about 15 frames on long ones', () => {
    expect(previewEveryFor(1)).toBe(1)
    expect(previewEveryFor(8)).toBe(1)
    expect(previewEveryFor(30)).toBe(2)
    expect(previewEveryFor(100)).toBe(7)
  })
})

describe('jobInputFiles / rewriteJobInputPaths', () => {
  it('lists every input picture in a stable order, without the control adapter', () => {
    expect(jobInputFiles(full)).toEqual([
      { role: 'init', index: 0, path: '/p/assets/init.png' },
      { role: 'mask', index: 0, path: '/p/assets/mask-c1-ab.png' },
      { role: 'control', index: 0, path: '/p/assets/depth.png' },
      { role: 'control', index: 1, path: '/p/assets/edges.png' },
      { role: 'reference', index: 0, path: '/p/assets/ref1.png' },
      { role: 'reference', index: 1, path: '/p/assets/ref2.jpg' },
    ])
    expect(jobInputFiles(base)).toEqual([])
  })

  it('rewrites every picture path and nothing else', () => {
    const rewritten = rewriteJobInputPaths(full, (path) => `/remote${path}`)
    expect(rewritten.initImage).toEqual({ path: '/remote/p/assets/init.png', strength: 0.6, resize: 'fit' })
    expect(rewritten.mask).toEqual({ path: '/remote/p/assets/mask-c1-ab.png' })
    expect(rewritten.control?.adapter).toBe('/m/control.safetensors')
    expect(rewritten.control?.images.map((image) => image.path)).toEqual(['/remote/p/assets/depth.png', '/remote/p/assets/edges.png'])
    expect(rewritten.references).toEqual({ paths: ['/remote/p/assets/ref1.png', '/remote/p/assets/ref2.jpg'], maxEdge: 1024 })
    expect(rewritten.sampling).toEqual(full.sampling)
    expect(full.initImage?.path).toBe('/p/assets/init.png')
    expect(rewriteJobInputPaths(base, (path) => `/x${path}`)).toEqual(base)
  })
})
