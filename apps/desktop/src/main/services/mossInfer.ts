import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { JobParams, JobRecord, JobStage, Settings } from '@shared/types'
import {
  decodeEngineHello,
  judgeEngineSupport,
  protocolCompatible,
  type EngineDevice,
  type EngineHello,
} from '@shared/engineProtocol'
import { paths } from '../lib/paths'
import { spawnEngineServer } from '../lib/probeEngine'
import { jobInputsSidecar } from './galleryMeta'
import { buildGenerateParams, outputSizeOf, previewEveryFor } from './generateParams'
import { LineSplitter } from './parsers'

/**
 * MossInfer sidecar clients: one long-lived `moss-server` process per GPU UUID.
 * Each device has an independent FIFO; the server is re-spawned on crash and
 * `load` is re-sent whenever the model/device/mode/tier config changes.
 * Events are translated into the runner NDJSON event shapes that
 * supervisor.handleRunnerEvent already understands.
 */

export interface MossInferSink {
  event(payload: Record<string, unknown>): void
  stderr(line: string): void
  done(exitCode: number): void
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface EngineConfig {
  /** Materialized diffusers folder; empty when loading component files. */
  model: string
  /** Local single-file components (a user's ComfyUI tree, registered in place). */
  ditFile?: string
  textEncoderFile?: string
  vaeFile?: string
  device: number
  deviceUuid: string
  mode: Settings['mossInferMemoryMode']
  tier: Settings['mossInferTier']
}

interface QueuedJob {
  job: JobRecord
  params: JobParams
  opts: {
    model: string
    ditFile?: string
    textEncoderFile?: string
    vaeFile?: string
    device: number
    deviceUuid: string
    systemDeviceIndex: number
    loras: Array<{ path: string; strength: number }>
    output: string
    /** Where the engine may write the live preview PNG (used when it supports previews). */
    previewOutput?: string
    settings: Settings
  }
  sink: MossInferSink
}

interface ActiveGeneration {
  jobId: string
  genId: string
  sink: MossInferSink
  phase: string
  queue: QueuedJob
}

interface MossInferRuntime {
  deviceUuid: string
  child: ChildProcessWithoutNullStreams | null
  boundDeviceUuid: string | null
  hello: EngineHello | null
  loadedKey: string | null
  reqSeq: number
  pending: Map<string, PendingRequest>
  active: ActiveGeneration | null
  busy: boolean
  queue: QueuedJob[]
  stderrRing: string[]
  outSplitter: LineSplitter
  errSplitter: LineSplitter
}

const runtimes = new Map<string, MossInferRuntime>()

function runtimeFor(deviceUuid: string): MossInferRuntime {
  let runtime = runtimes.get(deviceUuid)
  if (!runtime) {
    runtime = {
      deviceUuid,
      child: null,
      boundDeviceUuid: null,
      hello: null,
      loadedKey: null,
      reqSeq: 0,
      pending: new Map(),
      active: null,
      busy: false,
      queue: [],
      stderrRing: [],
      outSplitter: new LineSplitter(),
      errSplitter: new LineSplitter(),
    }
    runtimes.set(deviceUuid, runtime)
  }
  return runtime
}

export function resolveServerPath(settings: Settings): string | null {
  const candidates: Array<string | null | undefined> = [
    settings.mossInferServerPath,
    process.env.MOSS_SERVER,
    join(
      process.resourcesPath,
      'mossinfer',
      'bin',
      process.platform === 'win32' ? 'moss-server.exe' : 'moss-server',
    ),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  try {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['moss-server'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const first = (probe.stdout ?? '').split(/\r?\n/)[0]?.trim()
    if (probe.status === 0 && first && existsSync(first)) return first
  } catch {
    // PATH lookup is best effort
  }
  return null
}

function mapErr(code: string): string {
  if (code === 'out_of_memory') return 'E_OOM'
  if (code === 'invalid_argument' || code === 'invalid_params') return 'E_INPUT'
  if (code === 'not_supported') return 'E_NOT_SUPPORTED'
  return `E_${code.toUpperCase()}`
}

function engineFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/cudaErrorNoKernelImageForDevice|no kernel image is available/i.test(message)) {
    return `E_DEVICE: 当前引擎构建没有适配此 GPU 的 CUDA kernel image。RTX 20/Turing 请在引擎页选择 SM75 架构包或兼容的本地引擎；更换性能档不能绕过硬件兼容限制。原始错误：${message}`
  }
  return message
}

const PHASE_TO_STAGE: Record<string, JobStage> = {
  text_encoder: 'text',
  dit_load: 'load',
  denoise: 'denoise',
  decode: 'decode',
}

function send(runtime: MossInferRuntime, line: Record<string, unknown>): void {
  if (!runtime.child?.stdin.writable) throw new Error('moss-server 未运行')
  runtime.child.stdin.write(`${JSON.stringify(line)}\n`)
}

function request(runtime: MossInferRuntime, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requestWithId(runtime, `mi-${++runtime.reqSeq}`, method, params)
}

// The generate request id must be the job id itself so `cancel` matches it exactly.
function requestWithId(
  runtime: MossInferRuntime,
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      runtime.pending.delete(id)
      rejectPromise(new Error(`moss-server ${method} 请求超时`))
      void restartMossInfer(runtime.deviceUuid)
    }, 60_000)
    runtime.pending.set(id, {
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    })
    try {
      send(runtime, { id, method, params })
    } catch (error) {
      clearTimeout(timer)
      runtime.pending.delete(id)
      rejectPromise(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function dispatchLine(runtime: MossInferRuntime, line: string): void {
  let message: Record<string, unknown>
  try {
    message = JSON.parse(line) as Record<string, unknown>
  } catch {
    if (runtime.active) runtime.active.sink.stderr(line)
    return
  }
  if (typeof message['event'] === 'string') {
    handleServerEvent(runtime, message)
    return
  }
  const id = message['id']
  if ((typeof id === 'string' || typeof id === 'number') && runtime.pending.has(String(id))) {
    const entry = runtime.pending.get(String(id))!
    runtime.pending.delete(String(id))
    clearTimeout(entry.timer)
    const error = message['error'] as { code?: string; message?: string } | undefined
    if (error) {
      entry.reject(new Error(`${error.code ?? 'error'}: ${error.message ?? ''}`.trim()))
    } else {
      entry.resolve((message['result'] ?? {}) as Record<string, unknown>)
    }
  }
}

function handleServerEvent(runtime: MossInferRuntime, message: Record<string, unknown>): void {
  const event = message['event'] as string
  const id = message['id']
  // log events can belong to a request (load) or to the active generation
  if (event === 'log' && (!runtime.active || id !== runtime.active.genId)) {
    const text = String(message['message'] ?? '')
    if (runtime.active) runtime.active.sink.stderr(`[moss-server] ${text}`)
    else ringPush(runtime, `[moss-server] ${text}`)
    return
  }
  if (!runtime.active || id !== runtime.active.genId) return
  const sink = runtime.active.sink
  const { params } = runtime.active.queue
  switch (event) {
    case 'log': {
      sink.event({
        type: 'log',
        level: message['level'] === 'warning' ? 'warn' : 'info',
        message: String(message['message'] ?? ''),
      })
      return
    }
    case 'plan': {
      sink.event({ type: 'log', level: 'info', message: String(message['explanation'] ?? '') })
      return
    }
    case 'progress': {
      const phase = String(message['phase'] ?? '')
      const stage = PHASE_TO_STAGE[phase] ?? 'denoise'
      if (phase !== runtime.active.phase) {
        runtime.active.phase = phase
        sink.event({ type: 'stage', name: stage })
      }
      const step = Number(message['step'] ?? 0)
      const totalSteps = Number(message['total_steps'] ?? 0)
      const stepSeconds = Number(message['step_seconds'] ?? 0)
      sink.event({
        type: 'progress',
        stage,
        current: step,
        total: totalSteps,
        percent: totalSteps ? Math.round((step / totalSteps) * 1000) / 10 : 0,
        eta_ms: stepSeconds > 0 ? Math.round((totalSteps - step) * stepSeconds * 1000) : undefined,
      })
      return
    }
    case 'preview': {
      // The engine has just rewritten the preview PNG (main.cpp on_preview).
      const image = typeof message['image'] === 'string' ? (message['image'] as string) : runtime.active.queue.opts.previewOutput
      if (!image) return
      sink.event({
        type: 'preview',
        path: image,
        step: Number(message['step'] ?? 0),
        total: Number(message['total_steps'] ?? params.steps),
      })
      return
    }
    case 'done': {
      const current = runtime.active
      runtime.active = null
      const status = String(message['status'] ?? 'error')
      const warnings = Array.isArray(message['warnings']) ? (message['warnings'] as unknown[]) : []
      for (const warning of warnings) {
        sink.event({ type: 'log', level: 'warn', message: String(warning) })
      }
      const report = (message['report'] ?? null) as Record<string, unknown> | null
      if (status === 'ok') {
        void (async () => {
          await writeSidecar(current.queue, report)
          sink.event({ type: 'stage', name: 'save' })
          const size = outputSizeOf(params)
          const timings = ((report?.['timings_s'] ?? {}) ?? {}) as Record<string, unknown>
          const ms = (key: string, fallback?: string): number => {
            const value = timings[key] ?? (fallback ? timings[fallback] : undefined)
            return typeof value === 'number' ? Math.round(value * 1000) : 0
          }
          sink.event({
            type: 'result',
            images: [
              {
                path: current.queue.opts.output,
                width: size.width,
                height: size.height,
                seed:
                  typeof report?.['seed_used'] === 'number'
                    ? (report['seed_used'] as number)
                    : params.seed,
              },
            ],
            timings: {
              load_ms: ms('dit_load'),
              text_encode_ms: ms('text_encode', 'encode'),
              denoise_ms: ms('denoise'),
              decode_ms: ms('decode'),
              total_ms: ms('total'),
            },
          })
          sink.done(0)
          runtime.busy = false
          void pump(runtime)
        })()
        return
      }
      if (status === 'cancelled') {
        sink.event({ type: 'canceled', at_stage: PHASE_TO_STAGE[current.phase] ?? 'denoise' })
        sink.done(130)
      } else {
        const error = (message['error'] ?? {}) as { code?: string; message?: string }
        sink.event({
          type: 'error',
          code: mapErr(String(error.code ?? 'internal')),
          message: String(error.message ?? '生成失败'),
          fatal: true,
        })
        sink.done(1)
      }
      runtime.busy = false
      void pump(runtime)
      return
    }
    default:
      return
  }
}

async function writeSidecar(
  queued: QueuedJob,
  report: Record<string, unknown> | null,
): Promise<void> {
  try {
    const { params, opts } = queued
    const quality = (report?.['quality'] ?? null) as { tier?: string } | null
    const seed =
      typeof report?.['seed_used'] === 'number' ? (report['seed_used'] as number) : params.seed
    const target = opts.output.replace(/\.png$/i, '.json')
    const size = outputSizeOf(params)
    await writeFile(
      target,
      JSON.stringify(
        {
          prompt: params.prompt,
          negative_prompt: params.negativePrompt,
          seed,
          width: size.width,
          height: size.height,
          engine: 'mossinfer',
          tier: quality?.tier ?? null,
          ...jobInputsSidecar(params),
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    // sidecar is best effort; the PNG already carries generation metadata
  }
}

function ringPush(runtime: MossInferRuntime, line: string): void {
  runtime.stderrRing.push(line)
  if (runtime.stderrRing.length > 50) runtime.stderrRing.shift()
}

function handleExit(
  runtime: MossInferRuntime,
  proc: ChildProcessWithoutNullStreams,
  code: number | null,
  signal: string | null,
): void {
  if (runtime.child !== proc) return
  const reason = `moss-server 异常退出 (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${
    runtime.stderrRing.length ? `，最后输出：${runtime.stderrRing.slice(-5).join(' | ')}` : ''
  }`
  runtime.child = null
  runtime.boundDeviceUuid = null
  runtime.hello = null
  runtime.loadedKey = null
  for (const [, entry] of runtime.pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
  runtime.pending.clear()
  if (runtime.active) {
    const sink = runtime.active.sink
    runtime.active = null
    runtime.busy = false
    sink.event({ type: 'error', code: 'E_ENGINE', message: reason, fatal: true })
    sink.done(-1)
  }
  if (runtime.queue.length) void pump(runtime)
}

function spawnServer(runtime: MossInferRuntime, settings: Settings, deviceUuid: string): void {
  const serverPath = resolveServerPath(settings)
  if (!serverPath) throw new Error('未找到 moss-server 可执行文件')
  runtime.stderrRing.length = 0
  const proc = spawnEngineServer(serverPath, ['--parent-pid', String(process.pid)], {
    CUDA_VISIBLE_DEVICES: deviceUuid,
  })
  runtime.child = proc
  runtime.boundDeviceUuid = deviceUuid
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    for (const line of runtime.outSplitter.push(chunk)) {
      if (line.trim()) dispatchLine(runtime, line.trimEnd())
    }
  })
  proc.stderr.on('data', (chunk: string) => {
    for (const line of runtime.errSplitter.push(chunk)) {
      const trimmed = line.trimEnd()
      if (!trimmed) continue
      if (runtime.active) runtime.active.sink.stderr(trimmed)
      else ringPush(runtime, trimmed)
    }
  })
  proc.on('error', (error) => {
    if (runtime.child !== proc) return
    ringPush(runtime, String(error))
    handleExit(runtime, proc, -1, null)
  })
  proc.on('close', (code, signal) => handleExit(runtime, proc, code, signal))
}

async function ensureEngine(runtime: MossInferRuntime, config: EngineConfig, settings: Settings): Promise<number> {
  if (runtime.child && runtime.boundDeviceUuid !== config.deviceUuid) {
    const previous = runtime.child
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error('等待旧 GPU MossInfer runtime 退出超时；为避免两张卡被错误绑定，未启动新 runtime'))
      }, 5000)
      previous.once('close', () => {
        clearTimeout(timer)
        resolvePromise()
      })
      try {
        previous.kill('SIGKILL')
      } catch (error) {
        clearTimeout(timer)
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  if (!runtime.child) {
    spawnServer(runtime, settings, config.deviceUuid)
    const hello = decodeEngineHello(await request(runtime, 'hello', {
      client: 'MossStudio',
      protocol_version: 2,
      devices: true,
    }))
    if (!protocolCompatible(hello)) {
      throw new Error(`E_ENGINE: moss-server 协议不兼容 (protocol ${hello.protocol})，需要 protocol 2（MossInfer ≥ 2.0）`)
    }
    runtime.hello = hello
  }
  const devices = runtime.hello?.probe?.devices ?? []
  let selected: EngineDevice | undefined
  if (config.device < 0) {
    selected = devices.find((item) => item.supported === true)
    if (!selected) {
      throw new Error('E_DEVICE: 未检测到当前 MossInfer 构建支持的 NVIDIA GPU；请下载兼容该 GPU 的引擎构建。')
    }
  } else {
    // spawnServer 已设置 CUDA_VISIBLE_DEVICES，目标卡在 hello 中被重映射为序号 0，不能再按系统序号或名称匹配。
    const verdict = judgeEngineSupport(
      runtime.hello!,
      { index: config.device },
      { indexOnly: true },
    )
    if (!verdict.ok) throw new Error(`E_DEVICE: ${verdict.reason ?? 'MossInfer 未给出设备兼容性结论'}`)
    selected = verdict.device
  }
  if (!selected || selected.index === null) {
    throw new Error(`E_DEVICE: MossInfer 未检测到 CUDA 设备 ${config.device}`)
  }
  const device = selected.index
  const key = JSON.stringify({
    model: config.model,
    dit: config.ditFile,
    te: config.textEncoderFile,
    vae: config.vaeFile,
    deviceUuid: config.deviceUuid,
    device,
    mode: config.mode,
    tier: config.tier,
  })
  if (key !== runtime.loadedKey) {
    const payload: Record<string, unknown> = {
      mode: config.mode,
      device,
      tier: config.tier,
      cache_dir: join(paths.cache(), 'mossinfer'),
    }
    // A diffusers folder goes as `model`; scanned single files go as component
    // files. The engine refuses a request that mixes both.
    if (config.model) payload.model = config.model
    if (config.ditFile) payload.dit_file = config.ditFile
    if (config.textEncoderFile) payload.text_encoder_file = config.textEncoderFile
    if (config.vaeFile) payload.vae_file = config.vaeFile
    await request(runtime, 'load', payload)
    runtime.loadedKey = key
  }
  return device
}

async function pump(runtime: MossInferRuntime): Promise<void> {
  if (runtime.busy || runtime.active || !runtime.queue.length) return
  runtime.busy = true
  const next = runtime.queue.shift()!
  const { job, params, opts, sink } = next
  try {
    await ensureEngine(runtime,
      {
        model: opts.model,
        ditFile: opts.ditFile,
        textEncoderFile: opts.textEncoderFile,
        vaeFile: opts.vaeFile,
        device: opts.device,
        deviceUuid: opts.deviceUuid,
        mode: opts.settings.mossInferMemoryMode,
        tier: opts.settings.mossInferTier,
      },
      opts.settings,
    )
    sink.event({ type: 'hello', protocol: 1, runner_version: `mossinfer-${runtime.hello?.version ?? '2.0.0'}` })
    sink.event({
      type: 'ready',
      device: `cuda:${opts.systemDeviceIndex}`,
      dtype: 'bf16',
      capabilities: ['progress', 'cancel'],
    })
    const genId = job.id
    runtime.active = { jobId: job.id, genId, sink, phase: '', queue: next }
    try {
      const preview = Boolean(opts.previewOutput) && runtime.hello?.capabilities['preview'] === true
      if (preview) await mkdir(dirname(opts.previewOutput!), { recursive: true })
      const generateParams = buildGenerateParams(params, {
        output: opts.output,
        loras: opts.loras,
        ...(preview ? { previewOutput: opts.previewOutput, previewEvery: previewEveryFor(params.steps) } : {}),
      })
      await requestWithId(runtime, genId, 'generate', generateParams)
    } catch (error) {
      runtime.busy = false
      if (runtime.active?.jobId === job.id) {
        runtime.active = null
        const message = engineFailureMessage(error)
        sink.event({
          type: 'error',
          code: message.startsWith('E_DEVICE:') ? 'E_DEVICE' : 'E_ENGINE',
          message,
          fatal: true,
        })
        sink.done(1)
      }
      void pump(runtime)
    }
  } catch (error) {
    const message = engineFailureMessage(error)
    sink.event({
      type: 'error',
      code: message.startsWith('E_DEVICE:') ? 'E_DEVICE' : 'E_ENGINE',
      message,
      fatal: true,
    })
    sink.done(1)
    runtime.busy = false
    void pump(runtime)
  }
}

// The generate request id must be the job id itself so `cancel` matches it exactly.

export async function runMossInferJob(
  job: JobRecord,
  params: JobParams,
  opts: {
    model: string
    ditFile?: string
    textEncoderFile?: string
    vaeFile?: string
    device: number
    deviceUuid: string
    systemDeviceIndex: number
    loras: Array<{ path: string; strength: number }>
    output: string
    previewOutput?: string
    settings: Settings
  },
  sink: MossInferSink,
): Promise<void> {
  const runtime = runtimeFor(opts.deviceUuid)
  if (runtime.active || runtime.queue.length) {
    sink.event({
      type: 'log',
      level: 'info',
      message: 'MossInfer 引擎忙，排队等待上一个任务完成',
    })
  }
  runtime.queue.push({ job, params, opts, sink })
  void pump(runtime)
}

/**
 * The hello of a moss-server this app is already running (the one bound to
 * `deviceUuid` first), so a question about the engine never starts another one.
 */
export function runningEngineHello(deviceUuid?: string): EngineHello | null {
  const preferred = deviceUuid ? runtimes.get(deviceUuid) : undefined
  if (preferred?.child && preferred.hello) return preferred.hello
  for (const runtime of runtimes.values()) {
    if (runtime.child && runtime.hello) return runtime.hello
  }
  return null
}

/**
 * Sends a request that needs no loaded model (inspect) to a running
 * moss-server, or resolves null when none runs. Unlike a generate, a slow
 * answer never restarts the engine: a job may be running on it.
 */
export function requestRunningEngine(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> | null {
  const runtime = [...runtimes.values()].find((item) => item.child?.stdin.writable && item.hello)
  if (!runtime) return null
  const id = `mi-${++runtime.reqSeq}`
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      runtime.pending.delete(id)
      rejectPromise(new Error(`moss-server ${method} 请求超时`))
    }, timeoutMs)
    runtime.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
    try {
      send(runtime, { id, method, params })
    } catch (error) {
      clearTimeout(timer)
      runtime.pending.delete(id)
      rejectPromise(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export function cancelMossInferJob(jobId: string): boolean {
  for (const runtime of runtimes.values()) {
    if (runtime.active?.jobId === jobId) {
      try {
        send(runtime, { id: `mi-${++runtime.reqSeq}`, method: 'cancel', params: { id: runtime.active.genId } })
      } catch {
        // server already gone; exit handler fails the job
      }
      return true
    }
    const index = runtime.queue.findIndex((item) => item.job.id === jobId)
    if (index >= 0) {
      const [removed] = runtime.queue.splice(index, 1)
      removed.sink.event({ type: 'canceled', at_stage: 'idle' })
      removed.sink.done(130)
      return true
    }
  }
  return false
}

export async function restartMossInfer(deviceUuid?: string): Promise<void> {
  const targets = deviceUuid
    ? [runtimes.get(deviceUuid)].filter((runtime): runtime is MossInferRuntime => Boolean(runtime))
    : [...runtimes.values()]
  for (const runtime of targets) {
    if (!runtime.child) continue
    try {
      runtime.child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

export async function shutdownMossInfer(): Promise<void> {
  await Promise.all([...runtimes.values()].map(async (runtime) => {
    if (!runtime.child) return
    const proc = runtime.child
    try {
      const response = request(runtime, 'shutdown', {})
      const exited = await Promise.race([
        response.then(() => new Promise<void>((resolve) => proc.once('close', () => resolve()))),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ])
      if (exited === null) proc.kill('SIGKILL')
    } catch {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
  }))
}
