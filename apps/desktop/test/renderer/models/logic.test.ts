import { describe, expect, it } from 'vitest'
import type { DownloadTask, ModelBundle, ModelEntry } from '@shared/types'
import {
  bundleBlocker,
  bundleComponentIds,
  bundleDeletePlan,
  bundleTone,
  bundleView,
  bundlesUsing,
  itemState,
  localFilesOnly,
  modelSections,
  parseModelsQuery,
  sizeText,
  taskFor,
  taskText,
  visibleTasks,
} from '@renderer/pages/models/logic'
import { GPU_GTX_1660, GPU_RTX_3060, catalogFixture, downloadFixture, gpuDeviceFixture } from '../../mocks/backend'

const SFT = ['moss-sft-dit', 'qwen35-encoder', 'flux2-vae-small', 'moss-pipeline']

function catalog(installed: string[] = [], partial: string[] = []) {
  return catalogFixture({ installed, partial })
}
const bundle = (id: string): ModelBundle => catalog().bundles.find((item) => item.id === id)!
const model = (id: string, models: ModelEntry[] = catalog().models): ModelEntry => models.find((item) => item.id === id)!
const task = (targetId: string, patch: Partial<DownloadTask> = {}): DownloadTask =>
  downloadFixture({ targetId, id: `model:${targetId}`, totalBytes: model(targetId).sizeBytes, ...patch })

describe('sizeText', () => {
  it('uses decimal units like the download sites', () => {
    expect(sizeText(249_522_210)).toBe('250 MB')
    expect(sizeText(10_164_704_750)).toBe('10.2 GB')
    expect(sizeText(16_785_543_633)).toBe('16.8 GB')
    expect(sizeText(2_000_000_000)).toBe('2 GB')
    expect(sizeText(150_000_000_000)).toBe('150 GB')
    expect(sizeText(50_000)).toBe('50 KB')
    expect(sizeText(512)).toBe('512 B')
    expect(sizeText(0)).toBe('—')
    expect(sizeText(undefined)).toBe('—')
  })
})

describe('bundleComponentIds', () => {
  it('lists the parts in order without blanks or duplicates', () => {
    expect(bundleComponentIds(bundle('moss-sft'))).toEqual(SFT)
    expect(bundleComponentIds({ ...bundle('moss-sft'), support: '' })).toEqual(SFT.slice(0, 3))
  })
})

describe('bundleView', () => {
  it('says 可以使用 when every part is there', () => {
    const c = catalog(SFT)
    const view = bundleView(bundle('moss-sft'), c.models, [])
    expect(view).toMatchObject({ status: 'ready', stateText: '可以使用', action: null, missing: [] })
  })

  it('names nothing technical when nothing is downloaded', () => {
    const c = catalog()
    const view = bundleView(bundle('moss-sft'), c.models, [])
    expect(view.status).toBe('missing')
    // The size is shown once, next to the description, never inside the state.
    expect(view.stateText).toBe('未下载')
    expect(bundleTone(view.status)).toBe('neutral')
    expect(view).toMatchObject({ action: 'download', actionLabel: '下载' })
  })

  it('counts the missing files and their size', () => {
    const c = catalog(['moss-sft-dit', 'qwen35-encoder', 'moss-pipeline'])
    const view = bundleView(bundle('moss-sft'), c.models, [])
    expect(view.status).toBe('partial')
    expect(view.stateText).toBe('还差 1 个文件 · 250 MB')
    expect(bundleTone(view.status)).toBe('warn')
    expect(view.missing.map((item) => item.id)).toEqual(['flux2-vae-small'])
  })

  it('shows download progress over the missing parts and offers pause', () => {
    const c = catalog(['moss-sft-dit', 'qwen35-encoder', 'moss-pipeline'])
    const size = model('flux2-vae-small').sizeBytes
    const view = bundleView(bundle('moss-sft'), c.models, [task('flux2-vae-small', { state: 'running', bytes: Math.floor(size * 0.425) })])
    expect(view).toMatchObject({ status: 'downloading', stateText: '下载中 42%', action: 'pause', actionLabel: '暂停', percent: 42 })
    // In progress is accent, the same as generation and training.
    expect(bundleTone(view.status)).toBe('accent')
    expect(view.tasks).toHaveLength(1)
  })

  it('is not downloading while only the parts it shares with another model download', () => {
    const shared = ['qwen35-comfy-int8_convrot', 'flux2-vae-comfy-small', 'moss-runtime-config'].map((id) => task(id, { state: 'running' }))
    const int8 = bundleView(bundle('moss-sft-int8'), catalog().models, shared)
    expect(int8).toMatchObject({ status: 'missing', action: 'download', actionLabel: '下载' })
    const nvfp4 = bundleView(bundle('moss-sft-nvfp4'), catalog().models, [...shared, task('moss-sft-comfy-nvfp4', { state: 'running' })])
    expect(nvfp4).toMatchObject({ status: 'downloading', action: 'pause' })
  })

  it('offers 继续 when paused and 重试 when a part failed', () => {
    const c = catalog()
    const paused = bundleView(bundle('moss-sft'), c.models, [task('moss-sft-dit', { state: 'paused', bytes: 1_000_000_000 })])
    expect(paused).toMatchObject({ status: 'paused', action: 'resume', actionLabel: '继续' })
    expect(paused.stateText).toMatch(/^已暂停 \d+% · 还差 /)
    const failed = bundleView(bundle('moss-sft'), c.models, [
      task('moss-sft-dit', { state: 'error', error: 'net' }),
      task('qwen35-encoder', { state: 'paused' }),
    ])
    expect(failed).toMatchObject({ status: 'failed', action: 'resume', actionLabel: '重试' })
  })

  it('reports verifying without an action', () => {
    const c = catalog(['moss-sft-dit', 'qwen35-encoder', 'moss-pipeline'])
    expect(bundleView(bundle('moss-sft'), c.models, [task('flux2-vae-small', { state: 'verifying' })])).toMatchObject({
      status: 'verifying',
      action: null,
    })
  })

  it('ignores tasks of parts that are already installed and canceled tasks', () => {
    const c = catalog(SFT)
    expect(bundleView(bundle('moss-sft'), c.models, [task('moss-sft-dit', { state: 'running' })]).status).toBe('ready')
    expect(bundleView(bundle('moss-sft'), catalog().models, [task('moss-sft-dit', { state: 'canceled' })]).status).toBe('missing')
  })

  it('uses the given installed check (a remote inventory)', () => {
    const c = catalog(SFT)
    const remote = new Set(['moss-sft-dit'])
    const view = bundleView(bundle('moss-sft'), c.models, [], (entry) => remote.has(entry.id))
    expect(view.status).toBe('partial')
    expect(view.missing).toHaveLength(3)
  })

  it('marks a bundle whose parts are not in the catalog as unavailable', () => {
    const view = bundleView({ ...bundle('moss-sft'), components: { ...bundle('moss-sft').components, vae: 'gone' } }, catalog().models, [])
    expect(view).toMatchObject({ status: 'unavailable', action: null })
  })
})

describe('bundleView on a place that cannot run it', () => {
  it('keeps the state, offers no download, and says why', () => {
    const view = bundleView(bundle('moss-sft-nvfp4'), catalog().models, [], undefined, '只能在 RTX 50 系列显卡上运行')
    expect(view).toMatchObject({ status: 'missing', action: null, actionLabel: '', blocked: '只能在 RTX 50 系列显卡上运行' })
  })

  it('still lets a paused or failed download be continued or retried', () => {
    const paused = bundleView(
      bundle('moss-sft-nvfp4'),
      catalog().models,
      [task('moss-sft-comfy-nvfp4', { state: 'paused' })],
      undefined,
      'x',
    )
    expect(paused).toMatchObject({ status: 'paused', action: 'resume', actionLabel: '继续', blocked: 'x' })
    const failed = bundleView(
      bundle('moss-sft-nvfp4'),
      catalog().models,
      [task('moss-sft-comfy-nvfp4', { state: 'error' })],
      undefined,
      'x',
    )
    expect(failed).toMatchObject({ status: 'failed', action: 'resume', actionLabel: '重试', blocked: 'x' })
  })

  it('still lets a running download be paused', () => {
    const view = bundleView(
      bundle('moss-sft-nvfp4'),
      catalog().models,
      [task('moss-sft-comfy-nvfp4', { state: 'running' })],
      undefined,
      'x',
    )
    expect(view).toMatchObject({ status: 'downloading', action: 'pause', blocked: 'x' })
  })
})

describe('bundleBlocker', () => {
  const rtx5090 = gpuDeviceFixture({
    name: 'NVIDIA GeForce RTX 5090',
    computeCapability: { major: 12, minor: 0 },
    memoryTotalBytes: 32 * 1024 ** 3,
  })
  const models = catalog().models

  it('keeps NVFP4 to RTX 50 cards', () => {
    expect(bundleBlocker(bundle('moss-sft-nvfp4'), models, { remote: false, gpus: [gpuDeviceFixture()] })).toBe(
      '只能在 RTX 50 系列显卡上运行',
    )
    expect(bundleBlocker(bundle('moss-sft-nvfp4'), models, { remote: false, gpus: [rtx5090] })).toBeNull()
    // Any one GPU that can run it is enough.
    expect(bundleBlocker(bundle('moss-sft-nvfp4'), models, { remote: false, gpus: [gpuDeviceFixture(), rtx5090] })).toBeNull()
  })

  it('rules nothing out before the GPUs are known', () => {
    expect(bundleBlocker(bundle('moss-sft-nvfp4'), models, { remote: false, gpus: [] })).toBeNull()
  })

  it('offers INT8 and INT4 on Turing (the SM75 engine build runs them)', () => {
    expect(bundleBlocker(bundle('moss-sft-int8'), models, { remote: false, gpus: [GPU_GTX_1660()] })).toBeNull()
    expect(bundleBlocker(bundle('moss-sft-int4'), models, { remote: false, gpus: [GPU_GTX_1660()] })).toBeNull()
    expect(bundleBlocker(bundle('moss-sft-nvfp4'), models, { remote: false, gpus: [GPU_GTX_1660()] })).not.toBeNull()
  })

  it('keeps single-file models off a GPU on 兼容模式', () => {
    const gpu = gpuDeviceFixture()
    const place = { remote: false, gpus: [gpu], cliGpus: new Set([gpu.uuid]) }
    expect(bundleBlocker(bundle('moss-sft-int8'), models, place)).toBe(`${gpu.name} 上的引擎只能运行官方模型`)
    expect(bundleBlocker(bundle('moss-sft'), models, place)).toBeNull()
  })

  it('keeps single-file models on this computer', () => {
    expect(bundleBlocker(bundle('moss-sft-int8'), models, { remote: true, gpus: [] })).toMatch(/^只能在这台电脑上使用/)
    expect(bundleBlocker(bundle('moss-sft'), models, { remote: true, gpus: [] })).toBeNull()
  })
})

describe('modelSections', () => {
  const rtx5090 = gpuDeviceFixture({
    name: 'NVIDIA GeForce RTX 5090',
    computeCapability: { major: 12, minor: 0 },
    memoryTotalBytes: 32 * 1024 ** 3,
  })
  const sections = (gpus: ReturnType<typeof gpuDeviceFixture>[], preferred?: string, remote = false) => {
    const c = catalog()
    const place = { remote, gpus }
    const views = c.bundles.map((item) => bundleView(item, c.models, [], undefined, bundleBlocker(item, c.models, place)))
    return modelSections(views, c.models, place, preferred)
  }
  const ids = (views: { bundle: ModelBundle }[]) => views.map((view) => view.bundle.id)

  it('lists every certified model under 推荐模型 and the unverified ones under 其他模型', () => {
    const result = sections([])
    expect(result.featured?.bundle.id).toBe('moss-sft')
    expect(result.pick).toEqual({ reason: null })
    expect(ids(result.certified)).toEqual([
      'moss-base',
      'moss-sft-int8',
      'moss-sft-nvfp4',
      'moss-sft-int4',
      'moss-sft-turbo-int8',
      'moss-base-int8',
    ])
    expect(ids(result.others)).toEqual(['moss-sft-fp16', 'moss-base-fp16'])
  })

  it('features the official SFT on an RTX 50 card with VRAM to spare, and still lists NVFP4', () => {
    const result = sections([rtx5090])
    expect(result.featured?.bundle.id).toBe('moss-sft')
    expect(result.pick?.reason).toContain('RTX 5090')
    expect(ids(result.certified)).toContain('moss-sft-nvfp4')
  })

  it('features INT8 when VRAM is limited and the official model when it is not', () => {
    expect(sections([GPU_RTX_3060()]).featured?.bundle.id).toBe('moss-sft-int8')
    expect(sections([gpuDeviceFixture()]).featured?.bundle.id).toBe('moss-sft')
    // Turing runs INT8 too: a 6 GB card gets it.
    expect(sections([GPU_GTX_1660()]).featured?.bundle.id).toBe('moss-sft-int8')
  })

  it('features the deep-linked model, which is then not called the best pick', () => {
    const result = sections([GPU_RTX_3060()], 'moss-base')
    expect(result.featured?.bundle.id).toBe('moss-base')
    expect(result.pick).toBeNull()
    expect(ids(result.certified)).toContain('moss-sft-int8')
  })

  it('never picks a single-file model for another computer', () => {
    expect(sections([], undefined, true).featured?.bundle.id).toBe('moss-sft')
  })
})

describe('bundleDeletePlan', () => {
  it('keeps shared parts while another complete model uses them', () => {
    const c = catalog([...SFT, 'moss-base-dit'])
    const plan = bundleDeletePlan(bundle('moss-sft'), c.bundles, c.models)
    expect(plan.ids).toEqual(['moss-sft-dit'])
    expect(plan.kept).toEqual(['qwen35-encoder', 'flux2-vae-small', 'moss-pipeline'])
    expect(plan.bytes).toBe(model('moss-sft-dit', c.models).installedBytes)
  })

  it('removes everything when no other model is complete', () => {
    const c = catalog(SFT)
    expect(bundleDeletePlan(bundle('moss-sft'), c.bundles, c.models).ids).toEqual(SFT)
  })

  it('keeps shared parts for a model that is still downloading or partly there', () => {
    const c = catalog(SFT)
    const downloading = bundleDeletePlan(bundle('moss-sft'), c.bundles, c.models, undefined, [task('moss-base-dit', { state: 'running' })])
    expect(downloading.ids).toEqual(['moss-sft-dit'])
    const paused = bundleDeletePlan(bundle('moss-sft'), c.bundles, c.models, undefined, [task('moss-base-dit', { state: 'paused' })])
    expect(paused.ids).toEqual(['moss-sft-dit'])
    const finishedTask = bundleDeletePlan(bundle('moss-sft'), c.bundles, c.models, undefined, [task('moss-base-dit', { state: 'done' })])
    expect(finishedTask.ids).toEqual(SFT)
  })

  it('only counts installed parts', () => {
    const c = catalog(['qwen35-encoder'])
    expect(bundleDeletePlan(bundle('moss-sft'), c.bundles, c.models).ids).toEqual(['qwen35-encoder'])
  })

  it('names the models that use a part', () => {
    const c = catalog()
    expect(bundlesUsing('qwen35-encoder', c.bundles).map((item) => item.id)).toEqual([
      'moss-sft',
      'moss-base',
      'moss-sft-fp16',
      'moss-base-fp16',
    ])
    expect(bundlesUsing('moss-sft-dit', c.bundles, 'moss-sft')).toEqual([])
  })

  it('removes scanned local files from the list but keeps the runtime config they load with', () => {
    const local = (id: string, role: ModelEntry['role']): ModelEntry => ({
      ...model('moss-sft-comfy-int8_convrot'),
      id,
      role,
      provider: 'local',
      installed: true,
      installedBytes: 1,
    })
    const models = [...catalog(['moss-runtime-config']).models, local('l-dit', 'dit'), local('l-te', 'text_encoder'), local('l-vae', 'vae')]
    const files: ModelBundle = {
      id: 'local-files',
      name: '本地文件（扫描）',
      description: '',
      components: { dit: 'l-dit', textEncoder: 'l-te', vae: 'l-vae' },
      support: 'moss-runtime-config',
    }
    expect(localFilesOnly(files, models)).toBe(true)
    expect(localFilesOnly(bundle('moss-sft-int8'), models)).toBe(false)
    expect(bundleDeletePlan(files, [files], models).ids).toEqual(['l-dit', 'l-te', 'l-vae'])
  })
})

describe('itemState', () => {
  const entry = { provider: 'hf' as const, sizeBytes: 74_000_000 }

  it('covers installed, downloading, paused, failed, partial and missing', () => {
    expect(itemState(entry, true, undefined)).toMatchObject({ text: '已下载', action: 'delete', tone: 'ok' })
    expect(itemState({ ...entry, provider: 'local' }, true, undefined)).toMatchObject({
      text: '已添加',
      action: 'delete',
      actionLabel: '移除',
    })
    expect(itemState(entry, false, downloadFixture({ state: 'running', bytes: 50, totalBytes: 100 }))).toMatchObject({
      text: '下载中 50%',
      tone: 'accent',
      action: 'pause',
      percent: 50,
    })
    expect(itemState(entry, false, downloadFixture({ state: 'queued' }))).toMatchObject({ text: '等待下载', action: 'pause' })
    expect(itemState(entry, false, downloadFixture({ state: 'verifying' }))).toMatchObject({ text: '正在校验', action: null })
    expect(itemState(entry, false, downloadFixture({ state: 'paused', bytes: 25, totalBytes: 100 }))).toMatchObject({
      text: '已暂停 25%',
      action: 'resume',
      actionLabel: '继续',
    })
    expect(itemState(entry, false, downloadFixture({ state: 'error' }))).toMatchObject({
      text: '下载失败',
      action: 'resume',
      actionLabel: '重试',
      tone: 'danger',
    })
    expect(itemState({ ...entry, installState: 'partial' }, false, undefined)).toMatchObject({
      text: '文件不完整',
      action: 'download',
      actionLabel: '修复',
    })
    expect(itemState({ ...entry, provider: 'local' }, false, undefined)).toMatchObject({
      text: '找不到原文件',
      action: 'delete',
      actionLabel: '移除',
    })
    expect(itemState(entry, false, undefined)).toMatchObject({ text: '', action: 'download', actionLabel: '下载' })
  })
})

describe('tasks', () => {
  it('finds the latest live task for an entry', () => {
    const tasks = [
      task('moss-sft-dit', { state: 'error' }),
      task('moss-sft-dit', { id: 'b', state: 'running' }),
      task('moss-sft-dit', { id: 'c', state: 'canceled' }),
    ]
    expect(taskFor(tasks, 'model', 'moss-sft-dit')?.id).toBe('b')
    expect(taskFor(tasks, 'adapter', 'moss-sft-dit')).toBeUndefined()
  })

  it('describes a task in one line', () => {
    expect(taskText(downloadFixture({ state: 'running', bytes: 2_000_000_000, totalBytes: 10_000_000_000, speedBps: 12_000_000 }))).toBe(
      '下载中 20% · 2 GB / 10 GB · 12 MB/s',
    )
    expect(taskText(downloadFixture({ state: 'running', bytes: 0, totalBytes: 0 }))).toBe('下载中')
    expect(taskText(downloadFixture({ state: 'queued' }))).toBe('等待下载')
    expect(taskText(downloadFixture({ state: 'paused', bytes: 5_000_000_000, totalBytes: 10_000_000_000 }))).toBe(
      '已暂停 50% · 5 GB / 10 GB',
    )
    expect(taskText(downloadFixture({ state: 'error', error: '磁盘已满' }))).toBe('下载失败：磁盘已满')
    expect(taskText(downloadFixture({ state: 'verifying' }))).toBe('正在校验文件')
    expect(taskText(downloadFixture({ state: 'running', connectionError: 'ssh' }))).toBe('连接中断，显示的是上次的进度')
  })

  it('lists only unfinished tasks', () => {
    const tasks = (['queued', 'running', 'done', 'canceled', 'error'] as const).map((state) => downloadFixture({ id: state, state }))
    expect(visibleTasks(tasks).map((item) => item.id)).toEqual(['queued', 'running', 'error'])
  })
})

describe('parseModelsQuery', () => {
  it('reads first-run deep links', () => {
    expect(parseModelsQuery('?bundle=moss-sft&component=all')).toEqual({ bundleId: 'moss-sft', component: 'all', hostId: null, tab: null })
    expect(parseModelsQuery('?component=dit&hostId=h1')).toEqual({ bundleId: null, component: 'dit', hostId: 'h1', tab: null })
    expect(parseModelsQuery('?component=adapter').tab).toBe('lora')
    expect(parseModelsQuery('?tab=downloads').tab).toBe('downloads')
    expect(parseModelsQuery('?tab=nope').tab).toBeNull()
    expect(parseModelsQuery('')).toEqual({ bundleId: null, component: null, hostId: null, tab: null })
  })
})
