import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobParams, JobRecord } from '@shared/types'
import { generationFromJob, generationFromSidecar, jobInputsSidecar, sidecarRecord } from '@main/services/galleryMeta'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'

const dataRoot = useTempDataRoot()
const outside = useTempDir('mossstudio-pictures-out-')
let gallery: typeof import('@main/services/gallery')

beforeEach(async () => {
  vi.resetModules()
  gallery = await import('@main/services/gallery')
})

function put(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'png')
  return path
}

describe('studioPicturePath (what clover:// serves beyond the gallery)', () => {
  const allowed = async (file: string): Promise<boolean> => (await gallery.studioPicturePath(file)) !== null

  it('serves live previews and project asset pictures, by their resolved path', async () => {
    const preview = put(join(dataRoot(), 'cache', 'previews', 'job-1.png'))
    expect(await gallery.studioPicturePath(preview)).toBe(preview)
    expect(await gallery.studioPicturePath(join(dataRoot(), 'cache', 'previews', '.', 'job-1.png'))).toBe(preview)
    expect(await allowed(put(join(dataRoot(), 'projects', 'project-1', 'assets', 'a.jpg')))).toBe(true)
    expect(await allowed(put(join(dataRoot(), 'projects', 'project-1', 'assets', 'nested', 'b.webp')))).toBe(true)
  })

  it('serves pictures only, not other files copied into assets', async () => {
    expect(await allowed(put(join(dataRoot(), 'projects', 'project-1', 'assets', 'notes.txt')))).toBe(false)
    expect(await allowed(put(join(dataRoot(), 'projects', 'project-1', 'assets', 'c1-model.safetensors')))).toBe(false)
    expect(await allowed(put(join(dataRoot(), 'cache', 'previews', 'job-1.json')))).toBe(false)
  })

  it('serves nothing else in the data root: project files, other cache folders, traversals, missing files', async () => {
    expect(await allowed(put(join(dataRoot(), 'projects', 'project-1', 'project.json')))).toBe(false)
    expect(await allowed(put(join(dataRoot(), 'cache', 'mossinfer', 'x.bin')))).toBe(false)
    expect(await allowed(put(join(dataRoot(), 'settings.json')))).toBe(false)
    expect(await allowed(join(dataRoot(), 'projects', 'project-1', 'assets', '..', 'project.json'))).toBe(false)
    expect(await allowed(join(dataRoot(), 'cache', 'previews', 'gone.png'))).toBe(false)
    expect(await allowed(put(join(dataRoot(), 'projects', '.hidden', 'assets', 'a.png')))).toBe(false)
    expect(await allowed(put(join(outside(), 'a.png')))).toBe(false)
  })

  it('does not follow a link out of an assets folder or the previews folder', async () => {
    put(join(outside(), 'secret', 'secret.png'))
    mkdirSync(join(dataRoot(), 'projects', 'project-1', 'assets'), { recursive: true })
    mkdirSync(join(dataRoot(), 'cache', 'previews'), { recursive: true })
    symlinkSync(join(outside(), 'secret'), join(dataRoot(), 'projects', 'project-1', 'assets', 'linked'), 'junction')
    symlinkSync(join(outside(), 'secret'), join(dataRoot(), 'cache', 'previews', 'linked'), 'junction')
    expect(await allowed(join(dataRoot(), 'projects', 'project-1', 'assets', 'linked', 'secret.png'))).toBe(false)
    expect(await allowed(join(dataRoot(), 'cache', 'previews', 'linked', 'secret.png'))).toBe(false)
  })
})

describe('image inputs in sidecars (so the Library shows them)', () => {
  const params: JobParams = {
    prompt: 'a cat',
    negativePrompt: '',
    width: 1024,
    height: 1024,
    steps: 20,
    cfg: 4,
    seed: 1,
    profile: 'base',
    initImage: { path: '/a/init.png', strength: 0.6, resize: 'fit' },
    mask: { path: '/a/mask.png' },
    control: {
      adapter: '/m/c.safetensors',
      loraStrength: 0.9,
      images: [{ kind: 'depth', path: '/a/d.png', strength: 1, start: 0, end: 0.8 }],
    },
    references: { paths: ['/a/r.png'], maxEdge: 768 },
    sampling: {
      sampler: 'heun',
      scheduler: 'karras',
      shift: 2,
      hires: { width: 1536, height: 1536, steps: 8, strength: 0.3 },
      stepCache: 'fbcache',
      cfgTruncation: 0.4,
    },
  }
  const job = {
    id: 'job-1',
    instanceId: 'engine',
    instanceName: 'MOSS',
    kind: 'inference',
    mode: 'runner',
    state: 'succeeded',
    stage: 'ready',
    params,
    progress: { stage: 'ready', current: 20, total: 20, percent: 100 },
    startedAt: 't',
  } as JobRecord

  it('writes them in the engine spelling and reads them back', () => {
    const record = jobInputsSidecar(params)
    expect(record).toEqual({
      init_image: '/a/init.png',
      denoise_strength: 0.6,
      resize: 'fit',
      mask: '/a/mask.png',
      control: {
        adapter: '/m/c.safetensors',
        lora_strength: 0.9,
        images: [{ kind: 'depth', path: '/a/d.png', strength: 1, start: 0, end: 0.8 }],
      },
      references: { images: ['/a/r.png'], max_edge: 768 },
      sampler: 'heun',
      scheduler: 'karras',
      shift: 2,
      hires: { width: 1536, height: 1536, steps: 8, strength: 0.3 },
      step_cache: 'fbcache',
      cfg_truncation: 0.4,
      base_width: 1024,
      base_height: 1024,
    })
    const back = generationFromSidecar(JSON.parse(JSON.stringify(record)) as Record<string, unknown>)
    expect(back).toEqual({
      baseWidth: 1024,
      baseHeight: 1024,
      initImage: params.initImage,
      mask: params.mask,
      control: params.control,
      references: params.references,
      sampling: params.sampling,
    })
  })

  it('adds them to the job sidecar record and the job generation', () => {
    expect(sidecarRecord(job, { width: 1536, height: 1536, seed: 1 })).toMatchObject({
      init_image: '/a/init.png',
      sampler: 'heun',
      width: 1536,
    })
    expect(generationFromJob(job)).toMatchObject({
      baseWidth: 1024,
      baseHeight: 1024,
      initImage: params.initImage,
      control: params.control,
      sampling: params.sampling,
    })
    expect(generationFromJob({ ...job, params: { ...params, sampling: { sampler: 'heun' } } })).not.toHaveProperty('baseWidth')
  })

  it('leaves them out when the job used none, and skips malformed sidecar values', () => {
    const plain = { ...params, initImage: undefined, mask: undefined, control: undefined, references: undefined, sampling: undefined }
    expect(jobInputsSidecar(plain)).toEqual({})
    expect(generationFromJob({ ...job, params: plain })).not.toHaveProperty('initImage')
    expect(
      generationFromSidecar({ init_image: '/x.png', control: { images: [] }, references: { images: [3] }, hires: { width: 'a' } }),
    ).toBeUndefined()
  })
})
