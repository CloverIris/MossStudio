import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobParams, JobRecord, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@main/services/settings'
import { useTempDataRoot } from '@test/helpers/tempDir'

const spawnEngineServer = vi.hoisted(() => vi.fn())
const spawnSync = vi.hoisted(() => vi.fn())
vi.mock('@main/lib/probeEngine', () => ({ spawnEngineServer }))
// Which package each GPU runs; null = none installed for it (the configured moss-server serves it).
const resolveDeviceEngine = vi.hoisted(() => vi.fn())
const getSettings = vi.hoisted(() => vi.fn())
vi.mock('@main/services/engineInstalls', () => ({ resolveDeviceEngine }))
vi.mock('@main/services/settings', async (importOriginal) => ({ ...(await importOriginal<object>()), getSettings }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync, default: { ...actual, spawnSync } }
})

type Request = { id: string; method: string; params: Record<string, unknown> }
type Reply = (request: Request, server: FakeServer) => void

/** A scripted stand-in for moss-server speaking NDJSON over stdio. */
class FakeServer extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  requests: Request[] = []
  killed: string[] = []
  closed = false
  constructor(
    public reply: Reply,
    public args: string[],
    public env: Record<string, string>,
  ) {
    super()
    let buffer = ''
    this.stdin.on('data', (chunk: Buffer) => {
      const lines = (buffer + chunk.toString()).split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines.filter(Boolean)) {
        const request = JSON.parse(line) as Request
        this.requests.push(request)
        setImmediate(() => this.reply(request, this))
      }
    })
  }
  send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', code, signal)
  }
  kill(signal: string): boolean {
    this.killed.push(signal)
    setImmediate(() => this.exit(null, signal))
    return true
  }
  methods(): string[] {
    return this.requests.map((r) => r.method)
  }
}

const helloResult = (devices: unknown[] = [{ index: 0, name: 'GPU', supported: true, compute_capability: '8.9' }], protocol = 2) => ({
  protocol_version: protocol,
  version: '2.1.1',
  probe: { devices },
})

/** Default behaviour: hello, load, generate with progress and an ok result, shutdown. */
const happy: Reply = (request, server) => {
  if (request.method === 'hello') return server.send({ id: request.id, result: helloResult() })
  if (request.method === 'load') return server.send({ id: request.id, result: {} })
  if (request.method === 'shutdown') {
    server.send({ id: request.id, result: {} })
    setImmediate(() => server.exit(0))
    return
  }
  if (request.method === 'generate') {
    const id = request.id
    server.send({ event: 'log', id, level: 'warning', message: 'low vram' })
    server.send({ event: 'progress', id, phase: 'text_encoder', step: 0, total_steps: 0 })
    server.send({ event: 'progress', id, phase: 'denoise', step: 1, total_steps: 4, step_seconds: 0.5 })
    server.send({ event: 'progress', id, phase: 'denoise', step: 2, total_steps: 4, step_seconds: 0.5 })
    server.send({ event: 'progress', id: 'someone-else', phase: 'denoise', step: 3, total_steps: 4 })
    server.send({ id, result: {} })
    server.send({
      event: 'done',
      id,
      status: 'ok',
      warnings: ['clamped cfg'],
      report: {
        seed_used: 77,
        quality: { tier: 'high' },
        timings_s: { dit_load: 1.5, encode: 0.25, denoise: 2, decode: 0.5, total: 4.25 },
      },
    })
  }
}

const dataRoot = useTempDataRoot()
let mossInfer: typeof import('@main/services/mossInfer')
let servers: FakeServer[]
let reply: Reply
let settings: Settings
let serverPath: string

beforeEach(async () => {
  vi.resetModules()
  Object.defineProperty(process, 'resourcesPath', { value: join(dataRoot(), 'resources'), configurable: true })
  servers = []
  reply = happy
  spawnEngineServer.mockReset().mockImplementation((_path: string, args: string[], env: Record<string, string>) => {
    const server = new FakeServer((request, s) => reply(request, s), args, env)
    servers.push(server)
    return server
  })
  spawnSync.mockReset().mockReturnValue({ status: 1, stdout: '' })
  serverPath = join(dataRoot(), 'moss-server')
  writeFileSync(serverPath, '#!')
  settings = { ...DEFAULT_SETTINGS, mossInferServerPath: serverPath }
  resolveDeviceEngine.mockReset().mockReturnValue(null)
  getSettings.mockReset().mockImplementation(() => settings)
  mossInfer = await import('@main/services/mossInfer')
})
afterEach(async () => {
  await mossInfer.restartMossInfer()
})

interface Sink {
  events: Array<Record<string, unknown>>
  stderr: string[]
  /** Resolves with the exit code passed to `sink.done`. */
  done: Promise<number>
}

const params: JobParams = { prompt: 'a cat', negativePrompt: 'blurry', width: 512, height: 768, steps: 4, cfg: 1, seed: 5, profile: 'base' }

function run(id: string, patch: Record<string, unknown> = {}): Sink {
  const events: Array<Record<string, unknown>> = []
  const stderr: string[] = []
  let resolveDone: (code: number) => void = () => undefined
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve
  })
  void mossInfer.runMossInferJob(
    { id } as JobRecord,
    params,
    {
      model: join(dataRoot(), 'bundle'),
      device: 0,
      deviceUuid: 'GPU-a',
      systemDeviceIndex: 1,
      loras: [],
      output: join(dataRoot(), `${id}.png`),
      settings,
      ...patch,
    },
    { event: (payload) => events.push(payload), stderr: (line) => stderr.push(line), done: resolveDone },
  )
  return { events, stderr, done }
}

describe('generateErrorMessage', () => {
  it('says which tier to pick when the loaded model refuses the one sent', () => {
    const message = mossInfer.generateErrorMessage('invalid_argument', 'tier reference cannot run an INT8 DiT')
    expect(message).toMatch(/^这个主模型文件要换一个运行档位：INT8 用 High，INT4 和 NVFP4 用 Turbo/)
    expect(message).toContain('tier reference cannot run an INT8 DiT')
  })

  it('passes other errors through', () => {
    expect(mossInfer.generateErrorMessage('invalid_argument', 'width must be a multiple of 16')).toBe('width must be a multiple of 16')
    expect(mossInfer.generateErrorMessage('out_of_memory', 'tier high: out of memory')).toBe('tier high: out of memory')
  })
})

describe('resolveServerPath', () => {
  it('prefers the configured path, then MOSS_SERVER, then the bundled engine, then PATH', () => {
    expect(mossInfer.resolveServerPath(settings)).toBe(serverPath)
    const envServer = join(dataRoot(), 'env-server')
    writeFileSync(envServer, '')
    vi.stubEnv('MOSS_SERVER', envServer)
    expect(mossInfer.resolveServerPath({ ...settings, mossInferServerPath: join(dataRoot(), 'missing') })).toBe(envServer)
    vi.stubEnv('MOSS_SERVER', '')
    const onPath = join(dataRoot(), 'on-path')
    writeFileSync(onPath, '')
    spawnSync.mockReturnValue({ status: 0, stdout: `${onPath}\nother\n` })
    expect(mossInfer.resolveServerPath({ ...settings, mossInferServerPath: null })).toBe(onPath)
  })

  it('returns null when nothing exists, including a PATH hit that vanished', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: join(dataRoot(), 'gone') })
    expect(mossInfer.resolveServerPath({ ...settings, mossInferServerPath: null })).toBeNull()
    spawnSync.mockImplementation(() => {
      throw new Error('which missing')
    })
    expect(mossInfer.resolveServerPath({ ...settings, mossInferServerPath: null })).toBeNull()
  })
})

describe('runMossInferJob', () => {
  it('starts the sidecar bound to the GPU UUID, loads the model and translates the generation', async () => {
    const s = run('job-1', { loras: [{ path: '/l.safetensors', strength: 0.5 }] })
    expect(await s.done).toBe(0)
    const [server] = servers
    expect(server!.env).toEqual({ CUDA_VISIBLE_DEVICES: 'GPU-a' })
    expect(server!.args).toEqual(['--parent-pid', String(process.pid)])
    expect(server!.methods()).toEqual(['hello', 'load', 'generate'])
    expect(server!.requests[1]!.params).toEqual({
      mode: 'balanced',
      device: 0,
      tier: 'high',
      cache_dir: join(dataRoot(), 'cache', 'mossinfer'),
      model: join(dataRoot(), 'bundle'),
    })
    expect(server!.requests[2]).toMatchObject({
      id: 'job-1',
      params: {
        prompt: 'a cat',
        negative_prompt: 'blurry',
        width: 512,
        height: 768,
        steps: 4,
        cfg: 1,
        seed: 5,
        loras: [{ path: '/l.safetensors', strength: 0.5 }],
      },
    })

    expect(s.events).toEqual([
      { type: 'hello', protocol: 1, runner_version: 'mossinfer-2.1.1' },
      { type: 'ready', device: 'cuda:1', dtype: 'bf16', capabilities: ['progress', 'cancel'] },
      { type: 'log', level: 'warn', message: 'low vram' },
      { type: 'stage', name: 'text' },
      { type: 'progress', stage: 'text', current: 0, total: 0, percent: 0, eta_ms: undefined },
      { type: 'stage', name: 'denoise' },
      { type: 'progress', stage: 'denoise', current: 1, total: 4, percent: 25, eta_ms: 1500 },
      { type: 'progress', stage: 'denoise', current: 2, total: 4, percent: 50, eta_ms: 1000 },
      { type: 'log', level: 'warn', message: 'clamped cfg' },
      { type: 'stage', name: 'save' },
      {
        type: 'result',
        images: [{ path: join(dataRoot(), 'job-1.png'), width: 512, height: 768, seed: 77 }],
        timings: { load_ms: 1500, text_encode_ms: 250, denoise_ms: 2000, decode_ms: 500, total_ms: 4250 },
      },
    ])
    expect(JSON.parse(readFileSync(join(dataRoot(), 'job-1.json'), 'utf8'))).toEqual({
      prompt: 'a cat',
      negative_prompt: 'blurry',
      seed: 77,
      width: 512,
      height: 768,
      engine: 'mossinfer',
      tier: 'high',
    })
  })

  it('queues jobs per GPU in FIFO order and reuses the loaded model', async () => {
    let release: () => void = () => undefined
    reply = (request, server) => {
      if (request.method === 'generate' && request.id === 'a') {
        server.send({ event: 'progress', id: 'a', phase: 'denoise', step: 1, total_steps: 4 })
        release = () => happy(request, server)
        return
      }
      happy(request, server)
    }
    const a = run('a')
    await vi.waitFor(() => expect(a.events.some((e) => e['type'] === 'progress')).toBe(true))
    // While a generation is active, a newcomer is told it waits.
    const b = run('b')
    const c = run('c')
    expect(b.events[0]).toEqual({ type: 'log', level: 'info', message: 'MossInfer 引擎忙，排队等待上一个任务完成' })
    release()
    expect(await a.done).toBe(0)
    expect(await b.done).toBe(0)
    expect(await c.done).toBe(0)
    expect(servers).toHaveLength(1)
    expect(servers[0]!.methods()).toEqual(['hello', 'load', 'generate', 'generate', 'generate'])
    expect(servers[0]!.requests.filter((r) => r.method === 'generate').map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('reloads when the model or tier changes and sends component files instead of a folder', async () => {
    await run('a').done
    await run('b', { model: '', ditFile: '/d.safetensors', textEncoderFile: '/t.safetensors', vaeFile: '/v.safetensors' }).done
    const loads = servers[0]!.requests.filter((r) => r.method === 'load')
    expect(loads).toHaveLength(2)
    expect(loads[1]!.params).toMatchObject({ dit_file: '/d.safetensors', text_encoder_file: '/t.safetensors', vae_file: '/v.safetensors' })
    expect(loads[1]!.params).not.toHaveProperty('model')
  })

  it('runs separate sidecars for separate GPUs', async () => {
    await Promise.all([run('a').done, run('b', { deviceUuid: 'GPU-b' }).done])
    expect(servers.map((s) => s.env['CUDA_VISIBLE_DEVICES']).sort()).toEqual(['GPU-a', 'GPU-b'])
  })

  it('fails a job on an incompatible protocol and still serves the next one after a fix', async () => {
    reply = (request, server) =>
      request.method === 'hello' ? server.send({ id: request.id, result: helloResult(undefined, 1) }) : happy(request, server)
    const s = run('a')
    expect(await s.done).toBe(1)
    expect(s.events.at(-1)).toMatchObject({ type: 'error', code: 'E_ENGINE', fatal: true, message: expect.stringContaining('protocol 1') })
  })

  it('refuses a GPU the engine marks unsupported with E_DEVICE', async () => {
    reply = (request, server) =>
      request.method === 'hello'
        ? server.send({
            id: request.id,
            result: helloResult([{ index: 0, name: 'GPU', supported: false, unsupported_reason: 'sm_75 needs the SM75 build' }]),
          })
        : happy(request, server)
    const s = run('a')
    expect(await s.done).toBe(1)
    expect(s.events.at(-1)).toMatchObject({ type: 'error', code: 'E_DEVICE', message: 'E_DEVICE: sm_75 needs the SM75 build' })
  })

  it('picks the first supported device for an automatic (-1) device', async () => {
    reply = (request, server) =>
      request.method === 'hello'
        ? server.send({
            id: request.id,
            result: helloResult([
              { index: 0, name: 'a', supported: false },
              { index: 1, name: 'b', supported: true },
            ]),
          })
        : happy(request, server)
    expect(await run('a', { device: -1 }).done).toBe(0)
    expect(servers[0]!.requests.find((r) => r.method === 'load')!.params['device']).toBe(1)
  })

  it('maps generation errors to runner codes', async () => {
    reply = (request, server) => {
      if (request.method !== 'generate') return happy(request, server)
      server.send({ event: 'done', id: request.id, status: 'error', error: { code: 'out_of_memory', message: 'OOM at 1024²' } })
    }
    const s = run('a')
    expect(await s.done).toBe(1)
    expect(s.events.at(-1)).toEqual({ type: 'error', code: 'E_OOM', message: 'OOM at 1024²', fatal: true })
  })

  it('explains a missing CUDA kernel image', async () => {
    reply = (request, server) => {
      if (request.method !== 'generate') return happy(request, server)
      server.send({ id: request.id, error: { code: 'internal', message: 'cudaErrorNoKernelImageForDevice' } })
    }
    const s = run('a')
    expect(await s.done).toBe(1)
    expect(String(s.events.at(-1)!['message'])).toMatch(/^E_DEVICE: .*SM75/)
  })

  it('reports a crash as E_ENGINE with the last stderr lines and respawns for the next job', async () => {
    reply = (request, server) => {
      if (request.method !== 'generate') return happy(request, server)
      server.stderr.write('CUDA error: illegal address\n')
      setImmediate(() => server.exit(134, null))
    }
    const s = run('a')
    expect(await s.done).toBe(-1)
    expect(s.stderr).toContain('CUDA error: illegal address')
    expect(s.events.at(-1)).toMatchObject({ type: 'error', code: 'E_ENGINE', message: expect.stringContaining('code 134') })
    reply = happy
    expect(await run('b').done).toBe(0)
    expect(servers).toHaveLength(2)
  })

  it('a startup crash includes buffered server output in the error', async () => {
    reply = (request, server) => {
      server.stderr.write('libcublasLt.so.13: cannot open shared object file\n')
      setImmediate(() => server.exit(127))
      void request
    }
    const s = run('a')
    expect(await s.done).toBe(1)
    expect(String(s.events.at(-1)!['message'])).toContain('libcublasLt.so.13')
  })

  it('fails immediately when no server binary exists', async () => {
    settings = { ...settings, mossInferServerPath: join(dataRoot(), 'missing') }
    const s = run('a')
    expect(await s.done).toBe(1)
    expect(s.events.at(-1)).toMatchObject({ type: 'error', message: '未找到 moss-server 可执行文件' })
    expect(servers).toHaveLength(0)
  })
})

describe('cancelMossInferJob', () => {
  it('cancels the active generation through the engine', async () => {
    reply = (request, server) => {
      if (request.method === 'generate') {
        server.send({ event: 'progress', id: request.id, phase: 'decode', step: 1, total_steps: 1 })
        return
      }
      if (request.method === 'cancel') {
        const active = server.requests.find((r) => r.method === 'generate')!
        server.send({ event: 'done', id: active.id, status: 'cancelled' })
        return
      }
      happy(request, server)
    }
    const s = run('a')
    await vi.waitFor(() => expect(s.events.some((e) => e['type'] === 'stage' && e['name'] === 'decode')).toBe(true))
    expect(mossInfer.cancelMossInferJob('a')).toBe(true)
    expect(await s.done).toBe(130)
    expect(s.events.at(-1)).toEqual({ type: 'canceled', at_stage: 'decode' })
    expect(servers[0]!.requests.at(-1)).toMatchObject({ method: 'cancel', params: { id: 'a' } })
  })

  it('removes a queued job without contacting the engine, and ignores unknown ids', async () => {
    const a = run('a')
    const b = run('b')
    expect(mossInfer.cancelMossInferJob('b')).toBe(true)
    expect(await b.done).toBe(130)
    expect(b.events.at(-1)).toEqual({ type: 'canceled', at_stage: 'idle' })
    expect(await a.done).toBe(0)
    expect(mossInfer.cancelMossInferJob('zzz')).toBe(false)
    expect(servers[0]!.methods().filter((m) => m === 'generate')).toHaveLength(1)
  })
})

describe('shutdownMossInfer', () => {
  it('asks each running sidecar to shut down and waits for it to exit', async () => {
    await run('a').done
    await mossInfer.shutdownMossInfer()
    expect(servers[0]!.methods().at(-1)).toBe('shutdown')
    expect(servers[0]!.closed).toBe(true)
    expect(servers[0]!.killed).toEqual([])
  })

  it('kills a sidecar that does not answer shutdown within 3 s', async () => {
    await run('a').done
    reply = () => undefined
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const pending = mossInfer.shutdownMossInfer()
      await vi.advanceTimersByTimeAsync(3000)
      await pending
    } finally {
      vi.useRealTimers()
    }
    expect(servers[0]!.killed).toEqual(['SIGKILL'])
  })

  it('is a no-op without running sidecars', async () => {
    await expect(mossInfer.shutdownMossInfer()).resolves.toBeUndefined()
    expect(existsSync(join(dataRoot(), 'cache'))).toBe(false)
  })
})

describe('image inputs, sampling and live previews', () => {
  const withInputs: JobParams = {
    ...params,
    initImage: { path: '/assets/init.png', strength: 0.6, resize: 'crop' },
    mask: { path: '/assets/mask.png' },
    references: { paths: ['/assets/ref.png'] },
    sampling: { sampler: 'heun', hires: { width: 768, height: 1152, strength: 0.3 } },
  }

  function runWith(id: string, jobParams: JobParams, patch: Record<string, unknown> = {}): Sink {
    const events: Array<Record<string, unknown>> = []
    let resolveDone: (code: number) => void = () => undefined
    const done = new Promise<number>((resolve) => {
      resolveDone = resolve
    })
    void mossInfer.runMossInferJob(
      { id } as JobRecord,
      jobParams,
      {
        model: join(dataRoot(), 'bundle'),
        device: 0,
        deviceUuid: 'GPU-a',
        systemDeviceIndex: 0,
        loras: [],
        output: join(dataRoot(), `${id}.png`),
        settings,
        ...patch,
      },
      { event: (payload) => events.push(payload), stderr: () => undefined, done: resolveDone },
    )
    return { events, stderr: [], done }
  }

  const previewing =
    (capabilities: Record<string, boolean>): Reply =>
    (request, server) => {
      if (request.method === 'hello') return server.send({ id: request.id, result: { ...helloResult(), capabilities } })
      if (request.method !== 'generate') return happy(request, server)
      const id = request.id
      const image = request.params['preview_output']
      server.send({ id, result: { accepted: true } })
      server.send({ event: 'progress', id, phase: 'denoise', step: 0, total_steps: 4 })
      if (image) {
        server.send({ event: 'preview', id, step: 1, total_steps: 4, image, width: 64, height: 64 })
        server.send({ event: 'preview', id: 'someone-else', step: 1, total_steps: 4, image: '/elsewhere.png' })
        server.send({ event: 'preview', id, step: 2, total_steps: 4, image, width: 64, height: 64 })
      }
      server.send({ event: 'done', id, status: 'ok', report: { seed_used: 9 } })
    }

  it('sends the inputs in the engine spelling and reports the hires size as the result size', async () => {
    const s = runWith('img', withInputs)
    expect(await s.done).toBe(0)
    const generate = servers[0]!.requests.find((r) => r.method === 'generate')!
    expect(generate.params).toMatchObject({
      init_image: '/assets/init.png',
      denoise_strength: 0.6,
      resize: 'crop',
      mask: '/assets/mask.png',
      mask_encoding: 'u8',
      references: { images: ['/assets/ref.png'] },
      sampler: 'heun',
      hires: { width: 768, height: 1152, strength: 0.3 },
    })
    expect(s.events.find((e) => e['type'] === 'result')).toMatchObject({ images: [{ width: 768, height: 1152, seed: 77 }] })
    const sidecar = JSON.parse(readFileSync(join(dataRoot(), 'img.json'), 'utf8')) as Record<string, unknown>
    expect(sidecar).toMatchObject({
      width: 768,
      height: 1152,
      init_image: '/assets/init.png',
      denoise_strength: 0.6,
      resize: 'crop',
      mask: '/assets/mask.png',
      references: { images: ['/assets/ref.png'] },
      sampler: 'heun',
      hires: { width: 768, height: 1152, strength: 0.3 },
    })
  })

  it('asks for a preview file when the engine can preview, and passes each write on', async () => {
    reply = previewing({ preview: true })
    const previewOutput = join(dataRoot(), 'cache', 'previews', 'pv.png')
    const s = runWith('pv', { ...params, steps: 30 }, { previewOutput })
    expect(await s.done).toBe(0)
    const generate = servers[0]!.requests.find((r) => r.method === 'generate')!
    expect(generate.params).toMatchObject({ preview_output: previewOutput, preview_every: 2 })
    expect(existsSync(join(dataRoot(), 'cache', 'previews'))).toBe(true)
    expect(s.events.filter((e) => e['type'] === 'preview')).toEqual([
      { type: 'preview', path: previewOutput, step: 1, total: 4 },
      { type: 'preview', path: previewOutput, step: 2, total: 4 },
    ])
  })

  it('does not ask for previews from an engine without the capability', async () => {
    reply = previewing({ preview: false })
    const s = runWith('np', params, { previewOutput: join(dataRoot(), 'cache', 'previews', 'np.png') })
    expect(await s.done).toBe(0)
    const generate = servers[0]!.requests.find((r) => r.method === 'generate')!
    expect(generate.params).not.toHaveProperty('preview_output')
    expect(generate.params).not.toHaveProperty('preview_every')
    expect(s.events.some((e) => e['type'] === 'preview')).toBe(false)
  })
})

describe('runningEngineHello / requestRunningEngine', () => {
  it('has nothing to offer before a sidecar runs', () => {
    expect(mossInfer.runningEngineHello()).toBeNull()
    expect(mossInfer.requestRunningEngine('inspect', { path: '/x' })).toBeNull()
  })

  it('answers from the running sidecar without starting another one', async () => {
    reply = (request, server) => {
      if (request.method === 'inspect')
        return server.send({ id: request.id, result: { kind: 'control_adapter', path: request.params['path'] } })
      happy(request, server)
    }
    await run('a').done
    expect(mossInfer.runningEngineHello('GPU-a')?.version).toBe('2.1.1')
    expect(mossInfer.runningEngineHello('GPU-other')?.version).toBe('2.1.1')
    await expect(mossInfer.requestRunningEngine('inspect', { path: '/m/c.safetensors' })).resolves.toEqual({
      kind: 'control_adapter',
      path: '/m/c.safetensors',
    })
    expect(servers).toHaveLength(1)
  })

  it('rejects with the engine error and never restarts the sidecar on a slow answer', async () => {
    reply = (request, server) => {
      if (request.method === 'inspect') return server.send({ id: request.id, error: { code: 'io', message: 'cannot open' } })
      if (request.method === 'status') return undefined
      happy(request, server)
    }
    await run('a').done
    await expect(mossInfer.requestRunningEngine('inspect', { path: '/missing' })).rejects.toThrow('io: cannot open')
    await expect(mossInfer.requestRunningEngine('status', {}, 20)).rejects.toThrow('请求超时')
    expect(servers[0]!.killed).toEqual([])
  })
})

describe('restarting a long batch', () => {
  it('stops the sidecar once the configured number of generations is reached', async () => {
    settings = { ...settings, mossInferRefreshEvery: 2 }
    expect(await run('job-1').done).toBe(0)
    expect(await run('job-2').done).toBe(0)
    expect(servers).toHaveLength(1)
    expect(await run('job-3').done).toBe(0)
    expect(servers).toHaveLength(2)
    expect(servers[0]!.methods()).toContain('shutdown')
    expect(servers[0]!.closed).toBe(true)
    expect(servers[1]!.methods()).toContain('load')
  })

  it('keeps one sidecar when the limit is off', async () => {
    settings = { ...settings, mossInferRefreshEvery: 0 }
    expect(await run('job-1').done).toBe(0)
    expect(await run('job-2').done).toBe(0)
    expect(await run('job-3').done).toBe(0)
    expect(servers).toHaveLength(1)
    expect(servers[0]!.methods()).not.toContain('shutdown')
  })
})

describe('a GPU that switches engines', () => {
  const cuda = (binaryPath: string) => ({ package: { kind: 'cuda', flavour: 'cu13', arch: 'standard', runtime: 'bundled' }, binaryPath })

  it('switched to Vulkan: its idle moss-server is shut down and its GPU memory freed; other GPUs keep theirs', async () => {
    expect(await run('job-a').done).toBe(0)
    expect(await run('job-b', { deviceUuid: 'GPU-b' }).done).toBe(0)
    const [a, b] = servers
    resolveDeviceEngine.mockImplementation((uuid: string) =>
      uuid === 'GPU-a' ? { package: { kind: 'vulkan' }, binaryPath: '/e/moss-infer-vulkan' } : null,
    )
    expect(await mossInfer.releaseStaleMossInferRuntimes()).toEqual(['GPU-a'])
    expect(a!.methods()).toContain('shutdown')
    expect(a!.closed).toBe(true)
    expect(b!.closed).toBe(false)
    expect(mossInfer.runningEngineHello('GPU-a')).not.toBeNull() // the hello left is GPU-b's
    expect(await mossInfer.releaseStaleMossInferRuntimes('GPU-a')).toEqual([])
  })

  it('never stops a server that is running a job; its next job is the one that switches', async () => {
    reply = (request, server) => {
      if (request.method === 'generate') return // never finishes
      happy(request, server)
    }
    const job = run('job-long')
    await vi.waitFor(() => expect(servers[0]!.methods()).toContain('generate'))
    resolveDeviceEngine.mockReturnValue({ package: { kind: 'vulkan' }, binaryPath: '/e/moss-infer-vulkan' })
    expect(await mossInfer.releaseStaleMossInferRuntimes('GPU-a')).toEqual([])
    expect(servers[0]!.closed).toBe(false)
    mossInfer.cancelMossInferJob('job-long')
    await mossInfer.restartMossInfer('GPU-a')
    await job.done
  })

  it('switched to another CUDA build: the next job restarts the server on the new binary', async () => {
    expect(await run('job-1').done).toBe(0)
    expect(spawnEngineServer.mock.calls[0]![0]).toBe(serverPath)
    const cu12 = join(dataRoot(), 'cu12', 'moss-server')
    mkdirSync(join(cu12, '..'), { recursive: true })
    writeFileSync(cu12, '#!')
    resolveDeviceEngine.mockReturnValue(cuda(cu12))
    expect(await run('job-2').done).toBe(0)
    expect(servers[0]!.closed).toBe(true)
    expect(spawnEngineServer.mock.calls[1]![0]).toBe(cu12)
    // Same binary again: the server and its loaded model are reused.
    expect(await run('job-3').done).toBe(0)
    expect(servers).toHaveLength(2)
    expect(servers[1]!.methods().filter((method) => method === 'load')).toHaveLength(1)
  })

  it('a server on the binary its GPU still runs is left alone', async () => {
    expect(await run('job-1').done).toBe(0)
    expect(await mossInfer.releaseStaleMossInferRuntimes()).toEqual([])
    resolveDeviceEngine.mockReturnValue(cuda(serverPath))
    expect(await mossInfer.releaseStaleMossInferRuntimes()).toEqual([])
    expect(servers[0]!.closed).toBe(false)
  })
})
