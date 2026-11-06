import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobRecord, Settings } from '@shared/types'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'

const dataRoot = useTempDataRoot()
const external = useTempDir('mossstudio-library-ext-')

type Gallery = typeof import('@main/services/gallery')
type SettingsModule = typeof import('@main/services/settings')
let gallery: Gallery
let settingsModule: SettingsModule
let electron: typeof import('electron')

beforeEach(async () => {
  vi.resetModules()
  gallery = await import('@main/services/gallery')
  settingsModule = await import('@main/services/settings')
  electron = await import('electron')
})

const outputs = (): string => join(dataRoot(), 'outputs')
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...settingsModule.DEFAULT_SETTINGS, ...patch })

function put(path: string, content: string, mtimeSeconds?: number): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (mtimeSeconds !== undefined) utimesSync(path, mtimeSeconds, mtimeSeconds)
  return path
}

function job(output: string, patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-a',
    instanceId: 'engine',
    instanceName: 'MOSS-Image SFT',
    kind: 'inference',
    mode: 'runner',
    state: 'succeeded',
    stage: 'ready',
    projectId: 'poster',
    params: { prompt: 'spring street', negativePrompt: '', width: 1024, height: 1024, steps: 20, cfg: 3, seed: 1, profile: 'base' },
    progress: { stage: 'ready', current: 20, total: 20, percent: 100 },
    startedAt: '2026-11-04T06:32:00.000Z',
    outputs: [{ path: output, width: 1024, height: 1024, seed: 42 }],
    ...patch,
  }
}

describe('listGallery filters', () => {
  it('searches prompt text from sidecars and filters by project and time', async () => {
    put(join(outputs(), 'a.png'), 'x', 1_000)
    put(join(outputs(), 'a.json'), JSON.stringify({ prompt: 'Red bicycle at dusk', project_id: 'poster' }))
    put(join(outputs(), 'b.png'), 'x', 5_000)
    put(join(outputs(), 'b.json'), JSON.stringify({ prompt: 'mountain lake', project_id: 'travel' }))
    put(join(outputs(), 'c.png'), 'x', 9_000)

    const s = settings()
    expect((await gallery.listGallery(s, { query: 'bicycle' })).items.map((i) => i.name)).toEqual(['a.png'])
    const poster = await gallery.listGallery(s, { projectId: 'poster' })
    expect(poster.items.map((i) => i.name)).toEqual(['a.png'])
    expect(poster.items[0]).toMatchObject({ prompt: 'Red bicycle at dusk', projectId: 'poster' })
    expect((await gallery.listGallery(s, { since: 5_000_000 })).items.map((i) => i.name)).toEqual(['c.png', 'b.png'])
  })
})

describe('recordJobOutputs', () => {
  it('adds generation details to the sidecar, keeping engine fields', async () => {
    const image = put(join(outputs(), 'job-a-1.png'), 'x')
    put(join(outputs(), 'job-a-1.json'), JSON.stringify({ prompt: 'spring street', seed: 42, tier: 'high' }))
    await gallery.recordJobOutputs(job(image))
    const sidecar = JSON.parse(readFileSync(join(outputs(), 'job-a-1.json'), 'utf8')) as Record<string, unknown>
    expect(sidecar).toMatchObject({
      tier: 'high',
      seed: 42,
      steps: 20,
      cfg: 3,
      project_id: 'poster',
      job_id: 'job-a',
      model_name: 'MOSS-Image SFT',
      where: '本机',
    })

    const detail = await gallery.galleryDetail(image)
    expect(detail.generation).toMatchObject({ projectId: 'poster', steps: 20, cfg: 3, seed: 42, where: '本机' })
    expect(detail.projectId).toBe('poster')
  })

  it('ignores training jobs and failed jobs', async () => {
    const image = put(join(outputs(), 'job-b-1.png'), 'x')
    expect(await gallery.recordJobOutputs(job(image, { kind: 'training' }))).toBe(false)
    expect(await gallery.recordJobOutputs(job(image, { state: 'failed' }))).toBe(false)
    expect(() => readFileSync(join(outputs(), 'job-b-1.json'), 'utf8')).toThrow()
  })

  it('never overwrites an existing file that is not a sidecar', async () => {
    const image = put(join(outputs(), 'job-d-1.png'), 'x')
    put(join(outputs(), 'job-d-1.json'), 'not json {')
    await gallery.recordJobOutputs(job(image))
    expect(readFileSync(join(outputs(), 'job-d-1.json'), 'utf8')).toBe('not json {')
    put(join(outputs(), 'job-d-1.json'), '[1,2]')
    await gallery.recordJobOutputs(job(image))
    expect(readFileSync(join(outputs(), 'job-d-1.json'), 'utf8')).toBe('[1,2]')
  })

  it('reads back what it recorded even when an image.png.json exists too', async () => {
    const image = put(join(outputs(), 'job-e-1.png'), 'x')
    put(`${image}.json`, JSON.stringify({ prompt: 'other tool', seed: 3 }))
    await gallery.recordJobOutputs(job(image, { id: 'job-e' }))
    const detail = await gallery.galleryDetail(image)
    expect(detail.generation).toMatchObject({ projectId: 'poster', steps: 20, jobId: 'job-e' })
    expect(detail.prompt).toBe('spring street')
  })

  it('shows the description of a region layout and the A1111 prompt without its settings', async () => {
    const layout = put(join(outputs(), 'job-f-1.png'), 'x')
    const compiled = JSON.stringify({ summary: { caption: '春日街景' }, items: [{ label: 'person' }] })
    await gallery.recordJobOutputs(job(layout, { id: 'job-f', params: { ...job(layout).params, prompt: compiled } }))
    const detail = await gallery.galleryDetail(layout)
    expect(detail.prompt).toBe('春日街景')
    expect(detail.generation).toMatchObject({ description: '春日街景', regions: 1 })

    const a1111 = put(join(outputs(), 'sd.png'), 'x')
    put(
      join(outputs(), 'sd.json'),
      JSON.stringify({ parameters: 'a red bike\nNegative prompt: blurry\nSteps: 30, CFG scale: 6, Seed: 9, Size: 512x512' }),
    )
    const sd = await gallery.galleryDetail(a1111)
    expect(sd.prompt).toBe('a red bike')
    expect(sd.negativePrompt).toBe('blurry')
    expect(sd.generation).toMatchObject({ steps: 30, cfg: 6, seed: 9, width: 512, height: 512 })
  })

  it('never writes next to an image outside the gallery roots', async () => {
    mkdirSync(outputs(), { recursive: true })
    const outside = put(join(external(), 'x.png'), 'x')
    await gallery.recordJobOutputs(job(outside))
    expect(() => readFileSync(join(external(), 'x.json'), 'utf8')).toThrow()
  })

  it('makes a just-finished image findable at once, despite the scan cache', async () => {
    put(join(outputs(), 'old.png'), 'x')
    expect((await gallery.listGallery(settings())).total).toBe(1)
    const image = put(join(outputs(), 'job-c-1.png'), 'x')
    await gallery.recordJobOutputs(job(image, { id: 'job-c' }))
    const poster = await gallery.listGallery(settings(), { projectId: 'poster' })
    expect(poster.items.map((item) => item.name)).toEqual(['job-c-1.png'])
  })
})

describe('trashGalleryItem', () => {
  it('moves the image and its sidecars to the trash', async () => {
    const image = put(join(outputs(), 'a.png'), 'x')
    put(join(outputs(), 'a.json'), JSON.stringify({ engine: 'mossinfer', seed: 1 }))
    const trash = vi.spyOn(electron.shell, 'trashItem')
    const result = await gallery.trashGalleryItem(image)
    expect(trash.mock.calls.map((call) => call[0])).toEqual([image, join(outputs(), 'a.json')])
    expect(result.trashed).toEqual([image, join(outputs(), 'a.json')])
  })

  it('leaves an unrelated same-name JSON in a user folder alone', async () => {
    const image = put(join(external(), 'b.png'), 'x')
    put(join(external(), 'b.json'), JSON.stringify({ nodes: [], links: [] }))
    settingsModule.updateSettings({ galleryRoots: [external()] })
    const trash = vi.spyOn(electron.shell, 'trashItem')
    await gallery.trashGalleryItem(image)
    expect(trash.mock.calls.map((call) => call[0])).toEqual([image])
  })

  it('refuses files outside the gallery roots and missing files', async () => {
    mkdirSync(outputs(), { recursive: true })
    const outside = put(join(external(), 'x.png'), 'x')
    const trash = vi.spyOn(electron.shell, 'trashItem')
    await expect(gallery.trashGalleryItem(outside)).rejects.toThrow('不在作品目录中')
    await expect(gallery.trashGalleryItem(join(outputs(), 'gone.png'))).rejects.toThrow('找不到这张图片')
    expect(trash).not.toHaveBeenCalled()
  })

  it('refuses a symlink inside a root that points outside it', async () => {
    if (process.platform === 'win32') return
    mkdirSync(outputs(), { recursive: true })
    const outside = put(join(external(), 'secret.png'), 'x')
    const link = join(outputs(), 'link.png')
    symlinkSync(outside, link)
    const trash = vi.spyOn(electron.shell, 'trashItem')
    await expect(gallery.trashGalleryItem(link)).rejects.toThrow('不在作品目录中')
    expect(trash).not.toHaveBeenCalled()
  })
})
