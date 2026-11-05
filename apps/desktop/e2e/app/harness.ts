/**
 * The E2E app's fake main process.
 *
 * The real renderer `App` runs against `createMockBackend(scenario)` from
 * test/mocks/backend, chosen by the page URL:
 *
 *   index.html?scenario=ready&theme=dark&platform=win32&settings={"trainingEnabled":true}#/studio
 *
 * `defer=1` installs the backend but waits for `window.__mock.start()`, so a
 * test can edit `__mock.state` (with `__mock.fixtures`) before the app's first
 * IPC call. `telemetry=0` skips the GPU telemetry main would push. Everything else a test needs is on `window.__mock` (see E2eMock).
 */
import { Events, Ipc } from '@shared/channels'
import type { JobRecord, Settings } from '@shared/types'
import * as fixtures from '../../test/mocks/backend/fixtures'
import * as installFixtures from '../../test/mocks/backend/install'
import { createMockBackend, type MockBackend, type MockBackendState, type ScenarioName } from '../../test/mocks/backend'
import { startTelemetry } from './telemetry'

/** The pseudo IPC channel the Studio's HTTP job submission is recorded under (answered by the mock backend). */
export const ENGINE_JOBS_CHANNEL = fixtures.ENGINE_JOBS_CHANNEL

export interface E2eMock {
  backend: MockBackend
  readonly state: MockBackendState
  readonly calls: Array<{ channel: string; payload: unknown }>
  callsTo(channel: string): unknown[]
  emit(event: string, data: unknown): void
  fail: MockBackend['fail']
  hold: MockBackend['hold']
  handle: MockBackend['handle']
  playDownload: MockBackend['playDownload']
  playJob: MockBackend['playJob']
  /**
   * Run a submitted job to the end with `outputs` images (default 1); `previews`
   * live frames while denoising, `queuedAhead` queue places counting down first.
   */
  finishJob(id: string, options?: { outputs?: number; fail?: { code: string; message: string }; previews?: number; queuedAhead?: number }): JobRecord[]
  /** Drive a submitted job part-way (running, denoise at half). */
  progressJob(id: string): JobRecord
  fixtures: typeof fixtures
  /** Setup/uninstall window fixtures and scenarios (test/mocks/backend/install.ts). */
  installFixtures: typeof installFixtures
  Ipc: typeof Ipc
  Events: typeof Events
  /** Mount the app (only needed with `defer=1`). */
  start(): void
  started: boolean
}

declare global {
  interface Window {
    __mock: E2eMock
  }
}

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`E2E: query parameter is not JSON: ${raw}`)
  }
}

export function installHarness(mount: () => void): E2eMock {
  const query = new URLSearchParams(window.location.search)
  const name = (query.get('scenario') ?? 'ready') as ScenarioName
  const backend = createMockBackend(name, {
    bridge: {
      platform: query.get('platform') ?? 'win32',
      windowKind: (query.get('window') ?? 'launcher') as Window['clover']['windowKind'],
    },
  })
  const theme = query.get('theme') as Settings['theme'] | null
  const settingsPatch = parseJson<Partial<Settings>>(query.get('settings')) ?? {}
  backend.state.settings = {
    ...backend.state.settings,
    // Animations make screenshots and timing flaky; tests can opt back in.
    uiAnimation: 'off',
    ...(theme ? { theme } : {}),
    ...settingsPatch,
  } as Settings

  // The Studio submits jobs over HTTP to the local backend; the mock backend answers ENGINE_JOBS_CHANNEL.
  const realFetch = window.fetch.bind(window)
  const backendUrl = 'http://studio-fixture'
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(backendUrl)) return realFetch(input, init)
    const path = url.slice(backendUrl.length)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const result = await backend.bridge.invoke<{ ok: boolean; data?: unknown; error?: { message: string } }>(`http:${method} ${path}`, body)
    return new Response(JSON.stringify(result.ok ? result.data : { error: result.error?.message }), {
      status: result.ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  const jobById = (id: string): JobRecord => {
    const job = backend.state.jobs.find((item) => item.id === id)
    if (!job) throw new Error(`E2E: no job ${id}`)
    return job
  }

  const mock: E2eMock = {
    backend,
    get state() { return backend.state },
    get calls() { return backend.calls },
    callsTo: (channel) => backend.callsTo(channel),
    emit: (event, data) => backend.emit(event, data),
    fail: (...args) => backend.fail(...args),
    hold: (channel) => backend.hold(channel),
    handle: (channel, handler) => backend.handle(channel, handler),
    playDownload: (task, options) => backend.playDownload(task, options),
    playJob: (job, options) => backend.playJob(job, options),
    finishJob(id, options = {}) {
      const job = jobById(id)
      const sequence = fixtures.jobLifecycle(job, { fail: options.fail, previews: options.previews, queuedAhead: options.queuedAhead })
      const count = options.outputs ?? 1
      const last = sequence.at(-1)!
      if (!options.fail) {
        last.outputs = Array.from({ length: count }, (_, index) => ({
          path: `/fixture/outputs/${id}-${index}.png`, width: job.params.width, height: job.params.height, seed: job.params.seed + index,
        }))
      }
      for (const step of sequence) {
        backend.state.jobs = [step, ...backend.state.jobs.filter((item) => item.id !== step.id)]
        backend.emit(Events.job, step)
      }
      return sequence
    },
    progressJob(id) {
      const job = jobById(id)
      const total = job.params.steps
      const step: JobRecord = { ...job, state: 'running', stage: 'denoise', progress: { stage: 'denoise', current: Math.floor(total / 2), total, percent: 50 } }
      backend.state.jobs = [step, ...backend.state.jobs.filter((item) => item.id !== id)]
      backend.emit(Events.job, step)
      return step
    },
    fixtures,
    installFixtures,
    Ipc,
    Events,
    started: false,
    start() {
      if (mock.started) return
      mock.started = true
      mount()
      if (query.get('telemetry') !== '0') startTelemetry(backend)
    },
  }
  window.__mock = mock
  backend.install(window as unknown as { clover?: Window['clover'] })
  if (query.get('defer') !== '1') mock.start()
  return mock
}
