import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { JobRecord } from '@shared/types'
import {
  assertTrashable,
  describePrompt,
  isMossSidecar,
  mergeSidecars,
  parseA1111,
  generationFromJob,
  generationFromSidecar,
  mergeSidecar,
  sidecarPath,
  sidecarRecord,
  sidecarsToTrash,
  whereLabel,
} from '@main/services/galleryMeta'

const root = join('/data', 'outputs')

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    instanceId: 'engine',
    instanceName: 'MOSS-Image SFT',
    mode: 'runner',
    state: 'succeeded',
    stage: 'ready',
    projectId: 'project-1',
    modelSnapshot: { bundleId: 'moss-sft', files: {} },
    gpuSnapshot: { index: 0, name: 'RTX 4090' },
    params: { prompt: 'a cat', negativePrompt: 'blurry', width: 1024, height: 768, steps: 20, cfg: 3, seed: 7, profile: 'base' },
    progress: { stage: 'ready', current: 20, total: 20, percent: 100 },
    startedAt: '2026-11-04T06:32:00.000Z',
    outputs: [{ path: join(root, 'job-1-1.png'), width: 1024, height: 768, seed: 42 }],
    ...patch,
  }
}

describe('whereLabel', () => {
  it('names the local GPU, or just 本机 without one', () => {
    expect(whereLabel({ gpuSnapshot: { index: 0, name: 'RTX 4090' } })).toBe('本机 · RTX 4090')
    expect(whereLabel({})).toBe('本机')
  })

  it('names a remote host by its display name, falling back to its id', () => {
    expect(whereLabel({ hostId: 'h1' }, '实验室服务器')).toBe('实验室服务器')
    expect(whereLabel({ hostId: 'h1' }, '  ')).toBe('h1')
  })
})

describe('generationFromJob', () => {
  it('takes size and seed from the output and the rest from the job', () => {
    expect(generationFromJob(job(), { width: 512, height: 512, seed: 42 })).toEqual({
      jobId: 'job-1',
      projectId: 'project-1',
      modelName: 'MOSS-Image SFT',
      modelBundleId: 'moss-sft',
      steps: 20,
      cfg: 3,
      width: 512,
      height: 512,
      seed: 42,
      adapters: undefined,
      createdAt: '2026-11-04T06:32:00.000Z',
      where: '本机 · RTX 4090',
      hostId: undefined,
      description: 'a cat',
    })
  })

  it('records the description and region count of a region layout', () => {
    const layout = JSON.stringify({ summary: { caption: '春日街景', canvas: 'single' }, items: [{ label: 'person' }, { label: 'text' }], bbox_coord_space: 'abs_centralized' })
    expect(generationFromJob(job({ params: { ...job().params, prompt: layout } }))).toMatchObject({ description: '春日街景', regions: 2 })
  })

  it('never reports NaN numbers', () => {
    const result = generationFromJob(job({ params: { ...job().params, seed: Number.NaN } }), { seed: Number.NaN })
    expect(result.seed).toBeUndefined()
  })

  it('falls back to job params and ignores a snapshot without a bundle id', () => {
    const result = generationFromJob(job({ modelSnapshot: 'weird', params: { ...job().params, adapters: [{ path: '/l.safetensors', strength: 0.8 }] } }))
    expect(result).toMatchObject({ width: 1024, height: 768, seed: 7, adapters: [{ path: '/l.safetensors', strength: 0.8 }] })
    expect(result.modelBundleId).toBeUndefined()
  })
})

describe('generationFromSidecar', () => {
  it('returns undefined for a missing or uninformative sidecar', () => {
    expect(generationFromSidecar(null)).toBeUndefined()
    expect(generationFromSidecar({ prompt: 'only a prompt', engine: 'mossinfer' })).toBeUndefined()
  })

  it('reads engine fields and the fields MossStudio adds, tolerating strings', () => {
    expect(
      generationFromSidecar({
        seed: '42',
        width: 1024,
        height: 1024,
        steps: 8,
        cfg: '1.5',
        model_name: 'MOSS-Image SFT',
        model_bundle_id: 'moss-sft',
        project_id: 'p',
        job_id: 'j',
        where: '本机',
        created_at: '2026-11-04T00:00:00.000Z',
        adapters: [{ path: '/a', strength: 1 }, { path: 3 }, null],
      }),
    ).toEqual({
      seed: 42,
      width: 1024,
      height: 1024,
      steps: 8,
      cfg: 1.5,
      modelName: 'MOSS-Image SFT',
      modelBundleId: 'moss-sft',
      projectId: 'p',
      jobId: 'j',
      where: '本机',
      createdAt: '2026-11-04T00:00:00.000Z',
      adapters: [{ path: '/a', strength: 1 }],
    })
  })

  it('drops non-numeric numbers', () => {
    expect(generationFromSidecar({ seed: 'abc', steps: '', model: 'x' })).toEqual({ modelName: 'x' })
  })
})

describe('sidecarRecord / mergeSidecar', () => {
  it('records project, model and parameters without undefined keys', () => {
    const record = sidecarRecord(job(), { width: 1024, height: 768, seed: 42 })
    expect(record).toEqual({
      prompt: 'a cat',
      negative_prompt: 'blurry',
      seed: 42,
      width: 1024,
      height: 768,
      steps: 20,
      cfg: 3,
      model_name: 'MOSS-Image SFT',
      model_bundle_id: 'moss-sft',
      job_id: 'job-1',
      project_id: 'project-1',
      created_at: '2026-11-04T06:32:00.000Z',
      where: '本机 · RTX 4090',
      description: 'a cat',
    })
    expect(generationFromSidecar(record)).toMatchObject({ projectId: 'project-1', steps: 20, cfg: 3, seed: 42 })
  })

  it('never overwrites what the engine already wrote', () => {
    expect(mergeSidecar({ seed: 1, tier: 'high' }, { seed: 2, steps: 8 })).toEqual({ seed: 1, tier: 'high', steps: 8 })
    expect(mergeSidecar(null, { steps: 8 })).toEqual({ steps: 8 })
  })

  it('writes the sidecar next to the image with a .json extension', () => {
    expect(sidecarPath(join(root, 'a.png'))).toBe(join(root, 'a.json'))
    expect(sidecarPath(join(root, 'b.v2.webp'))).toBe(join(root, 'b.v2.json'))
  })
})

describe('assertTrashable', () => {
  const extra = join('/home', 'me', 'pictures')

  it('accepts an image inside any root and returns that root', () => {
    expect(assertTrashable(join(root, 'a.png'), [root, extra])).toBe(root)
    expect(assertTrashable(join(extra, 'deep', 'b.JPG'), [root, extra])).toBe(extra)
  })

  it('refuses non-images, the root itself, outside paths and traversal look-alikes', () => {
    expect(() => assertTrashable(join(root, 'notes.txt'), [root])).toThrow('只能删除图片文件')
    expect(() => assertTrashable(join(root, 'a.json'), [root])).toThrow('只能删除图片文件')
    expect(() => assertTrashable(join('/etc', 'a.png'), [root])).toThrow('不在作品目录中')
    expect(() => assertTrashable(join('/data', 'outputs-evil', 'a.png'), [root])).toThrow('不在作品目录中')
    expect(() => assertTrashable(join(root, '..', 'a.png'), [root])).toThrow('不在作品目录中')
    expect(() => assertTrashable(join(root, 'a.png'), [])).toThrow('不在作品目录中')
  })

  it('refuses a root that is itself named like an image', () => {
    const odd = join('/data', 'weird.png')
    expect(() => assertTrashable(odd, [odd])).toThrow('不在作品目录中')
  })
})

describe('sidecarsToTrash', () => {
  const image = join(root, 'a.png')
  const moss = (): unknown => ({ engine: 'mossinfer', seed: 1 })

  it('takes both sidecars when they exist, MossStudio wrote the stem one and no sibling shares the name', () => {
    const files = new Set([image, `${image}.json`, join(root, 'a.json')])
    expect(sidecarsToTrash(image, (path) => files.has(path), moss)).toEqual([`${image}.json`, join(root, 'a.json')])
  })

  it('never trashes an unrelated JSON that only shares the name', () => {
    const files = new Set([image, join(root, 'a.json')])
    expect(sidecarsToTrash(image, (path) => files.has(path), () => ({ nodes: [], links: [] }))).toEqual([])
    expect(sidecarsToTrash(image, (path) => files.has(path), () => undefined)).toEqual([])
    expect(sidecarsToTrash(image, (path) => files.has(path), () => ({ job_id: 'j' }))).toEqual([join(root, 'a.json')])
  })

  it('keeps the stem sidecar when another image with the same name remains', () => {
    const files = new Set([image, join(root, 'a.jpg'), join(root, 'a.json')])
    expect(sidecarsToTrash(image, (path) => files.has(path), moss)).toEqual([])
  })

  it('returns nothing when there is no sidecar', () => {
    expect(sidecarsToTrash(image, (path) => path === image, moss)).toEqual([])
  })
})

describe('sidecar recognition', () => {
  it('knows what MossStudio and its engine write', () => {
    expect(isMossSidecar({ job_id: 'j' })).toBe(true)
    expect(isMossSidecar({ project_id: 'p' })).toBe(true)
    expect(isMossSidecar({ engine: 'mossinfer', prompt: 'x' })).toBe(true)
    expect(isMossSidecar({ prompt: 'x' })).toBe(false)
    expect(isMossSidecar([])).toBe(false)
    expect(isMossSidecar(null)).toBe(false)
  })

  it('merges image.json over image.png.json and ignores non-metadata JSON', () => {
    expect(mergeSidecars({ prompt: 'own', seed: 1 }, { prompt: 'stem', steps: 8 })).toEqual({ prompt: 'stem', seed: 1, steps: 8 })
    expect(mergeSidecars({ prompt: 'own' }, { nodes: [] })).toEqual({ prompt: 'own' })
    expect(mergeSidecars(undefined, [1, 2])).toBeNull()
  })
})

describe('describePrompt / parseA1111', () => {
  it('returns the caption of a compiled region layout', () => {
    expect(describePrompt(JSON.stringify({ summary: { caption: ' 海报 ' }, items: [{}] }))).toEqual({ description: '海报', regions: 1 })
    expect(describePrompt('{not json')).toEqual({ description: '{not json', regions: 0 })
    expect(describePrompt(JSON.stringify({ other: true }))).toEqual({ description: '{"other":true}', regions: 0 })
    expect(describePrompt(undefined)).toEqual({ description: '', regions: 0 })
  })

  it('strips the A1111 settings tail', () => {
    const text = 'a red bike,\nat dusk\nNegative prompt: blurry, lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7.5, Seed: 123, Size: 512x768, Model: sdxl, Lora hashes: "a: 1, b: 2"'
    expect(parseA1111(text)).toEqual({
      prompt: 'a red bike,\nat dusk', negativePrompt: 'blurry, lowres', steps: 20, cfg: 7.5, seed: 123, width: 512, height: 768, modelName: 'sdxl',
    })
    expect(describePrompt(text).description).toBe('a red bike,\nat dusk')
    expect(parseA1111('Steps: 4, Seed: 1')).toMatchObject({ prompt: '', steps: 4, seed: 1 })
  })

  it('leaves a plain prompt alone', () => {
    expect(parseA1111('a cat\nsteps: 4')).toBeNull()
    expect(describePrompt('a cat').description).toBe('a cat')
  })
})
