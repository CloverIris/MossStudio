import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@main/services/settings'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { cacheDirFor, installOnDisk, rawModel, sha256, testSettings, vaeFiles, writeCatalog } from './modelFixtures'

const contentDir = vi.hoisted(() => vi.fn<() => string | null>())
const listJobs = vi.hoisted(() => vi.fn<() => Promise<Array<{ state: string }>>>())
vi.mock('@main/lib/content', () => ({ contentDir }))
vi.mock('@main/services/supervisor', () => ({ listJobs }))
vi.mock('@main/services/network', () => ({ getLastNetwork: () => null }))
vi.mock('@main/services/hfNetwork', () => ({ fetchHf: (url: string) => fetch(url) }))

const dataRoot = useTempDataRoot()
type Models = typeof import('@main/services/models')
let models: Models
let settings: Settings
const modelsRoot = (): string => join(dataRoot(), 'models')
const releaseDir = (): string => join(dataRoot(), 'release')
const SHA = 'a'.repeat(40)

const vae = rawModel({ id: 'vae-a', repo: 'org/vae', role: 'vae', subfolder: 'vae', files: ['vae/*'], size_bytes: 10 })
const bundle = {
  id: 'b1',
  name: 'B1',
  description: '',
  support: 'support-a',
  recommended: true,
  components: { dit: 'dit-a', textEncoder: 'te-a', vae: 'vae-a' },
}

beforeEach(async () => {
  vi.resetModules()
  contentDir.mockReset().mockImplementation(() => releaseDir())
  listJobs.mockReset().mockResolvedValue([])
  models = await import('@main/services/models')
  settings = testSettings(DEFAULT_SETTINGS, { modelsRoot: modelsRoot(), hfEndpoint: 'http://127.0.0.1:9' })
  writeCatalog(releaseDir(), { schema_version: 2, updated_at: '2026-01-01T00:00:00Z', models: [vae], bundles: [bundle], adapters: [] })
})

const byId = <T extends { id: string }>(items: T[], id: string): T | undefined => items.find((item) => item.id === id)

describe('getCatalog sources', () => {
  it('reads a local release catalog and normalises raw entries', async () => {
    const catalog = await models.getCatalog(settings)
    expect(catalog.source).toBe('local')
    expect(catalog.updatedAt).toBe('2026-01-01T00:00:00Z')
    expect(catalog.bundles).toEqual([bundle])
    expect(byId(catalog.models, 'vae-a')).toMatchObject({
      provider: 'hf',
      revision: 'main',
      format: 'diffusers',
      family: 'moss-image',
      sizeBytes: 10,
      tags: [],
      installed: false,
      installedBytes: 0,
      installState: 'missing',
      resolvedRevision: undefined,
    })
  })

  it('always keeps the packaged runtime-config repair entry', async () => {
    const catalog = await models.getCatalog(settings)
    expect(catalog.models.map((m) => m.id)).toEqual(['vae-a', 'moss-runtime-config'])
  })

  it('falls back to the packaged catalog when the local one is invalid', async () => {
    writeCatalog(releaseDir(), { schema_version: 2, models: 'nope' })
    const catalog = await models.getCatalog(settings)
    expect(catalog.source).toBe('builtin')
    expect(catalog.models.some((m) => m.id === 'moss-sft-dit')).toBe(true)
    expect(catalog.bundles.map((b) => b.id)).toContain('moss-sft')
  })

  it('falls back to the packaged catalog when the remote one is unreachable', async () => {
    contentDir.mockReturnValue(null)
    const catalog = await models.getCatalog(settings)
    expect(catalog.source).toBe('builtin')
  })

  it('uses the remote catalog when reachable', async () => {
    contentDir.mockReturnValue(null)
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe('https://raw.githubusercontent.com/ShallowElec/MossStudio/main/apps/desktop/resources/models.json')
      return new Response(JSON.stringify({ schema_version: 2, models: [vae] }))
    })
    vi.stubGlobal('fetch', fetch)
    const catalog = await models.getCatalog(settings)
    expect(catalog.source).toBe('remote')
    expect(catalog.models.map((m) => m.id)).toEqual(['vae-a', 'moss-runtime-config'])
    // A catalog without bundles inherits the packaged ones.
    expect(catalog.bundles.map((b) => b.id)).toContain('moss-sft')
  })

  it('an old (schema 1) catalog cannot reintroduce known whole-repo models', async () => {
    writeCatalog(releaseDir(), {
      schema_version: 1,
      models: [rawModel({ id: 'moss-sft', repo: 'x/y', role: 'full' }), rawModel({ id: 'brand-new', repo: 'x/z', role: 'full' })],
    })
    const ids = (await models.getCatalog(settings)).models.map((m) => m.id)
    expect(ids).toContain('brand-new')
    expect(ids).toContain('moss-sft-dit')
    expect(ids).not.toContain('moss-sft')
  })
})

describe('getCatalog caching', () => {
  it('caches per storage location until invalidated or forced', async () => {
    const first = await models.getCatalog(settings)
    expect(await models.getCatalog(settings)).toBe(first)
    expect(await models.getCatalog(settings, true)).not.toBe(first)
    const second = await models.getCatalog(settings)
    models.invalidateCatalog()
    expect(await models.getCatalog(settings)).not.toBe(second)
    const third = await models.getCatalog(settings)
    expect(await models.getCatalog({ ...settings, modelsRoot: join(dataRoot(), 'other') })).not.toBe(third)
  })
})

describe('getCatalog install state', () => {
  it('reports ready with installed bytes and the resolved revision', async () => {
    installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'vae' }, SHA, vaeFiles())
    const entry = byId((await models.getCatalog(settings)).models, 'vae-a')!
    const bytes = Object.values(vaeFiles()).reduce((n, body) => n + Buffer.byteLength(body), 0)
    expect(entry).toMatchObject({ installed: true, installState: 'ready', installedBytes: bytes, resolvedRevision: SHA })
  })

  it('finds an install in the legacy shared hub', async () => {
    const legacy = join(modelsRoot(), 'hf', 'hub', 'models--org--vae')
    installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'full' }, SHA, vaeFiles())
    expect(existsSync(legacy)).toBe(true)
    expect(byId((await models.getCatalog(settings)).models, 'vae-a')?.installState).toBe('ready')
  })

  it('a marker for another revision, a damaged marker or a missing weight is not ready', async () => {
    const dir = installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'vae', revision: 'v2' }, SHA, vaeFiles())
    let entry = byId((await models.getCatalog(settings, true)).models, 'vae-a')!
    expect(entry.installed).toBe(false)
    // The marker exists, so the component is shown as partially installed.
    expect(entry.installState).toBe('partial')

    installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'vae' }, SHA, vaeFiles())
    writeFileSync(join(dir, 'snapshots', SHA, 'vae', 'diffusion_pytorch_model.safetensors'), 'x')
    entry = byId((await models.getCatalog(settings, true)).models, 'vae-a')!
    expect(entry.installState).toBe('partial')

    writeFileSync(join(dir, '.clover-vae-a.json'), '{broken')
    expect(byId((await models.getCatalog(settings, true)).models, 'vae-a')?.installed).toBe(false)
  })

  it('a cached snapshot with some selected files is partial; a pending marker too', async () => {
    const dir = cacheDirFor(modelsRoot(), 'vae', 'org/vae')
    mkdirSync(join(dir, 'refs'), { recursive: true })
    writeFileSync(join(dir, 'refs', 'main'), SHA)
    expect(byId((await models.getCatalog(settings, true)).models, 'vae-a')?.installState).toBe('missing')
    mkdirSync(join(dir, 'snapshots', SHA, 'vae'), { recursive: true })
    expect(byId((await models.getCatalog(settings, true)).models, 'vae-a')?.installState).toBe('partial')

    const other = cacheDirFor(modelsRoot(), 'vae', 'org/vae')
    writeFileSync(join(other, 'refs', 'main'), 'not-a-sha')
    expect(byId((await models.getCatalog(settings, true)).models, 'vae-a')?.installState).toBe('missing')
    writeFileSync(join(other, '.clover-vae-a.json.pending'), '{}')
    expect(byId((await models.getCatalog(settings, true)).models, 'vae-a')?.installState).toBe('partial')
  })

  it('honours a custom per-role directory', async () => {
    const custom = join(dataRoot(), 'custom-vae')
    const s = { ...settings, modelDirectories: { ...settings.modelDirectories, vae: custom } }
    // role 'full' lays the cache out directly under <root>/hf/hub, which is where a custom VAE root keeps it.
    installOnDisk(custom, { id: 'vae-a', repo: 'org/vae', role: 'full' }, SHA, vaeFiles())
    expect(byId((await models.getCatalog(s)).models, 'vae-a')?.installed).toBe(true)
    expect(byId((await models.getCatalog(settings)).models, 'vae-a')?.installed).toBe(false)
  })
})

describe('local imports and bundles in the catalog', () => {
  function register(path: string, role: 'dit' | 'text_encoder' | 'vae'): Promise<unknown> {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${role}-weights`)
    return models.registerScannedModels(settings, [{ path, role, layout: 'comfyui-single-file' }])
  }

  it('lists registered files as local entries and keeps the old local-files bundle as a saved combination', async () => {
    const comfy = join(dataRoot(), 'ComfyUI', 'models')
    await register(join(comfy, 'diffusion_models', 'd.safetensors'), 'dit')
    await register(join(comfy, 'text_encoders', 't.safetensors'), 'text_encoder')
    let catalog = await models.getCatalog(settings)
    expect(catalog.bundles.map((b) => b.id)).toEqual(['b1'])
    const dit = catalog.models.find((m) => m.provider === 'local' && m.role === 'dit')!
    expect(dit).toMatchObject({
      revision: 'local',
      format: 'comfyui',
      family: 'local',
      installState: 'ready',
      installed: true,
      localPath: join(comfy, 'diffusion_models', 'd.safetensors'),
      tags: ['local-import', 'comfyui', 'unhashed'],
    })

    // Older versions made a model of the three by themselves; it is kept once, as a saved combination.
    await register(join(comfy, 'vae', 'v.safetensors'), 'vae')
    catalog = await models.getCatalog(settings)
    expect(catalog.bundles.map((b) => b.id)).toEqual(['b1', 'local-files'])
    expect(catalog.bundles[1]).toMatchObject({
      name: '电脑上的模型',
      custom: true,
      components: { dit: dit.id },
      support: 'moss-runtime-config',
    })
    expect(JSON.parse(readFileSync(join(dataRoot(), 'model-combinations.json'), 'utf8'))).toEqual([
      expect.objectContaining({ id: 'local-files', components: expect.objectContaining({ dit: dit.id }) }),
    ])
  })

  it('marks an import whose file changed or vanished as error and drops it from the local bundle', async () => {
    const file = join(dataRoot(), 'w', 'vae', 'v.safetensors')
    await register(file, 'vae')
    writeFileSync(file, 'changed-size-content')
    const entry = (await models.getCatalog(settings)).models.find((m) => m.provider === 'local')!
    expect(entry).toMatchObject({ installState: 'error', installed: false, installedBytes: 0 })
  })

  it('a hashed full import is tagged with its SHA256', async () => {
    const dir = join(dataRoot(), 'imports-src')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'w.safetensors'), 'content')
    expect(await models.importModelFolder(dir, settings)).toEqual({ added: 1, duplicates: 0 })
    const entry = (await models.getCatalog(settings)).models.find((m) => m.provider === 'local')!
    expect(entry.tags).toContain(`sha256:${sha256('content')}`)
    expect(entry.notes).toContain(sha256('content'))
  })

  it('refuses to start a remote download for a local import', async () => {
    await register(join(dataRoot(), 'x', 'vae', 'v.safetensors'), 'vae')
    const local = (await models.getCatalog(settings)).models.find((m) => m.provider === 'local')!
    await expect(models.startDownload('model', local.id, settings)).rejects.toThrow('本地导入文件不能作为远程下载任务')
    await expect(models.startDownload('model', 'nope', settings)).rejects.toThrow('目录中没有该条目')
  })

  it('scanModels is a read-only passthrough', async () => {
    const dir = join(dataRoot(), 'scan', 'vae')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'v.safetensors'), 'v')
    const result = await models.scanModels(join(dataRoot(), 'scan'))
    expect(result.candidates.map((c) => c.role)).toEqual(['vae'])
    expect(readdirSync(join(dataRoot(), 'scan')).sort()).toEqual(['vae'])
  })
})

describe('adapters', () => {
  const adapterRaw = {
    id: 'lora-a',
    name: 'Lora A',
    provider: 'hf',
    repo: 'org/lora',
    kind: 'lora',
    license: 'mit',
    files: ['a.safetensors'],
    size_bytes: 3,
  }
  const adaptersRoot = (): string => join(modelsRoot(), 'adapters')

  beforeEach(() => {
    writeCatalog(releaseDir(), { schema_version: 2, models: [vae], bundles: [], adapters: [adapterRaw] })
  })

  it('marks a catalog adapter installed only with adapter.json and every non-empty file', async () => {
    const dir = join(adaptersRoot(), 'lora-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.safetensors'), 'abc')
    expect(byId((await models.getCatalog(settings, true)).adapters, 'lora-a')?.installed).toBe(false)
    writeFileSync(join(dir, 'adapter.json'), '{}')
    expect(byId((await models.getCatalog(settings, true)).adapters, 'lora-a')).toMatchObject({
      installed: true,
      installedBytes: 3,
      sizeBytes: 3,
      revision: 'main',
    })
  })

  it('imports a LoRA file by copying it under a sanitised, unique id', async () => {
    const source = join(dataRoot(), 'downloads', 'My Style (v2).safetensors')
    mkdirSync(join(source, '..'), { recursive: true })
    writeFileSync(source, 'lora-bytes')
    const first = await models.importAdapterFile(settings, { sourcePath: source })
    const second = await models.importAdapterFile(settings, { sourcePath: source, name: '  Custom  ' })
    expect(first).toMatchObject({
      id: 'My-Style--v2-',
      name: 'My Style (v2)',
      provider: 'local',
      tags: ['local-import'],
      installed: true,
      sizeBytes: 10,
    })
    expect(second).toMatchObject({ id: 'My-Style--v2--2', name: 'Custom' })
    expect(readFileSync(join(adaptersRoot(), 'My-Style--v2-', 'My Style (v2).safetensors'), 'utf8')).toBe('lora-bytes')

    const catalog = await models.getCatalog(settings)
    expect(catalog.adapters.map((a) => a.id)).toEqual(['lora-a', 'My-Style--v2-', 'My-Style--v2--2'])
    expect(await models.resolveAdapterFile(settings, 'My-Style--v2-')).toBe(
      join(adaptersRoot(), 'My-Style--v2-', 'My Style (v2).safetensors'),
    )
  })

  it('rejects non-safetensors LoRA files', async () => {
    await expect(models.importAdapterFile(settings, { sourcePath: '/x/model.ckpt' })).rejects.toThrow(/\.safetensors/)
  })

  it('falls back to "lora" for a file name without usable characters', async () => {
    const source = join(dataRoot(), '风格.safetensors')
    writeFileSync(source, 'x')
    expect((await models.importAdapterFile(settings, { sourcePath: source })).id).toBe('lora')
  })

  it('registerTrainedAdapter replaces a previous record with the same id', async () => {
    const source = join(dataRoot(), 'out.safetensors')
    writeFileSync(source, 'v1')
    await models.registerTrainedAdapter(settings, { id: 'run/1', name: '', sourcePath: source })
    writeFileSync(source, 'v2-longer')
    const entry = await models.registerTrainedAdapter(settings, { id: 'run/1', name: 'Run 1', sourcePath: source, base: 'moss-sft' })
    expect(entry).toMatchObject({
      id: 'run-1',
      name: 'Run 1',
      tags: ['trained'],
      sizeBytes: 9,
      base: 'moss-sft',
      kind: 'lora',
      license: 'local',
    })
    const index = JSON.parse(readFileSync(join(adaptersRoot(), 'index.json'), 'utf8'))
    expect(index.adapters).toHaveLength(1)
  })

  it('findAdapterName prefers the warm cache, then the local index, then the packaged catalog', async () => {
    expect(await models.findAdapterName(settings, 'lora-turbo-mfd')).not.toBe('lora-turbo-mfd')
    expect(await models.findAdapterName(settings, 'unknown-id')).toBe('unknown-id')
    const source = join(dataRoot(), 'x.safetensors')
    writeFileSync(source, 'x')
    await models.registerTrainedAdapter(settings, { id: 'mine', name: 'Mine', sourcePath: source })
    expect(await models.findAdapterName(settings, 'mine')).toBe('Mine')
    await models.getCatalog(settings)
    expect(await models.findAdapterName(settings, 'lora-a')).toBe('Lora A')
  })

  it('resolveAdapterFile follows adapter.json, then scans, and returns null when absent', async () => {
    const dir = join(adaptersRoot(), 'a1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'adapter.json'), JSON.stringify({ files: ['README.md', 'w.safetensors'] }))
    writeFileSync(join(dir, 'w.safetensors'), 'w')
    writeFileSync(join(dir, 'z.safetensors'), 'z')
    expect(await models.resolveAdapterFile(settings, 'a1')).toBe(join(dir, 'w.safetensors'))
    writeFileSync(join(dir, 'adapter.json'), JSON.stringify({ files: ['../escape.safetensors'] }))
    expect(await models.resolveAdapterFile(settings, 'a1')).toMatch(/[wz]\.safetensors$/)
    expect(await models.resolveAdapterFile(settings, 'missing')).toBeNull()
  })

  it('deleting an adapter removes its folder and its local index entry', async () => {
    const source = join(dataRoot(), 'x.safetensors')
    writeFileSync(source, 'x')
    await models.registerTrainedAdapter(settings, { id: 'mine', name: 'Mine', sourcePath: source })
    await models.deleteModel('adapter', 'mine', settings)
    expect(existsSync(join(adaptersRoot(), 'mine'))).toBe(false)
    expect(byId((await models.getCatalog(settings)).adapters, 'mine')).toBeUndefined()
  })
})

describe('deleteModel', () => {
  it('removes owned blobs, snapshot links and the marker', async () => {
    const dir = installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'vae' }, SHA, vaeFiles())
    await models.deleteModel('model', 'vae-a', settings)
    expect(readdirSync(join(dir, 'blobs'))).toEqual([])
    expect(existsSync(join(dir, '.clover-vae-a.json'))).toBe(false)
    expect(existsSync(join(dir, 'snapshots', SHA, 'vae', 'config.json'))).toBe(false)
    expect(byId((await models.getCatalog(settings)).models, 'vae-a')?.installed).toBe(false)
  })

  it('keeps blobs that are not owned or are shared with another component record', async () => {
    writeCatalog(releaseDir(), {
      schema_version: 2,
      models: [vae, rawModel({ id: 'vae-b', repo: 'org/vae', role: 'vae', subfolder: 'vae', files: ['vae/*'] })],
    })
    const dir = installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'vae' }, SHA, vaeFiles())
    installOnDisk(modelsRoot(), { id: 'vae-b', repo: 'org/vae', role: 'vae' }, SHA, vaeFiles())
    await models.deleteModel('model', 'vae-a', settings)
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(2)
    expect(existsSync(join(dir, '.clover-vae-a.json'))).toBe(false)
    expect(byId((await models.getCatalog(settings)).models, 'vae-b')?.installed).toBe(true)
  })

  it('never deletes files a legacy (unknown-version) marker may reference', async () => {
    const dir = installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'vae' }, SHA, vaeFiles())
    writeFileSync(join(dir, '.clover-legacy.json'), JSON.stringify({ version: 1 }))
    await models.deleteModel('model', 'vae-a', settings)
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(2)
  })

  it('refuses to delete when another marker is corrupt', async () => {
    const dir = installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'vae' }, SHA, vaeFiles())
    writeFileSync(join(dir, '.clover-other.json'), '{')
    await expect(models.deleteModel('model', 'vae-a', settings)).rejects.toThrow('共享组件记录损坏')
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(2)
  })

  it('keeps blobs when another snapshot of the repo exists', async () => {
    const dir = installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'vae' }, SHA, vaeFiles())
    mkdirSync(join(dir, 'snapshots', 'b'.repeat(40)), { recursive: true })
    await models.deleteModel('model', 'vae-a', settings)
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(2)
    expect(existsSync(join(dir, '.clover-vae-a.json'))).toBe(false)
  })

  it('removes materialized bundles that reference the component', async () => {
    installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'vae' }, SHA, vaeFiles())
    const bundles = join(modelsRoot(), 'bundles')
    const using = join(bundles, 'c'.repeat(24))
    const other = join(bundles, 'd'.repeat(24))
    const foreign = join(bundles, 'not-a-bundle')
    for (const [dir, id] of [
      [using, 'vae-a'],
      [other, 'other'],
      [foreign, 'vae-a'],
    ] as const) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'clover_model.json'), JSON.stringify({ version: 1, components: [{ id }] }))
    }
    await models.deleteModel('model', 'vae-a', settings)
    expect(existsSync(using)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(foreign)).toBe(true)
  })

  it('refuses while a job is running and leaves files alone', async () => {
    const dir = installOnDisk(modelsRoot(), { id: 'vae-a', repo: 'org/vae', role: 'vae' }, SHA, vaeFiles())
    listJobs.mockResolvedValue([{ state: 'running' }])
    await expect(models.deleteModel('model', 'vae-a', settings)).rejects.toThrow('有任务正在运行')
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(2)
  })

  it('requires a complete install record', async () => {
    await expect(models.deleteModel('model', 'vae-a', settings)).rejects.toThrow('缓存安装记录不完整')
  })

  it('ignores unknown ids', async () => {
    await expect(models.deleteModel('model', 'nope', settings)).resolves.toBeUndefined()
  })

  it('removes a local import record without touching the source file', async () => {
    const file = join(dataRoot(), 'mine', 'vae', 'v.safetensors')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'v')
    await models.registerScannedModels(settings, [{ path: file, role: 'vae' }])
    const local = (await models.getCatalog(settings)).models.find((m) => m.provider === 'local')!
    await models.deleteModel('model', local.id, settings)
    expect((await models.getCatalog(settings)).models.some((m) => m.provider === 'local')).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('v')
  })
})

describe('cleanupEmptyModelDirs', () => {
  it('removes only empty hf/hub layout folders', async () => {
    const emptyHub = join(modelsRoot(), 'vae', 'hf', 'hub')
    const usedHub = join(modelsRoot(), 'moss', 'hf', 'hub')
    mkdirSync(emptyHub, { recursive: true })
    mkdirSync(join(usedHub, 'models--a--b'), { recursive: true })
    const removed = await models.cleanupEmptyModelDirs(settings)
    expect(removed.sort()).toEqual([emptyHub, join(modelsRoot(), 'vae', 'hf')].sort())
    expect(existsSync(join(usedHub, 'models--a--b'))).toBe(true)
    expect(existsSync(join(modelsRoot(), 'vae'))).toBe(true)
    expect(await models.cleanupEmptyModelDirs(settings)).toEqual([])
  })
})
