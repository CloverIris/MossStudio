import { describe, expect, it } from 'vitest'
import { Events, Ipc } from '@shared/channels'
import type { WebAccessInfo } from '@shared/backend'
import type { IpcResult, JobRecord, OnboardingStatus, TrainingHost } from '@shared/types'
import { ENGINE_JOBS_CHANNEL, SFT_BUNDLE_IDS, createMockBackend, previewPathFixture, downloadFixture, jobFixture, scenario, settingsFixture, sshHostFixture, trainerVersionFixture, type ScenarioName } from './backend'

async function invoke<T>(backend: ReturnType<typeof createMockBackend>, channel: string, payload?: unknown): Promise<IpcResult<T>> {
  return backend.bridge.invoke<IpcResult<T>>(channel, payload)
}

describe('mock backend', () => {
  it('answers unknown channels with E_MOCK_UNHANDLED and records them', async () => {
    const backend = createMockBackend()
    expect(await invoke(backend, 'nope:channel')).toEqual({ ok: false, error: { code: 'E_MOCK_UNHANDLED', message: 'mock backend has no handler for nope:channel' } })
    expect(backend.unhandled).toEqual(['nope:channel'])
  })

  it('legacy empty fallback answers [] (or null for appInfo/envScan)', async () => {
    const backend = createMockBackend('ready', { fallback: 'empty' })
    expect(await invoke(backend, 'nope:channel')).toEqual({ ok: true, data: [] })
    expect(backend.unhandled).toEqual(['nope:channel'])
  })

  it('fail() can be limited to a number of calls', async () => {
    const backend = createMockBackend()
    backend.fail(Ipc.settingsGet, { code: 'E_X' }, { times: 2 })
    expect((await invoke(backend, Ipc.settingsGet)).ok).toBe(false)
    expect((await invoke(backend, Ipc.settingsGet)).ok).toBe(false)
    expect((await invoke(backend, Ipc.settingsGet)).ok).toBe(true)
  })

  it('handle() overrides a default and thrown errors become IPC errors', async () => {
    const backend = createMockBackend()
    backend.handle(Ipc.jobList, () => { throw new Error('crash') })
    expect(await invoke(backend, Ipc.jobList)).toEqual({ ok: false, error: { code: 'E_MOCK', message: 'crash' } })
  })

  it('hold() parks one call until released with the handler answer, explicit data or an error', async () => {
    const backend = createMockBackend()
    const first = backend.hold(Ipc.settingsGet)
    const second = backend.hold(Ipc.settingsGet)
    const third = backend.hold(Ipc.settingsGet)
    const a = invoke(backend, Ipc.settingsGet)
    const b = invoke(backend, Ipc.settingsGet)
    const c = invoke(backend, Ipc.settingsGet)
    await first.called
    await first.release()
    await second.release({ custom: true })
    await third.reject({ code: 'E_HELD' })
    expect((await a).ok && (await a)).toMatchObject({ data: backend.state.settings })
    expect(await b).toEqual({ ok: true, data: { custom: true } })
    expect(await c).toMatchObject({ ok: false, error: { code: 'E_HELD' } })
    expect((await invoke(backend, Ipc.settingsGet)).ok).toBe(true)
  })

  it('isolates callers from backend state by cloning payloads and answers', async () => {
    const backend = createMockBackend()
    const payload = { sidebarCollapsed: true }
    await invoke(backend, Ipc.settingsUpdate, payload)
    payload.sidebarCollapsed = false
    expect(backend.callsTo(Ipc.settingsUpdate)).toEqual([{ sidebarCollapsed: true }])
    const answer = await invoke<{ galleryRoots: string[] }>(backend, Ipc.settingsGet)
    if (answer.ok) answer.data.galleryRoots.push('mutated')
    expect(backend.state.settings.galleryRoots).toEqual([])
  })

  it('install() sets and restores the bridge on a target', () => {
    const target: { clover?: unknown } = { clover: 'previous' }
    const backend = createMockBackend()
    const restore = backend.install(target as never)
    expect(target.clover).toBe(backend.bridge)
    restore()
    expect(target.clover).toBe('previous')
  })

  it('playJob emits the full lifecycle and keeps state.jobs current', () => {
    const backend = createMockBackend()
    const seen: string[] = []
    backend.bridge.on(Events.job, (job) => seen.push((job as { state: string }).state))
    const sequence = backend.playJob(jobFixture())
    expect(seen).toEqual(sequence.map((job) => job.state))
    expect(seen.at(0)).toBe('starting')
    expect(seen.at(-1)).toBe('succeeded')
    expect(backend.state.jobs).toHaveLength(1)
    expect(backend.state.jobs[0]!.outputs).toHaveLength(1)
    const failed = backend.playJob(jobFixture({ id: 'f' }), { fail: { code: 'E', message: 'boom' } })
    expect(failed.at(-1)).toMatchObject({ state: 'failed', error: { message: 'boom' } })
  })

  it('playJob can queue the job (counting down its place) and play live preview frames', () => {
    const backend = createMockBackend()
    const sequence = backend.playJob(jobFixture({ id: 'p', params: { ...jobFixture().params, steps: 20 } }), { queuedAhead: 2, previews: 4 })
    expect(sequence.slice(0, 2).map((job) => [job.state, job.queuePosition])).toEqual([['queued', 2], ['queued', 1]])
    expect(sequence[2]!.queuePosition).toBeUndefined()
    const frames = sequence.filter((job) => job.preview)
    expect(frames.map((job) => job.preview)).toEqual([5, 10, 15, 20].map((step, index) => ({ path: previewPathFixture('p'), step, total: 20, seq: index + 1 })))
    expect(frames.every((job) => job.stage === 'denoise' && job.state === 'running')).toBe(true)
    expect(sequence.at(-1)).toMatchObject({ state: 'succeeded' })
    expect(sequence.at(-1)!.preview).toBeUndefined()
  })

  it('engine:features answers the scenario features, without control and previews for an SSH host', async () => {
    const backend = createMockBackend()
    const local = await invoke<Record<string, unknown>>(backend, Ipc.engineFeatures, { deviceUuid: 'GPU-1' })
    expect(local.ok && local.data).toMatchObject({ control: true, preview: true, imageInput: true })
    const remote = await invoke<Record<string, unknown>>(backend, Ipc.engineFeatures, { hostId: 'h1' })
    expect(remote.ok && remote.data).toMatchObject({ control: false, preview: false, imageInput: true })
    backend.state.engineFeatures = null
    expect(await invoke(backend, Ipc.engineFeatures, { hostId: 'h1' })).toEqual({ ok: true, data: null })
  })

  it('answers a Studio job submission with a queued job carrying every input', async () => {
    const backend = createMockBackend()
    const body = {
      prompt: 'p', width: 512, height: 512, steps: 8, cfg: 1, seed: 3, canvasId: 'c1', projectId: 'project-1',
      initImage: { path: '/a/init.png', strength: 0.6 }, mask: { path: '/a/mask.png' },
      control: { adapter: '/m/c.safetensors', images: [{ kind: 'depth', path: '/a/d.png', strength: 1, start: 0, end: 1 }] },
      references: { paths: ['/a/r.png'] }, sampling: { sampler: 'heun', hires: { width: 768, height: 768 } },
    }
    const result = await backend.bridge.invoke<{ ok: boolean; data: JobRecord }>(ENGINE_JOBS_CHANNEL, body)
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ id: 'job-e2e-1', state: 'queued', canvasId: 'c1', projectId: 'project-1' })
    expect(result.data.params).toMatchObject({ initImage: body.initImage, mask: body.mask, control: body.control, references: body.references, sampling: body.sampling })
    expect(backend.state.jobs[0]!.id).toBe('job-e2e-1')
    expect(backend.callsTo(ENGINE_JOBS_CHANNEL)).toEqual([body])
    const plain = await backend.bridge.invoke<{ ok: boolean; data: JobRecord }>(ENGINE_JOBS_CHANNEL, { prompt: 'q' })
    expect(plain.data.id).toBe('job-e2e-2')
    expect(plain.data.params).not.toHaveProperty('initImage')
  })

  it('playDownload ends in done and marks the catalog entry installed, or ends in error', () => {
    const backend = createMockBackend('engineInstalledModelMissing')
    const done = backend.playDownload(downloadFixture({ targetId: 'moss-sft-dit' }))
    expect(done.map((task) => task.state)).toEqual(['running', 'verifying', 'done'])
    expect(backend.state.catalog.models.find((model) => model.id === 'moss-sft-dit')!.installed).toBe(true)
    const failed = backend.playDownload(downloadFixture({ id: 'model:x', targetId: 'x' }), { error: 'HTTP 500' })
    expect(failed.map((task) => task.state)).toEqual(['running', 'error'])
  })

  it('hostsSave stores the host without the password and emits hostsChanged', async () => {
    const backend = createMockBackend()
    const events: unknown[] = []
    backend.bridge.on(Events.hostsChanged, (hosts) => events.push(hosts))
    const saved = await invoke<{ hasPassword: boolean; password?: string }>(backend, Ipc.hostsSave, { name: 'GPU', host: 'h', authMethod: 'password', password: 'pw', trainerRoot: '~/t' })
    expect(saved).toMatchObject({ ok: true, data: { hasPassword: true } })
    expect(saved.ok && 'password' in saved.data).toBe(false)
    expect(events).toHaveLength(1)
  })

  it('reset() restores a scenario and clears overrides, calls and listeners', async () => {
    const backend = createMockBackend('ready')
    backend.fail(Ipc.settingsGet)
    backend.bridge.on(Events.job, () => undefined)
    await invoke(backend, Ipc.settingsGet)
    backend.reset('firstRun')
    expect(backend.calls).toEqual([])
    expect(backend.listenerCount(Events.job)).toBe(0)
    expect(await invoke(backend, Ipc.settingsGet)).toMatchObject({ ok: true, data: { onboardingState: 'pending' } })
  })

  describe('onboardingStatus per scenario', () => {
    const status = async (name: ScenarioName, hostId?: string) =>
      (await invoke<OnboardingStatus>(createMockBackend(name), Ipc.onboardingStatus, hostId ? { hostId } : undefined))

    it.each([
      ['firstRun', ['ok', 'missing', 'missing'], false],
      ['noGpu', ['missing', 'missing', 'missing'], false],
      ['engineInstalledModelMissing', ['ok', 'ok', 'missing'], false],
      ['modelPartiallyDownloaded', ['ok', 'ok', 'partial'], false],
      ['ready', ['ok', 'ok', 'ok'], true],
    ] as const)('%s -> %j', async (name, steps, ready) => {
      const result = await status(name)
      if (!result.ok) throw new Error(result.error.message)
      expect(result.data.steps.map((step) => step.status)).toEqual(steps)
      expect(result.data.ready).toBe(ready)
      expect(result.data.steps[2]!.modelIds).toEqual([...SFT_BUNDLE_IDS])
    })

    it('rejects an unknown host', async () => {
      expect(await status('ready', 'ghost')).toMatchObject({ ok: false, error: { code: 'E_HOST' } })
    })
  })

  it('engineProbe reports the current engine and one verdict per GPU, and fails without an engine', async () => {
    const ready = await invoke<{ hello: { version: string }; gpuCompatibility: { devices: unknown[] } }>(createMockBackend('ready'), Ipc.engineProbe)
    expect(ready).toMatchObject({ ok: true, data: { hello: { version: 'v2.1.1' }, gpuCompatibility: { devices: [expect.objectContaining({ status: 'supported' })] } } })
    expect(await invoke(createMockBackend('firstRun'), Ipc.engineProbe)).toMatchObject({ ok: false, error: { code: 'E_ENGINE_MISSING' } })
  })

  it('webAccessInfo follows the LAN feature switch', async () => {
    const off = await invoke<WebAccessInfo>(createMockBackend('ready'), Ipc.webAccessInfo)
    const on = await invoke<WebAccessInfo>(createMockBackend(scenario('ready', { settings: settingsFixture({ lanWebEnabled: true }) })), Ipc.webAccessInfo)
    expect(off).toMatchObject({ ok: true, data: { ready: false, urls: [] } })
    expect(on).toMatchObject({ ok: true, data: { ready: true, port: 7860 } })
  })

  it('trainerHosts lists SSH hosts only while remote hosts are enabled, each with its versions', async () => {
    const hosts = [sshHostFixture()]
    const versions = [trainerVersionFixture(), trainerVersionFixture({ id: 'remote-main', hostId: 'ssh-gpu' })]
    const list = async (remoteHostsEnabled: boolean) => {
      const result = await invoke<TrainingHost[]>(createMockBackend(scenario('ready', { hosts, trainerVersions: versions, settings: settingsFixture({ remoteHostsEnabled }) })), Ipc.trainerHosts)
      if (!result.ok) throw new Error(result.error.message)
      return result.data.map((host) => [host.id, host.versions?.map((version) => version.id)])
    }
    expect(await list(false)).toEqual([['local', ['trainer-main']]])
    expect(await list(true)).toEqual([['local', ['trainer-main']], ['ssh-gpu', ['remote-main']]])
  })

  it('answers releases and trainer versions from state', async () => {
    const backend = createMockBackend('ready')
    expect(await invoke(backend, Ipc.mossInferReleases)).toMatchObject({ ok: true, data: [{ tag: 'v2.1.1' }] })
    expect(await invoke(backend, Ipc.trainerAllVersions)).toMatchObject({ ok: true, data: [{ id: 'trainer-main' }] })
    expect(backend.unhandled).toEqual([])
  })

  it('scenario() patches replace top-level keys', () => {
    expect(scenario('ready', { hosts: [] }).hosts).toEqual([])
    expect(scenario('remoteHost').hosts).toHaveLength(1)
  })
})
