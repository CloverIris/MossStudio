import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import type { DownloadTask, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@main/services/settings'
import { useTempDataRoot } from '@test/helpers/tempDir'
import {
  cacheDirFor,
  installOnDisk,
  rawModel,
  sha256,
  startFakeHf,
  testSettings,
  vaeFiles,
  writeCatalog,
  type FakeHf,
} from './modelFixtures'

const contentDir = vi.hoisted(() => vi.fn<() => string | null>())
const listJobs = vi.hoisted(() => vi.fn<() => Promise<Array<{ state: string }>>>())
const fetchHf = vi.hoisted(() => vi.fn<(url: string) => Promise<Response>>())
vi.mock('@main/lib/content', () => ({ contentDir }))
vi.mock('@main/services/supervisor', () => ({ listJobs }))
vi.mock('@main/services/network', () => ({ getLastNetwork: () => null }))
vi.mock('@main/services/hfNetwork', () => ({ fetchHf }))

const dataRoot = useTempDataRoot()
type Models = typeof import('@main/services/models')
let models: Models
let settings: Settings
let hf: FakeHf
let events: DownloadTask[]
const modelsRoot = (): string => join(dataRoot(), 'models')
const releaseDir = (): string => join(dataRoot(), 'release')

const VAE_SHA = '1'.repeat(40)
const LORA_SHA = '2'.repeat(40)
const SUPPORT_SHA = '3'.repeat(40)
const bigWeights = Buffer.alloc(256 * 1024, 7)
const vae = rawModel({ id: 'vae-a', repo: 'org/vae', role: 'vae', subfolder: 'vae', files: ['vae/*'], size_bytes: 100 })
const vaeBig = rawModel({ id: 'vae-big', repo: 'org/big', role: 'vae', subfolder: 'vae', files: ['vae/*'] })
const support = rawModel({
  id: 'support-a',
  repo: 'org/support',
  role: 'support',
  files: ['model_index.json', 'pipeline_moss_image.py', 'scheduler/*'],
})
const broken = rawModel({ id: 'vae-broken', repo: 'org/broken', role: 'vae', subfolder: 'vae', files: ['vae/*'] })
const lora = {
  id: 'lora-a',
  name: 'Lora A',
  provider: 'hf',
  repo: 'org/lora',
  kind: 'lora',
  license: 'mit',
  files: ['a.safetensors'],
  size_bytes: 3,
}
const bundle = {
  id: 'b1',
  name: 'B1',
  description: '',
  support: 'support-a',
  components: { dit: 'vae-a', textEncoder: 'vae-a', vae: 'vae-a' },
}

beforeEach(async () => {
  vi.resetModules()
  hf = await startFakeHf({
    'org/vae': { sha: VAE_SHA, files: { ...vaeFiles(), 'README.md': 'not selected' } },
    'org/big': { sha: VAE_SHA, files: { 'vae/config.json': '{}', 'vae/model.safetensors': bigWeights } },
    'org/broken': { sha: VAE_SHA, files: { 'vae/model.safetensors': 'weights without config' } },
    'org/support': {
      sha: SUPPORT_SHA,
      files: { 'model_index.json': '{}', 'pipeline_moss_image.py': 'x', 'scheduler/scheduler_config.json': '{}' },
    },
    'org/lora': { sha: LORA_SHA, files: { 'a.safetensors': 'abc' } },
  })
  contentDir.mockReset().mockImplementation(() => releaseDir())
  listJobs.mockReset().mockResolvedValue([])
  fetchHf.mockReset().mockImplementation((url) => fetch(url))
  writeCatalog(releaseDir(), { schema_version: 2, models: [vae, vaeBig, support, broken], bundles: [bundle], adapters: [lora] })
  models = await import('@main/services/models')
  const { onEmit } = await import('@main/lib/events')
  events = []
  onEmit((channel, payload) => {
    if (channel === Events.download) events.push(payload as DownloadTask)
  })
  settings = testSettings(DEFAULT_SETTINGS, { modelsRoot: modelsRoot(), hfEndpoint: `${hf.base}/` })
})
afterEach(async () => {
  hf.intercept = null
  await hf.close()
})

/** Wait until the task reaches one of the given states. */
async function settle(id: string, states: DownloadTask['state'][] = ['done', 'error', 'paused']): Promise<DownloadTask> {
  await vi.waitFor(
    () => {
      const task = models.listDownloads().find((item) => item.id === id)
      if (!task || !states.includes(task.state)) throw new Error(`task ${id} is ${task?.state}`)
    },
    { timeout: 5000, interval: 5 },
  )
  return models.listDownloads().find((item) => item.id === id)!
}

describe('model downloads', () => {
  it('downloads the selected files, writes the install record and reports ready', async () => {
    const task = await models.startDownload('model', 'vae-a', settings)
    expect(task).toMatchObject({ id: 'model:vae-a', kind: 'model', targetId: 'vae-a', state: 'queued', totalBytes: 100 })
    const done = await settle(task.id)
    const total = Object.values(vaeFiles()).reduce((n, body) => n + Buffer.byteLength(body), 0)
    expect(done).toMatchObject({
      state: 'done',
      filesTotal: 2,
      filesDone: 2,
      bytes: total,
      totalBytes: total,
      speedBps: 0,
      currentFile: undefined,
    })

    // Only the selected files were fetched; README.md was not.
    expect(hf.requests.filter((r) => r.includes('/resolve/'))).toHaveLength(2)
    const dir = cacheDirFor(modelsRoot(), 'vae', 'org/vae')
    const record = JSON.parse(readFileSync(join(dir, '.clover-vae-a.json'), 'utf8'))
    expect(record).toMatchObject({ version: 2, id: 'vae-a', repo: 'org/vae', revision: 'main', sha: VAE_SHA })
    expect(record.entries.map((e: { path: string }) => e.path).sort()).toEqual(Object.keys(vaeFiles()).sort())
    expect(readFileSync(join(dir, 'refs', 'main'), 'utf8')).toBe(VAE_SHA)
    expect(existsSync(join(dir, '.clover-vae-a.json.pending'))).toBe(false)
    expect(readFileSync(join(dir, 'snapshots', VAE_SHA, 'vae', 'config.json'), 'utf8')).toBe(vaeFiles()['vae/config.json'])

    const entry = (await models.getCatalog(settings)).models.find((m) => m.id === 'vae-a')!
    expect(entry).toMatchObject({ installed: true, installState: 'ready', resolvedRevision: VAE_SHA })
    const component = await models.componentSnapshot('vae-a', settings)
    expect(component.root).toBe(join(dir, 'snapshots', VAE_SHA))

    // The live event stream starts queued and ends done.
    const states = events.filter((e) => e.id === task.id).map((e) => e.state)
    expect(states[0]).toBe('queued')
    expect(states.at(-1)).toBe('done')
    expect(states).toContain('running')
  })

  it('returns the existing task while a download is active', async () => {
    const first = await models.startDownload('model', 'vae-a', settings)
    const second = await models.startDownload('model', 'vae-a', settings)
    expect(second).toBe(first)
    await settle(first.id)
    expect(models.listDownloads()).toHaveLength(1)
  })

  it('reports an incomplete component as an error and the catalog as error', async () => {
    const task = await models.startDownload('model', 'vae-broken', settings)
    const failed = await settle(task.id)
    expect(failed).toMatchObject({ state: 'error', error: '组件配置或权重分片不完整', speedBps: 0 })
    const entry = (await models.getCatalog(settings)).models.find((m) => m.id === 'vae-broken')!
    expect(entry.installState).toBe('error')
    // Downloaded bytes are kept as a pending install, not marked installed.
    expect(existsSync(join(cacheDirFor(modelsRoot(), 'vae', 'org/broken'), '.clover-vae-broken.json.pending'))).toBe(true)
  })

  it('reports a manifest that lacks the selected files', async () => {
    writeCatalog(releaseDir(), { schema_version: 2, models: [rawModel({ id: 'x', repo: 'org/vae', role: 'vae', files: ['missing/*'] })] })
    const task = await models.startDownload('model', 'x', settings)
    expect((await settle(task.id)).error).toBe('仓库缺少文件：missing/*')
  })

  it('reports resolver failures', async () => {
    fetchHf.mockRejectedValue(new Error('offline fixture'))
    const task = await models.startDownload('model', 'vae-a', settings)
    expect(await settle(task.id)).toMatchObject({ state: 'error', error: 'offline fixture' })
  })

  it('pauses mid-file and resumes from the partial bytes', async () => {
    let release: (() => void) | null = null
    hf.intercept = (req, res, path) => {
      if (!path.endsWith('vae/model.safetensors') || req.headers.range) return false
      res.writeHead(200, { 'content-length': String(bigWeights.length) })
      res.write(bigWeights.subarray(0, 1024))
      release = () => res.destroy()
      return true
    }
    const task = await models.startDownload('model', 'vae-big', settings)
    await vi.waitFor(
      () => {
        const blob = join(cacheDirFor(modelsRoot(), 'vae', 'org/big'), 'blobs', sha256(bigWeights))
        if (!existsSync(`${blob}.part`) || readFileSync(`${blob}.part`).length < 1024) throw new Error('waiting for bytes')
      },
      { timeout: 5000, interval: 5 },
    )
    models.pauseDownload(task.id)
    expect(models.listDownloads()[0]!.state).toBe('paused')
    const paused = await settle(task.id, ['paused'])
    expect(paused.speedBps).toBe(0)
    // Pausing a paused task is a no-op.
    models.pauseDownload(task.id)
    ;(release as (() => void) | null)?.()

    const resumed = await models.startDownload('model', 'vae-big', settings)
    expect(resumed).not.toBe(task)
    expect((await settle(task.id, ['done', 'error'])).state).toBe('done')
    expect(hf.requests.some((r) => r.endsWith('vae/model.safetensors bytes=1024-'))).toBe(true)
  })

  it('cancel removes the task, emits canceled and allows a fresh start', async () => {
    hf.intercept = (_req, res, path) => {
      if (!path.includes('/revision/')) return false
      setTimeout(() => res.end(JSON.stringify({ sha: VAE_SHA })), 30)
      return true
    }
    const task = await models.startDownload('model', 'vae-a', settings)
    await models.cancelDownload(task.id)
    expect(models.listDownloads()).toEqual([])
    expect(events.at(-1)).toMatchObject({ id: task.id, state: 'canceled', speedBps: 0 })
    await models.cancelDownload('model:unknown')
    hf.intercept = null
    const again = await models.startDownload('model', 'vae-a', settings)
    expect((await settle(again.id)).state).toBe('done')
  })

  it('reuses a matching blob from an imported local file instead of downloading it', async () => {
    const weights = vaeFiles()['vae/diffusion_pytorch_model.safetensors']
    const local = join(dataRoot(), 'mine', 'w.safetensors')
    mkdirSync(join(local, '..'), { recursive: true })
    writeFileSync(local, weights)
    await models.importModelFolder(join(dataRoot(), 'mine'), settings)
    const task = await models.startDownload('model', 'vae-a', settings)
    expect((await settle(task.id)).state).toBe('done')
    const fetched = hf.requests.filter((r) => r.includes('/resolve/'))
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toContain('vae/config.json')
    // The source file is copied, never moved.
    expect(readFileSync(local, 'utf8')).toBe(weights)
  })

  it('reuses a blob already present in another repo cache', async () => {
    const weights = vaeFiles()['vae/diffusion_pytorch_model.safetensors']
    const otherDir = cacheDirFor(modelsRoot(), 'dit', 'org/other')
    mkdirSync(join(otherDir, 'blobs'), { recursive: true })
    writeFileSync(join(otherDir, 'blobs', sha256(weights)), weights)
    const task = await models.startDownload('model', 'vae-a', settings)
    expect((await settle(task.id)).state).toBe('done')
    expect(hf.requests.filter((r) => r.includes('/resolve/'))).toHaveLength(1)
  })

  it('refuses to start while a component is being deleted and to delete while installing', async () => {
    installOnDisk(modelsRoot(), { id: 'support-a', repo: 'org/support', role: 'support' }, SUPPORT_SHA, {
      'model_index.json': '{}',
      'pipeline_moss_image.py': 'x',
      'scheduler/scheduler_config.json': '{}',
    })
    let unblock: () => void = () => undefined
    listJobs.mockReturnValue(
      new Promise((resolve) => {
        unblock = () => resolve([])
      }),
    )
    const deleting = models.deleteModel('model', 'support-a', settings)
    await vi.waitFor(() => expect(listJobs).toHaveBeenCalled())
    await expect(models.startDownload('model', 'vae-a', settings)).rejects.toThrow('组件正在删除')
    unblock()
    await deleting

    hf.intercept = (_req, res, path) => {
      if (!path.includes('/revision/')) return false
      setTimeout(() => res.end(JSON.stringify({ sha: VAE_SHA })), 50)
      return true
    }
    const task = await models.startDownload('model', 'vae-a', settings)
    await expect(models.deleteModel('model', 'support-a', settings)).rejects.toThrow('有组件正在下载或校验')
    await settle(task.id)
  })

  it('installBundle queues only the missing components, once each', async () => {
    installOnDisk(modelsRoot(), { id: 'support-a', repo: 'org/support', role: 'support' }, SUPPORT_SHA, {
      'model_index.json': '{}',
      'pipeline_moss_image.py': 'x',
      'scheduler/scheduler_config.json': '{}',
    })
    const tasks = await models.installBundle('b1', settings)
    expect(tasks.map((t) => t.id)).toEqual(['model:vae-a', 'model:vae-a', 'model:vae-a'])
    expect(new Set(tasks).size).toBe(1)
    await settle('model:vae-a')
    expect(await models.installBundle('b1', settings)).toEqual([])
    await expect(models.installBundle('nope', settings)).rejects.toThrow('模型组合不存在')
  })

  it('installBundle reports a component missing from the catalog', async () => {
    writeCatalog(releaseDir(), { schema_version: 2, models: [vae], bundles: [{ ...bundle, support: 'gone' }] })
    await expect(models.installBundle('b1', settings)).rejects.toThrow('组合缺少组件：gone')
  })

  it('downloads a custom repo as a full model with a sanitised id', async () => {
    fetchHf.mockRejectedValue(new Error('offline fixture'))
    const task = await models.downloadCustomModel('Org/Some Repo', settings)
    expect(task).toMatchObject({ id: 'model:org-some-repo', label: 'Org/Some Repo', totalBytes: 0 })
  })
})

describe('adapter downloads', () => {
  it('downloads adapter files and writes adapter.json', async () => {
    const task = await models.startDownload('adapter', 'lora-a', settings)
    expect(task.id).toBe('adapter:lora-a')
    expect(await settle(task.id)).toMatchObject({ state: 'done', filesDone: 1, bytes: 3 })
    const dir = join(modelsRoot(), 'adapters', 'lora-a')
    expect(readFileSync(join(dir, 'a.safetensors'), 'utf8')).toBe('abc')
    expect(JSON.parse(readFileSync(join(dir, 'adapter.json'), 'utf8')).id).toBe('lora-a')
    expect((await models.getCatalog(settings)).adapters.find((a) => a.id === 'lora-a')?.installed).toBe(true)
    expect(await models.resolveAdapterFile(settings, 'lora-a')).toBe(join(dir, 'a.safetensors'))
  })
})

describe('download queue order (ported from tools/test-download-queue.mjs)', () => {
  it('service snapshots keep insertion order across errors, pause and retry', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-01T00:00:00Z') })
    try {
      fetchHf.mockRejectedValue(new Error('offline fixture'))
      const expected: string[] = []
      const ids = (): string[] => models.listDownloads().map((item) => item.id)
      for (const id of ['a', 'b', 'c']) {
        vi.advanceTimersByTime(10)
        expected.push((await models.downloadCustomModel(`fixture/${id}`, settings)).id)
        await new Promise(setImmediate)
        expect(ids()).toEqual(expected)
      }
      for (const id of [expected[1]!, expected[0]!, expected[2]!]) {
        vi.advanceTimersByTime(10)
        models.pauseDownload(id)
        expect(ids()).toEqual(expected)
      }
      vi.advanceTimersByTime(10)
      await models.downloadCustomModel('fixture/b', settings)
      await new Promise(setImmediate)
      expect(ids()).toEqual(expected)
      // Every task ended in error (offline); the retried one is a fresh task in the same slot.
      for (const id of expected) await settle(id, ['error'])
      expect(models.listDownloads().map((t) => t.error)).toEqual(['offline fixture', 'offline fixture', 'offline fixture'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('pausing queued tasks in a different order keeps the list order, and nothing installs', async () => {
    const held: Array<() => void> = []
    hf.intercept = (_req, res, path) => {
      if (!path.includes('/revision/')) return false
      const sha = path.includes('org/lora') ? LORA_SHA : path.includes('org/support') ? SUPPORT_SHA : VAE_SHA
      held.push(() => res.end(JSON.stringify({ sha })))
      return true
    }
    const first = await models.startDownload('model', 'vae-a', settings)
    const second = await models.startDownload('model', 'support-a', settings)
    const third = await models.startDownload('adapter', 'lora-a', settings)
    const order = [first.id, second.id, third.id]
    for (const id of [second.id, third.id, first.id]) {
      models.pauseDownload(id)
      expect(models.listDownloads().map((t) => t.id)).toEqual(order)
    }
    await vi.waitFor(() => expect(held).toHaveLength(3))
    for (const respond of held) respond()
    for (const id of order) await models.cancelDownload(id)
    expect(models.listDownloads()).toEqual([])
    expect(hf.requests.some((r) => r.includes('/resolve/'))).toBe(false)
  })
})

describe('what a model part still has to download, and where', () => {
  const GiB = 1024 ** 3
  const oid = (digit: string): string => digit.repeat(64)
  /** An interrupted download of vae-big, as runModelDownload leaves it: the resolved files in the .pending record. */
  function interrupted(files: Array<{ digit: string; size: number; blob?: number; part?: number }>): void {
    const dir = cacheDirFor(modelsRoot(), 'vae', 'org/big')
    mkdirSync(join(dir, 'blobs'), { recursive: true })
    const entries = files.map((file, index) => ({ path: `vae/f${index}`, size: file.size, oid: oid(file.digit) }))
    writeFileSync(join(dir, '.clover-vae-big.json.pending'), JSON.stringify({ version: 2, id: 'vae-big', entries, owned: [] }))
    for (const file of files) {
      const blob = join(dir, 'blobs', oid(file.digit))
      if (file.blob !== undefined) writeFileSync(blob, Buffer.alloc(file.blob))
      if (file.part !== undefined) writeFileSync(`${blob}.part`, Buffer.alloc(file.part))
    }
  }
  const entry = async (id: string) => (await models.getCatalog(settings, true)).models.find((model) => model.id === id)!

  it('counts a partial download like the check on start: complete and reused files are free, .part bytes are kept', async () => {
    interrupted([
      // Reused from another installation: the blob is already complete.
      { digit: 'a', size: 4000, blob: 4000 },
      // Partly downloaded.
      { digit: 'b', size: 3000, part: 1000 },
      // Not started.
      { digit: 'c', size: 500 },
      // A blob of the wrong size is not complete: only what its .part holds is kept.
      { digit: 'd', size: 800, blob: 10, part: 300 },
    ])
    expect(await models.modelMissingBytes(settings, await entry('vae-big'))).toBe(2000 + 500 + 500)
  })

  it('a part that never started counts its catalog size; an installed one nothing', async () => {
    expect(await models.modelMissingBytes(settings, await entry('vae-a'))).toBe(100)
    expect(await models.modelMissingBytes(settings, { ...(await entry('vae-a')), installed: true })).toBe(0)
  })

  it('groups the parts by disk: the models folder, and a part with its own folder named by that folder', async () => {
    interrupted([{ digit: 'b', size: 3 * GiB, part: 1000 }])
    // support-a has nothing to download (size 0), and an unknown id is skipped.
    const ids = ['vae-a', 'vae-big', 'support-a', 'not-in-catalog']
    const disks = await models.modelSpace(settings, ids)
    expect(disks).toHaveLength(1)
    expect(disks[0]).toMatchObject({ path: modelsRoot(), modelsFolder: true, missingBytes: [100, 3 * GiB - 1000] })
    expect(disks[0]!.freeBytes).toBeGreaterThan(0)

    // VAEs in a folder of their own: named by that folder, and 更改 would not move them.
    const own = join(dataRoot(), 'nowhere', 'vae')
    const custom = await models.modelSpace({ ...settings, modelDirectories: { ...settings.modelDirectories, vae: own } }, ids)
    // Its folder's parent does not exist: free space is unknown, and the check on start decides.
    // (vae-big's interrupted files stay in the old folder, and its catalog size is 0, so only vae-a lands there.)
    expect(custom).toEqual([{ path: own, modelsFolder: false, freeBytes: null, missingBytes: [100] }])
  })

  it('a disk that does not answer in time counts as unknown', async () => {
    vi.resetModules()
    vi.doMock('@main/lib/disk', async (original) => ({
      ...(await original<typeof import('@main/lib/disk')>()),
      freeSpace: () => new Promise<number>(() => undefined),
    }))
    try {
      const slow = await import('@main/services/models')
      expect(await slow.modelSpace(settings, ['vae-a'], 20)).toEqual([
        { path: modelsRoot(), modelsFolder: true, freeBytes: null, missingBytes: [100] },
      ])
    } finally {
      vi.doUnmock('@main/lib/disk')
    }
  })
})
