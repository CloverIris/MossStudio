import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeedAsset, FileList, InstallRecord, UpdateFeed } from '@shared/install'
import type { UpdaterState } from '@shared/update'
import { errorCode } from '@main/lib/codedError'
import { readInstallRecord, updateInstallRecord, writeInstallRecord } from '@main/install/record'
import type { BusySnapshot } from '@main/update/busy'
import { assertGenerationAllowed, setMinimumVersion } from '@main/update/gate'
import { cleanExitMarkerPath, failedMarkerPath, STAGING_MAX_AGE_MS, UpdateRuntime, type UpdateContext, type UpdateHost, type UpdateSettings } from '@main/update/runtime'
import { useTempDir } from '@test/helpers/tempDir'
import { fakeSpawn, feedFixture, fileListOf, makeKey, makeZip, sha256, signFeed, startFileServer, thisPlatform, type FileServer, type ZipItem } from './helpers'

const temp = useTempDir('moss-rt-')
const key = makeKey('ci')
const platform = thisPlatform()
let server: FileServer

beforeEach(async () => {
  server = await startFileServer()
  setMinimumVersion(null, '')
})
afterEach(() => server.close())

/** Big enough that a delta without it is smaller than the full package. */
const SAME = 'unchanged '.repeat(4000)

const idle: BusySnapshot = { jobs: [], downloads: [], engineDownloadPhase: null, engineInstalling: false }

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, data] of Object.entries(files)) {
    const full = join(root, ...path.split('/'))
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, data)
  }
}

function serve(path: string, body: Buffer): FeedAsset {
  server.routes.set(path, { body })
  return { url: server.url(path), sha256: sha256(body), size: body.length }
}

function zipItems(list: FileList, dir: string, prefix = ''): ZipItem[] {
  return list.entries.flatMap((entry) => (entry.type === 'file' ? [{ name: `${prefix}${entry.path}`, data: readFileSync(join(dir, ...entry.path.split('/'))), mode: entry.mode }] : []))
}

/** Publish version `version` (full + files, optionally a delta from 1.0.3) and its signed feed. */
function publish(version: string, options: { channel?: 'stable' | 'beta'; publishedAt?: string; delta?: boolean; minimumVersion?: string; announcements?: UpdateFeed['announcements']; files?: Record<string, string> } = {}) {
  const source = join(temp(), `build-${version}`)
  writeTree(source, options.files ?? { 'MossStudio': `binary ${version}`, 'resources/app.asar': `asar ${version}`, 'resources/same.pak': SAME })
  const list = fileListOf(source, version, platform)
  const filesBody = Buffer.from(JSON.stringify(list))
  const files = serve(`/v${version}/files.json`, filesBody)
  const full = serve(`/v${version}/full.zip`, makeZip(zipItems(list, source)))
  const deltas = []
  if (options.delta) {
    const changed = list.entries.filter((entry) => entry.path !== 'resources/same.pak').map((entry) => entry.path)
    const manifest = { schema: 1, platform, from: '1.0.3', to: version, files: { sha256: files.sha256, size: files.size }, changed, removed: [] }
    const body = makeZip([{ name: 'delta.json', data: JSON.stringify(manifest) }, ...zipItems({ ...list, entries: list.entries.filter((entry) => changed.includes(entry.path)) }, source, 'files/')])
    deltas.push({ ...serve(`/v${version}/delta.zip`, body), from: '1.0.3' })
  }
  const channel = options.channel ?? 'stable'
  const feed = feedFixture({
    version, channel, minimumVersion: options.minimumVersion, announcements: options.announcements ?? [],
    ...(options.publishedAt ? { publishedAt: options.publishedAt } : {}),
    platforms: { [platform]: { full, files, deltas }, 'future-os-riscv': { full, files, deltas: [] } },
  })
  const bytes = Buffer.from(JSON.stringify(feed))
  server.routes.set(`/update-${channel}.json`, { body: bytes })
  server.routes.set(`/update-${channel}.json.sig`, { body: signFeed(bytes, key) })
  return { list, full, files, deltas }
}

interface Harness {
  runtime: UpdateRuntime
  host: UpdateHost
  root: string
  recordPath: string
  states: UpdaterState[]
  settings: UpdateSettings
  busy: { value: BusySnapshot }
  spawn: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
  confirmHealth: ReturnType<typeof vi.fn>
  record: () => InstallRecord
}

function harness(options: { os?: UpdateContext['os']; record?: Partial<InstallRecord>; settings?: Partial<UpdateSettings>; unsupported?: string; version?: string; spawnError?: Error } = {}): Harness {
  const os = options.os ?? 'linux'
  const root = join(temp(), 'R 安装')
  const version = options.version ?? '1.0.3'
  const mac = os === 'darwin'
  const appPath = mac ? join(root, 'MossStudio.app') : join(root, `app-${version}`)
  const recordPath = mac ? join(temp(), 'data', 'install.json') : join(root, 'install.json')
  const baseFiles = { 'MossStudio': `binary ${version}`, 'resources/app.asar': `asar ${version}`, 'resources/same.pak': SAME }
  writeTree(appPath, baseFiles)
  writeInstallRecord(recordPath, {
    schema: 1, platform, root, dataRoot: join(root, 'data'), portable: false, channel: 'stable', current: version, failed: [],
    confirmed: true, installedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...(mac ? { appPath } : {}), ...options.record,
  })
  const settings: UpdateSettings = { networkMode: 'auto', gitMirror: null, updateChannel: 'stable', autoDownloadUpdates: false, dismissedAnnouncements: [], skippedUpdateVersion: null, ...options.settings }
  const states: UpdaterState[] = []
  const busy = { value: idle }
  const spawn = vi.fn(fakeSpawn(options.spawnError ? { error: options.spawnError } : {}).spawn)
  const quit = vi.fn()
  // Like install/health.ts: confirmed only for the version install.json names.
  const confirmHealth = vi.fn(() => {
    updateInstallRecord(recordPath, (record) => (record.current === version ? { ...record, confirmed: true } : record))
  })
  const host: UpdateHost = {
    version,
    context: { unsupportedReason: options.unsupported ?? null, os, platformKey: platform, root, appPath, launcher: mac ? null : join(root, 'mossstudio'), recordPath },
    keys: () => [key.publicKey],
    feedUrl: (channel) => server.url(`/update-${channel}.json`),
    settings: () => settings,
    saveSettings: (patch) => Object.assign(settings, patch),
    readRecord: () => readInstallRecord(recordPath),
    updateRecord: (change) => updateInstallRecord(recordPath, change),
    cacheDir: join(temp(), 'cache'),
    busy: async () => busy.value,
    emit: (state) => states.push(state),
    quit,
    confirmHealth,
    assertFreeSpace: vi.fn(async () => undefined),
    spawn,
    idlePollMs: 20,
    progressIntervalMs: 0,
    tempDir: temp(),
  }
  return { runtime: new UpdateRuntime(host), host, root, recordPath, states, settings, busy, spawn, quit, confirmHealth, record: () => readInstallRecord(recordPath)! }
}

const hitsOf = (path: string) => server.hits.filter((hit) => hit.path === path).length

describe('check → download → materialize → pending', () => {
  it('offers the update, downloads it, verifies app-<v> and writes pending', async () => {
    publish('1.1.0')
    const h = harness()
    await h.runtime.init()
    const checked = await h.runtime.check()
    expect(checked).toMatchObject({ phase: 'available', available: { version: '1.1.0', kind: 'full', notes: 'MossStudio 1.1.0' }, error: null })
    const done = await h.runtime.download()
    expect(done).toMatchObject({ phase: 'ready', pending: '1.1.0', progress: null, error: null })
    expect(readFileSync(join(h.root, 'app-1.1.0', 'resources', 'app.asar'), 'utf8')).toBe('asar 1.1.0')
    expect(existsSync(join(h.root, 'app-1.1.0.update-partial'))).toBe(false)
    expect(h.record()).toMatchObject({ current: '1.0.3', pending: '1.1.0', confirmed: true })
    expect(readdirSync(join(h.root, '.updates'))).toEqual([])
    expect(h.states.some((state) => state.phase === 'downloading' && state.progress && state.progress.bytes > 0)).toBe(true)
    expect(h.states.some((state) => state.phase === 'installing')).toBe(true)
    expect(h.host.assertFreeSpace).toHaveBeenCalledWith(expect.stringContaining('.updates'), expect.any(Number))
  })

  it('downloads automatically when 自动下载更新 is on', async () => {
    publish('1.1.0')
    const h = harness({ settings: { autoDownloadUpdates: true } })
    await h.runtime.check()
    await h.runtime.download()
    expect(h.runtime.getState()).toMatchObject({ phase: 'ready', pending: '1.1.0' })
    expect(hitsOf('/v1.1.0/full.zip')).toBe(1)
  })

  it('prefers the delta from the running version and never fetches the full package', async () => {
    publish('1.1.0', { delta: true })
    const h = harness()
    expect((await h.runtime.check()).available).toMatchObject({ kind: 'delta' })
    await h.runtime.download()
    expect(h.runtime.getState().pending).toBe('1.1.0')
    expect(hitsOf('/v1.1.0/delta.zip')).toBe(1)
    expect(hitsOf('/v1.1.0/full.zip')).toBe(0)
    expect(readFileSync(join(h.root, 'app-1.1.0', 'resources', 'same.pak'), 'utf8')).toBe(SAME)
  })

  it('falls back to the full package when the delta does not apply', async () => {
    publish('1.1.0', { delta: true })
    const h = harness()
    writeFileSync(join(h.root, 'app-1.0.3', 'resources', 'same.pak'), 'locally modified')
    await h.runtime.check()
    await h.runtime.download()
    expect(h.runtime.getState()).toMatchObject({ phase: 'ready', pending: '1.1.0' })
    expect(hitsOf('/v1.1.0/full.zip')).toBe(1)
    expect(readFileSync(join(h.root, 'app-1.1.0', 'resources', 'same.pak'), 'utf8')).toBe(SAME)
  })

  it('reports a package that fails verification and leaves no partial folder', async () => {
    const { full } = publish('1.1.0')
    const served = server.routes.get('/v1.1.0/full.zip')!.body
    server.routes.set('/v1.1.0/full.zip', { body: Buffer.alloc(served.length, 7) })
    const h = harness()
    await h.runtime.check()
    // The served zip no longer matches the feed's sha256: the download itself is refused.
    await h.runtime.download()
    expect(h.runtime.getState()).toMatchObject({ phase: 'error', pending: null })
    expect(h.runtime.getState().error).toContain('sha256')
    expect(existsSync(join(h.root, 'app-1.1.0'))).toBe(false)
    expect(full.size).toBeGreaterThan(0)
  })

  it('skips a version that failed before', async () => {
    publish('1.1.0')
    const h = harness({ record: { failed: ['1.1.0'] } })
    expect((await h.runtime.check())).toMatchObject({ phase: 'idle', available: null })
  })

  it('refuses a feed whose signature does not verify and keeps nothing from it', async () => {
    publish('1.1.0', { minimumVersion: '1.1.0' })
    server.routes.set('/update-stable.json.sig', { body: signFeed(Buffer.from('other bytes'), key) })
    const h = harness()
    const state = await h.runtime.check()
    expect(state).toMatchObject({ phase: 'error', available: null, minimumVersion: null, required: false })
    expect(state.error).toContain('签名校验失败')
  })

  it('beta reads the beta and stable feeds and picks the newest', async () => {
    publish('1.1.0')
    publish('1.2.0-beta.1', { channel: 'beta' })
    const h = harness()
    const state = await h.runtime.setChannel('beta')
    expect(state.available?.version).toBe('1.2.0-beta.1')
    expect(h.settings.updateChannel).toBe('beta')
    expect(h.record().channel).toBe('beta')
  })

  it('can be canceled and resumed', async () => {
    publish('1.1.0')
    const h = harness()
    await h.runtime.check()
    const running = h.runtime.download()
    h.runtime.cancel()
    await running
    expect(h.runtime.getState()).toMatchObject({ phase: 'available', pending: null })
    await h.runtime.download()
    expect(h.runtime.getState()).toMatchObject({ phase: 'ready', pending: '1.1.0' })
  })
})

describe('minimumVersion gate', () => {
  it('blocks generation with a clear message while current < minimumVersion', async () => {
    publish('1.1.0', { minimumVersion: '1.1.0' })
    const h = harness()
    const state = await h.runtime.check()
    expect(state).toMatchObject({ minimumVersion: '1.1.0', required: true })
    let caught: unknown
    try {
      assertGenerationAllowed()
    } catch (error) {
      caught = error
    }
    expect(errorCode(caught)).toBe('E_UPDATE_REQUIRED')
    expect((caught as Error).message).toContain('必须更新')
    expect((caught as Error).message).toContain('1.1.0')
  })

  it('allows generation when the feed requires nothing newer', async () => {
    publish('1.1.0', { minimumVersion: '1.0.0' })
    const h = harness()
    expect(await h.runtime.check()).toMatchObject({ minimumVersion: '1.0.0', required: false })
    expect(() => assertGenerationAllowed()).not.toThrow()
  })

  it('keeps the gate and the announcements across an offline start from the verified cache', async () => {
    publish('1.1.0', { minimumVersion: '1.1.0', announcements: [{ id: 'a1', level: 'warning', title: '维护', body: '' }] })
    await harness().runtime.check()
    setMinimumVersion(null, '')
    await server.close()
    server = await startFileServer()
    const offline = harness()
    await offline.runtime.init()
    expect(offline.runtime.getState()).toMatchObject({ required: true, announcements: [{ id: 'a1', title: '维护' }] })
    expect(() => assertGenerationAllowed()).toThrow('必须更新')
  })

  it('ignores a tampered cache', async () => {
    publish('1.1.0', { minimumVersion: '1.1.0' })
    const h = harness()
    await h.runtime.check()
    writeFileSync(join(h.host.cacheDir, 'update-stable.json'), JSON.stringify(feedFixture({ version: '9.9.9', minimumVersion: '9.9.9' })))
    setMinimumVersion(null, '')
    const again = harness()
    await again.runtime.init()
    expect(again.runtime.getState()).toMatchObject({ minimumVersion: null, required: false })
  })
})

describe('announcements', () => {
  it('come from the verified feed and stay dismissed', async () => {
    publish('1.1.0', { announcements: [{ id: 'n1', level: 'info', title: '公告', body: '内容' }, { id: 'n2', level: 'critical', title: '紧急', body: '' }] })
    const h = harness()
    expect((await h.runtime.check()).announcements.map((item) => item.id)).toEqual(['n1', 'n2'])
    expect(h.runtime.dismissAnnouncement('n1').announcements.map((item) => item.id)).toEqual(['n2'])
    expect(h.settings.dismissedAnnouncements).toEqual(['n1'])
    expect((await h.runtime.check()).announcements.map((item) => item.id)).toEqual(['n2'])
  })
})

describe('restart handoff (Windows/Linux)', () => {
  async function ready(): Promise<Harness> {
    publish('1.1.0')
    const h = harness()
    await h.runtime.check()
    await h.runtime.download()
    return h
  }

  it('reports nothing pending before the update is ready', async () => {
    publish('1.1.0')
    const h = harness()
    await h.runtime.check()
    expect(await h.runtime.restart()).toEqual({ status: 'nothing-pending' })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('refuses to restart while jobs or downloads run, and says what runs', async () => {
    const h = await ready()
    h.busy.value = { ...idle, jobs: [{ state: 'running' }, { state: 'running', kind: 'training' }], downloads: [{ state: 'running' }] }
    const result = await h.runtime.restart()
    expect(result).toEqual({ status: 'busy', busy: [
      { kind: 'inference', count: 1, label: '1 个生成任务' },
      { kind: 'training', count: 1, label: '1 个训练任务' },
      { kind: 'model-download', count: 1, label: '1 个模型下载' },
    ] })
    expect(h.runtime.getState().busy).toHaveLength(3)
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('hands off to the launcher with --restart and the pid, then quits', async () => {
    const h = await ready()
    expect(await h.runtime.restart()).toEqual({ status: 'restarting' })
    expect(h.spawn).toHaveBeenCalledWith(join(h.root, 'mossstudio'), [`--restart=${process.pid}`], expect.objectContaining({ detached: true }))
    expect(h.quit).toHaveBeenCalledTimes(1)
    expect(h.runtime.getState().phase).toBe('restarting')
    // The launcher applies pending; the app leaves install.json as it is.
    expect(h.record()).toMatchObject({ current: '1.0.3', pending: '1.1.0' })
  })

  it('restarts by itself once everything is idle (空闲后自动重启)', async () => {
    const h = await ready()
    h.busy.value = { ...idle, engineDownloadPhase: 'downloading' }
    const state = h.runtime.setRestartWhenIdle(true)
    expect(state.restartWhenIdle).toBe(true)
    await vi.waitFor(() => expect(h.runtime.getState()).toMatchObject({ phase: 'waiting-idle', busy: [{ kind: 'engine-download' }] }))
    expect(h.spawn).not.toHaveBeenCalled()
    h.busy.value = idle
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1))
    expect(h.quit).toHaveBeenCalledTimes(1)
  })

  it('stops waiting when restart-when-idle is turned off', async () => {
    const h = await ready()
    h.busy.value = { ...idle, jobs: [{ state: 'queued' }] }
    h.runtime.setRestartWhenIdle(true)
    await vi.waitFor(() => expect(h.runtime.getState().phase).toBe('waiting-idle'))
    expect(h.runtime.setRestartWhenIdle(false)).toMatchObject({ phase: 'ready', restartWhenIdle: false, busy: [] })
    h.busy.value = idle
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('waits for a running download before restarting when idle', async () => {
    publish('1.1.0')
    const h = harness()
    await h.runtime.check()
    const download = h.runtime.download()
    h.runtime.setRestartWhenIdle(true)
    await download
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1))
  })

  it('rolls back: switches current and previous, then restarts through the launcher', async () => {
    const h = harness({ record: { previous: '1.0.2' } })
    writeTree(join(h.root, 'app-1.0.2'), { 'MossStudio': 'binary 1.0.2' })
    const fresh = new UpdateRuntime(h.host)
    expect(fresh.getState()).toMatchObject({ previous: '1.0.2', canRollback: true })
    h.busy.value = { ...idle, jobs: [{ state: 'running' }] }
    expect((await fresh.rollback()).status).toBe('busy')
    expect(h.record().current).toBe('1.0.3')
    h.busy.value = idle
    expect(await fresh.rollback()).toEqual({ status: 'restarting' })
    expect(h.record()).toMatchObject({ current: '1.0.2', previous: '1.0.3', confirmed: false })
    expect(h.record().pending).toBeUndefined()
    expect(h.spawn).toHaveBeenCalledWith(join(h.root, 'mossstudio'), [`--restart=${process.pid}`], expect.anything())
    expect(h.quit).toHaveBeenCalled()
  })

  it('offers no rollback without the previous folder or when it failed', async () => {
    expect(harness({ record: { previous: '1.0.2' } }).runtime.getState().canRollback).toBe(false)
    const h = harness({ record: { previous: '1.0.2', failed: ['1.0.2'] } })
    writeTree(join(h.root, 'app-1.0.2'), { 'MossStudio': 'x' })
    expect(new UpdateRuntime(h.host).getState().canRollback).toBe(false)
  })
})

describe('restart handoff (macOS)', () => {
  it('leaves install.json alone, starts the swap helper with arguments only, then quits', async () => {
    publish('1.1.0')
    const h = harness({ os: 'darwin' })
    await h.runtime.check()
    await h.runtime.download()
    expect(existsSync(join(h.root, '.MossStudio-1.1.0.app', 'resources', 'app.asar'))).toBe(true)
    expect(h.record().pending).toBe('1.1.0')
    expect(await h.runtime.restart()).toEqual({ status: 'restarting' })
    // The swapped-in app records itself; until then pending stays and current names this version.
    expect(h.record()).toMatchObject({ current: '1.0.3', pending: '1.1.0', confirmed: true })
    const [command, argv] = h.spawn.mock.calls[0] as unknown as [string, string[]]
    expect(command).toBe('/bin/sh')
    expect(argv.slice(1)).toEqual([
      String(process.pid), join(h.root, 'MossStudio.app'), join(h.root, '.MossStudio-1.1.0.app'), join(h.root, '.MossStudio-1.0.3.app.previous'),
      h.recordPath, '60', failedMarkerPath(h.recordPath), '1.1.0', '/usr/bin/open', '1.0.3', cleanExitMarkerPath(h.recordPath),
    ])
    expect(h.quit).toHaveBeenCalled()
  })

  it('the swapped-in version records itself on start (current, previous, pending cleared, unconfirmed)', async () => {
    const h = harness({ os: 'darwin', version: '1.1.0', record: { current: '1.0.3', previous: '1.0.2', pending: '1.1.0', confirmed: true } })
    await new UpdateRuntime(h.host).init()
    expect(h.record()).toMatchObject({ current: '1.1.0', previous: '1.0.3', confirmed: false })
    expect(h.record().pending).toBeUndefined()
  })

  it('keeps the record and stays open when the helper cannot start', async () => {
    publish('1.1.0')
    const h = harness({ os: 'darwin', spawnError: new Error('spawn /bin/sh EACCES') })
    await h.runtime.check()
    await h.runtime.download()
    const result = await h.runtime.restart()
    expect(result).toEqual({ status: 'failed', error: '无法启动更新助手：spawn /bin/sh EACCES' })
    expect(h.runtime.getState()).toMatchObject({ phase: 'error', error: '无法启动更新助手：spawn /bin/sh EACCES', pending: '1.1.0' })
    expect(h.record()).toMatchObject({ current: '1.0.3', pending: '1.1.0' })
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('records a version the helper rolled back as failed on the next start', async () => {
    const h = harness({ os: 'darwin', record: { current: '1.1.0', previous: '1.0.3', confirmed: false } })
    writeFileSync(failedMarkerPath(h.recordPath), '1.1.0\n')
    mkdirSync(join(h.root, '.MossStudio-1.1.0.app'), { recursive: true })
    await new UpdateRuntime(h.host).init()
    expect(h.record()).toMatchObject({ current: '1.0.3', failed: ['1.1.0'], confirmed: false })
    expect(existsSync(failedMarkerPath(h.recordPath))).toBe(false)
    expect(existsSync(join(h.root, '.MossStudio-1.1.0.app'))).toBe(false)
  })
})

describe('copies that cannot update themselves', () => {
  it('still shows what is available but never downloads or restarts', async () => {
    publish('1.1.0', { announcements: [{ id: 'n', level: 'info', title: 't', body: '' }] })
    const h = harness({ unsupported: '开发版本不能自动更新', settings: { autoDownloadUpdates: true } })
    const state = await h.runtime.check()
    expect(state).toMatchObject({ supported: false, phase: 'unsupported', unsupportedReason: '开发版本不能自动更新', available: { version: '1.1.0' } })
    expect(state.announcements).toHaveLength(1)
    await h.runtime.download()
    expect(hitsOf('/v1.1.0/full.zip')).toBe(0)
    expect(await h.runtime.restart()).toEqual({ status: 'unsupported', reason: '开发版本不能自动更新' })
    expect(await h.runtime.rollback()).toEqual({ status: 'unsupported', reason: '开发版本不能自动更新' })
  })
})

describe('feed anti-rollback', () => {
  const marks = (h: Harness) => JSON.parse(readFileSync(join(h.host.cacheDir, 'update-feed-highwater.json'), 'utf8'))

  it('refuses an older, validly signed feed and keeps the newest verified one', async () => {
    publish('1.2.0', { minimumVersion: '1.1.0' })
    const h = harness()
    await h.runtime.check()
    expect(marks(h)).toEqual({ stable: { version: '1.2.0', publishedAt: '2026-11-01T00:00:00.000Z' } })
    // A stale mirror or a replay now serves an older feed that still verifies.
    publish('1.1.0')
    const state = await h.runtime.check()
    expect(state.error).toContain('版本回退')
    expect(state).toMatchObject({ available: { version: '1.2.0' }, minimumVersion: '1.1.0', required: true })
    expect(marks(h).stable.version).toBe('1.2.0')
  })

  it('refuses a republished version with an older publishedAt, accepts a newer feed and raises the mark', async () => {
    publish('1.2.0', { publishedAt: '2026-11-03T00:00:00.000Z' })
    const h = harness()
    await h.runtime.check()
    publish('1.2.0', { publishedAt: '2026-11-02T00:00:00.000Z' })
    expect((await h.runtime.check()).error).toContain('版本回退')
    publish('1.3.0', { publishedAt: '2026-11-04T00:00:00.000Z' })
    const state = await h.runtime.check()
    expect(state).toMatchObject({ error: null, available: { version: '1.3.0' } })
    expect(marks(h).stable).toEqual({ version: '1.3.0', publishedAt: '2026-11-04T00:00:00.000Z' })
  })

  it('with no newer cache to fall back to, reports the rollback and offers nothing from it', async () => {
    publish('1.2.0')
    const h = harness()
    await h.runtime.check()
    rmSync(join(h.host.cacheDir, 'update-stable.json'))
    publish('1.1.0')
    const state = await h.runtime.check()
    expect(state.error).toContain('版本回退')
    // The in-memory state keeps what was verified before; nothing from the stale feed.
    expect(state.available?.version).toBe('1.2.0')
    const fresh = harness()
    await fresh.runtime.init()
    expect(fresh.runtime.getState().available).toBeNull()
  })

  it('ignores a cached feed older than the mark on start', async () => {
    publish('1.1.0')
    const h = harness()
    await h.runtime.check()
    writeFileSync(join(h.host.cacheDir, 'update-feed-highwater.json'), JSON.stringify({ stable: { version: '1.5.0', publishedAt: '2026-11-01T00:00:00.000Z' } }))
    const again = harness()
    await again.runtime.init()
    expect(again.runtime.getState().available).toBeNull()
  })

  it('keeps marks per channel, and switching to a channel compares it afresh', async () => {
    publish('1.1.0')
    publish('1.2.0-beta.1', { channel: 'beta' })
    const h = harness()
    await h.runtime.check()
    // A beta mark from long ago (or another install) must not block the beta feed after a switch.
    writeFileSync(join(h.host.cacheDir, 'update-feed-highwater.json'), JSON.stringify({ ...marks(h), beta: { version: '9.0.0-beta.1', publishedAt: '2026-01-01T00:00:00.000Z' } }))
    const state = await h.runtime.setChannel('beta')
    expect(state).toMatchObject({ error: null, available: { version: '1.2.0-beta.1' } })
    expect(marks(h)).toMatchObject({ stable: { version: '1.1.0' }, beta: { version: '1.2.0-beta.1' } })
    // Going back to stable keeps the stable mark: stable was read all along.
    publish('1.0.9')
    expect((await h.runtime.setChannel('stable')).error).toContain('版本回退')
  })
})

describe('review fixes', () => {
  async function ready(patch: Parameters<typeof harness>[0] = {}): Promise<Harness> {
    publish('1.1.0')
    const h = harness(patch)
    await h.runtime.check()
    await h.runtime.download()
    return h
  }

  it('confirms the running version before a restart the user chose', async () => {
    const h = await ready({ record: { confirmed: false } })
    expect(h.record().confirmed).toBe(false)
    await h.runtime.restart()
    expect(h.confirmHealth).toHaveBeenCalledTimes(1)
    expect(h.record().confirmed).toBe(true)
  })

  it('stays open with a clear error when the launcher cannot start, and keeps the rollback record', async () => {
    const h = harness({ record: { previous: '1.0.2' }, spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) })
    writeTree(join(h.root, 'app-1.0.2'), { 'MossStudio': 'binary 1.0.2' })
    const runtime = new UpdateRuntime(h.host)
    const result = await runtime.rollback()
    expect(result).toEqual({ status: 'failed', error: '无法启动 MossStudio 启动器：spawn ENOENT' })
    expect(runtime.getState()).toMatchObject({ phase: 'error', error: '无法启动 MossStudio 启动器：spawn ENOENT', skippedVersion: null })
    expect(h.record()).toMatchObject({ current: '1.0.3', previous: '1.0.2' })
    expect(h.settings.skippedUpdateVersion).toBeNull()
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('fails closed when the busy check itself fails', async () => {
    const h = await ready()
    h.host.busy = async () => { throw new Error('jobs.json unreadable') }
    expect(await h.runtime.restart()).toEqual({ status: 'busy', busy: [{ kind: 'unknown', count: 1, label: '无法确认是否有任务在运行' }] })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('counts git mirror clones as busy', async () => {
    const h = await ready()
    h.busy.value = { ...idle, gitOperations: 2 }
    expect(await h.runtime.restart()).toEqual({ status: 'busy', busy: [{ kind: 'git-clone', count: 2, label: '2 个代码仓库下载' }] })
  })

  it('rollback round trip: the version left behind is not offered again until 安装 <v>', async () => {
    // Running 1.1.0 (updated from 1.0.3, which is kept as previous); 1.1.0 is still the newest release.
    publish('1.1.0')
    const h = harness({ version: '1.1.0', record: { current: '1.1.0', previous: '1.0.3' } })
    writeTree(join(h.root, 'app-1.0.3'), { 'MossStudio': 'binary 1.0.3' })
    const running = new UpdateRuntime(h.host)
    expect(await running.rollback()).toEqual({ status: 'restarting' })
    expect(h.record()).toMatchObject({ current: '1.0.3', previous: '1.1.0', confirmed: false })
    expect(h.settings.skippedUpdateVersion).toBe('1.1.0')

    // Next start: 1.0.3 runs again. 1.1.0 is newer, but the user just left it.
    const after = harness({ version: '1.0.3', record: { current: '1.0.3', previous: '1.1.0' }, settings: { autoDownloadUpdates: true, skippedUpdateVersion: '1.1.0' } })
    expect(await after.runtime.check()).toMatchObject({ phase: 'idle', available: null, skippedVersion: '1.1.0' })
    expect(hitsOf('/v1.1.0/full.zip')).toBe(0)

    // 安装 1.1.0: the user takes the skipped version back.
    const unskipped = await after.runtime.unskip()
    expect(after.settings.skippedUpdateVersion).toBeNull()
    expect(unskipped).toMatchObject({ skippedVersion: null, available: { version: '1.1.0' } })
  })

  it('offers a strictly newer release than the skipped one', async () => {
    publish('1.1.1')
    const h = harness({ settings: { skippedUpdateVersion: '1.1.0' } })
    expect((await h.runtime.check()).available?.version).toBe('1.1.1')
  })

  it('names its partial folders update-partial and never deletes a Setup\'s app-<v>.partial', async () => {
    const h = harness()
    for (const name of ['app-1.1.0.update-partial', 'app-1.1.0.update-partial.delta', 'app-1.2.0.partial']) mkdirSync(join(h.root, name), { recursive: true })
    await new UpdateRuntime(h.host).init()
    expect(existsSync(join(h.root, 'app-1.1.0.update-partial'))).toBe(false)
    expect(existsSync(join(h.root, 'app-1.1.0.update-partial.delta'))).toBe(false)
    expect(existsSync(join(h.root, 'app-1.2.0.partial'))).toBe(true)
  })

  it('cleans the macOS partial and delta folders but keeps the pending and previous bundles', async () => {
    const h = harness({ os: 'darwin', record: { pending: '1.2.0', previous: '1.0.2' } })
    const names = ['.MossStudio-1.1.0.app.update-partial', '.MossStudio-1.1.0.app.update-partial.delta', '.MossStudio-1.2.0.app', '.MossStudio-1.0.2.app.previous', '.MossStudio-0.9.0.app.previous', '.MossStudio-1.1.0.app']
    for (const name of names) mkdirSync(join(h.root, name), { recursive: true })
    await new UpdateRuntime(h.host).init()
    expect(names.filter((name) => existsSync(join(h.root, name)))).toEqual(['.MossStudio-1.2.0.app', '.MossStudio-1.0.2.app.previous'])
  })

  it('drops staged downloads that are not the current target, and stale .part files', async () => {
    publish('1.1.0')
    const h = harness()
    const staging = join(h.root, '.updates')
    writeTree(staging, { '1.0.9/full-x.zip.part': 'old target', '1.1.0/full-y.zip.part': 'current target', '1.1.0/stale.part': 'aborted long ago' })
    const old = new Date(Date.now() - STAGING_MAX_AGE_MS - 60_000)
    utimesSync(join(staging, '1.1.0', 'stale.part'), old, old)
    await new UpdateRuntime(h.host).init()
    expect(existsSync(join(staging, '1.1.0', 'stale.part'))).toBe(false)
    expect(existsSync(join(staging, '1.0.9'))).toBe(true)
    await h.runtime.check()
    expect(existsSync(join(staging, '1.0.9'))).toBe(false)
    expect(existsSync(join(staging, '1.1.0', 'full-y.zip.part'))).toBe(true)
  })

  it('asks for identity encoding on downloads', async () => {
    await ready()
    const hit = server.hits.find((item) => item.path === '/v1.1.0/full.zip')
    expect(hit?.headers['accept-encoding']).toBe('identity')
  })
})
