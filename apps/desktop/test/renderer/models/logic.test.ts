import { describe, expect, it } from 'vitest'
import type { DownloadTask, ModelBundle, ModelEntry } from '@shared/types'
import {
  bundleComponentIds,
  bundleDeletePlan,
  bundleView,
  bundlesUsing,
  isOfferedComponent,
  itemState,
  parseModelsQuery,
  recommendedBundle,
  sizeText,
  taskFor,
  taskText,
  visibleTasks,
} from '@renderer/pages/models/logic'
import { catalogFixture, downloadFixture } from '../../mocks/backend'

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
    expect(view.stateText).toBe(`未下载 · ${sizeText(view.totalBytes)}`)
    expect(view).toMatchObject({ action: 'download', actionLabel: '下载' })
  })

  it('counts the missing files and their size', () => {
    const c = catalog(['moss-sft-dit', 'qwen35-encoder', 'moss-pipeline'])
    const view = bundleView(bundle('moss-sft'), c.models, [])
    expect(view.status).toBe('partial')
    expect(view.stateText).toBe('还差 1 个文件 · 250 MB')
    expect(view.missing.map((item) => item.id)).toEqual(['flux2-vae-small'])
  })

  it('shows download progress over the missing parts and offers pause', () => {
    const c = catalog(['moss-sft-dit', 'qwen35-encoder', 'moss-pipeline'])
    const size = model('flux2-vae-small').sizeBytes
    const view = bundleView(bundle('moss-sft'), c.models, [task('flux2-vae-small', { state: 'running', bytes: Math.floor(size * 0.425) })])
    expect(view).toMatchObject({ status: 'downloading', stateText: '下载中 42%', action: 'pause', actionLabel: '暂停', percent: 42 })
    expect(view.tasks).toHaveLength(1)
  })

  it('offers 继续 when paused and 重试 when a part failed', () => {
    const c = catalog()
    const paused = bundleView(bundle('moss-sft'), c.models, [task('moss-sft-dit', { state: 'paused', bytes: 1_000_000_000 })])
    expect(paused).toMatchObject({ status: 'paused', action: 'resume', actionLabel: '继续' })
    expect(paused.stateText).toMatch(/^已暂停 \d+% · 还差 /)
    const failed = bundleView(bundle('moss-sft'), c.models, [task('moss-sft-dit', { state: 'error', error: 'net' }), task('qwen35-encoder', { state: 'paused' })])
    expect(failed).toMatchObject({ status: 'failed', action: 'resume', actionLabel: '重试' })
  })

  it('reports verifying without an action', () => {
    const c = catalog(['moss-sft-dit', 'qwen35-encoder', 'moss-pipeline'])
    expect(bundleView(bundle('moss-sft'), c.models, [task('flux2-vae-small', { state: 'verifying' })])).toMatchObject({ status: 'verifying', action: null })
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

describe('recommendedBundle', () => {
  it('prefers the requested bundle, then the recommended one, then the first', () => {
    const bundles = catalog().bundles
    expect(recommendedBundle(bundles)?.id).toBe('moss-sft')
    expect(recommendedBundle(bundles, 'moss-base')?.id).toBe('moss-base')
    expect(recommendedBundle(bundles, 'unknown')?.id).toBe('moss-sft')
    expect(recommendedBundle(bundles.map((item) => ({ ...item, recommended: false })))?.id).toBe(bundles[0]!.id)
    expect(recommendedBundle([])).toBeUndefined()
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
    expect(bundlesUsing('qwen35-encoder', c.bundles).map((item) => item.id)).toEqual(['moss-sft', 'moss-base', 'moss-sft-fp16', 'moss-base-fp16'])
    expect(bundlesUsing('moss-sft-dit', c.bundles, 'moss-sft')).toEqual([])
  })
})

describe('isOfferedComponent', () => {
  it('hides only the unusable single-file FP16-fixed exports', () => {
    const models = catalog().models
    expect(isOfferedComponent(model('moss-sft-fp16-fixed-comfy', models))).toBe(false)
    expect(isOfferedComponent(model('moss-sft-fp16-fixed', models))).toBe(true)
    expect(isOfferedComponent(model('moss-sft-comfy-int8_convrot', models))).toBe(true)
    expect(isOfferedComponent(model('qwen35-encoder', models))).toBe(true)
    expect(isOfferedComponent({ ...model('moss-sft-fp16-fixed-comfy', models), provider: 'local' })).toBe(true)
  })
})

describe('itemState', () => {
  const entry = { provider: 'hf' as const, sizeBytes: 74_000_000 }

  it('covers installed, downloading, paused, failed, partial and missing', () => {
    expect(itemState(entry, true, undefined)).toMatchObject({ text: '已下载', action: 'delete', tone: 'ok' })
    expect(itemState({ ...entry, provider: 'local' }, true, undefined)).toMatchObject({ text: '已添加', action: 'delete' })
    expect(itemState(entry, false, downloadFixture({ state: 'running', bytes: 50, totalBytes: 100 }))).toMatchObject({ text: '下载中 50%', action: 'pause', percent: 50 })
    expect(itemState(entry, false, downloadFixture({ state: 'queued' }))).toMatchObject({ text: '等待下载', action: 'pause' })
    expect(itemState(entry, false, downloadFixture({ state: 'verifying' }))).toMatchObject({ text: '正在校验', action: null })
    expect(itemState(entry, false, downloadFixture({ state: 'paused', bytes: 25, totalBytes: 100 }))).toMatchObject({ text: '已暂停 25%', action: 'resume', actionLabel: '继续' })
    expect(itemState(entry, false, downloadFixture({ state: 'error' }))).toMatchObject({ text: '下载失败', action: 'resume', actionLabel: '重试', tone: 'danger' })
    expect(itemState({ ...entry, installState: 'partial' }, false, undefined)).toMatchObject({ text: '文件不完整', action: 'download', actionLabel: '修复' })
    expect(itemState({ ...entry, provider: 'local' }, false, undefined)).toMatchObject({ text: '找不到原文件', action: 'delete', actionLabel: '移除' })
    expect(itemState(entry, false, undefined)).toMatchObject({ text: '74 MB', action: 'download', actionLabel: '下载' })
  })
})

describe('tasks', () => {
  it('finds the latest live task for an entry', () => {
    const tasks = [task('moss-sft-dit', { state: 'error' }), task('moss-sft-dit', { id: 'b', state: 'running' }), task('moss-sft-dit', { id: 'c', state: 'canceled' })]
    expect(taskFor(tasks, 'model', 'moss-sft-dit')?.id).toBe('b')
    expect(taskFor(tasks, 'adapter', 'moss-sft-dit')).toBeUndefined()
  })

  it('describes a task in one line', () => {
    expect(taskText(downloadFixture({ state: 'running', bytes: 2_000_000_000, totalBytes: 10_000_000_000, speedBps: 12_000_000 }))).toBe('下载中 20% · 2 GB / 10 GB · 12 MB/s')
    expect(taskText(downloadFixture({ state: 'running', bytes: 0, totalBytes: 0 }))).toBe('下载中')
    expect(taskText(downloadFixture({ state: 'queued' }))).toBe('等待下载')
    expect(taskText(downloadFixture({ state: 'paused', bytes: 5_000_000_000, totalBytes: 10_000_000_000 }))).toBe('已暂停 50% · 5 GB / 10 GB')
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
