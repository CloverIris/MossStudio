import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobParams, JobRecord, JobStage, Settings } from '@shared/types'
import { paths } from '../lib/paths'
import { LineSplitter } from './parsers'

/**
 * MossInfer sidecar client: one long-lived `moss-server` process shared by all
 * mossinfer jobs (JSON lines over stdio, protocol 2 / ABI 1). Generations are
 * serialized through an internal FIFO; the server is re-spawned on crash and
 * `load` is re-sent whenever the model/device/mode/tier config changes.
 * Events are translated into the runner NDJSON event shapes that
 * supervisor.handleRunnerEvent already understands.
 */

export interface MossInferSink {
  event(payload: Record<string, unknown>): void
  stderr(line: string): void
  done(exitCode: number): void
}

interface MossInferHelloDevice {
  index: number
  name: string
  supported: boolean
  free_memory_bytes?: number
}

interface MossInferHello {
  protocol_version: number
  abi_version: number
  version?: string
  probe?: { devices?: MossInferHelloDevice[] }
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface EngineConfig {
  model: string
  device: number
  mode: Settings['mossInferMemoryMode']
  tier: Settings['mossInferTier']
}

interface QueuedJob {
  job: JobRecord
  params: JobParams
  opts: {
    model: string
    device: number
    loras: Array<{ path: string; strength: number }>
    output: string
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

let child: ChildProcessWithoutNullStreams | null = null
let hello: MossInferHello | null = null
let loadedKey: string | null = null
let reqSeq = 0
const pending = new Map<string, PendingRequest>()
let active: ActiveGeneration | null = null
const queue: QueuedJob[] = []
const stderrRing: string[] = []
const outSplitter = new LineSplitter()
const errSplitter = new LineSplitter()

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

const PHASE_TO_STAGE: Record<string, JobStage> = {
  text_encoder: 'text',
  dit_load: 'load',
  denoise: 'denoise',
  decode: 'decode',
}

function send(line: Record<string, unknown>): void {
  if (!child?.stdin.writable) throw new Error('moss-server 未运行')
  child.stdin.write(`${JSON.stringify(line)}\n`)
}

function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requestWithId(`mi-${++reqSeq}`, method, params)
}

// The generate request id must be the job id itself so `cancel` matches it exactly.
function requestWithId(
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`moss-server ${method} 请求超时`))
      void restartMossInfer()
    }, 60_000)
    pending.set(id, {
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    })
    try {
      send({ id, method, params })
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      rejectPromise(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function dispatchLine(line: string): void {
  let message: Record<string, unknown>
  try {
    message = JSON.parse(line) as Record<string, unknown>
  } catch {
    if (active) active.sink.stderr(line)
    return
  }
  if (typeof message['event'] === 'string') {
    handleServerEvent(message)
    return
  }
  const id = message['id']
  if ((typeof id === 'string' || typeof id === 'number') && pending.has(String(id))) {
    const entry = pending.get(String(id))!
    pending.delete(String(id))
    clearTimeout(entry.timer)
    const error = message['error'] as { code?: string; message?: string } | undefined
    if (error) {
      entry.reject(new Error(`${error.code ?? 'error'}: ${error.message ?? ''}`.trim()))
    } else {
      entry.resolve((message['result'] ?? {}) as Record<string, unknown>)
    }
  }
}

function handleServerEvent(message: Record<string, unknown>): void {
  const event = message['event'] as string
  const id = message['id']
  // log events can belong to a request (load) or to the active generation
  if (event === 'log' && (!active || id !== active.genId)) {
    const text = String(message['message'] ?? '')
    if (active) active.sink.stderr(`[moss-server] ${text}`)
    else ringPush(`[moss-server] ${text}`)
    return
  }
  if (!active || id !== active.genId) return
  const sink = active.sink
  const { params } = active.queue
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
      if (phase !== active.phase) {
        active.phase = phase
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
    case 'preview':
      // no preview surface yet; preview_output is never requested
      return
    case 'done': {
      const current = active
      active = null
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
                width: params.width,
                height: params.height,
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
          void pump()
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
      void pump()
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
    await writeFile(
      target,
      JSON.stringify(
        {
          prompt: params.prompt,
          negative_prompt: params.negativePrompt,
          seed,
          width: params.width,
          height: params.height,
          engine: 'mossinfer',
          tier: quality?.tier ?? null,
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

function ringPush(line: string): void {
  stderrRing.push(line)
  if (stderrRing.length > 50) stderrRing.shift()
}

function handleExit(code: number | null, signal: string | null): void {
  const reason = `moss-server 异常退出 (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${
    stderrRing.length ? `，最后输出：${stderrRing.slice(-5).join(' | ')}` : ''
  }`
  child = null
  hello = null
  loadedKey = null
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
  pending.clear()
  if (active) {
    const sink = active.sink
    active = null
    sink.event({ type: 'error', code: 'E_ENGINE', message: reason, fatal: true })
    sink.done(-1)
  }
  if (queue.length) void pump()
}

function spawnServer(settings: Settings): void {
  const serverPath = resolveServerPath(settings)
  if (!serverPath) throw new Error('未找到 moss-server 可执行文件')
  stderrRing.length = 0
  const proc = spawn(serverPath, ['--parent-pid', String(process.pid)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child = proc
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    for (const line of outSplitter.push(chunk)) {
      if (line.trim()) dispatchLine(line.trimEnd())
    }
  })
  proc.stderr.on('data', (chunk: string) => {
    for (const line of errSplitter.push(chunk)) {
      const trimmed = line.trimEnd()
      if (!trimmed) continue
      if (active) active.sink.stderr(trimmed)
      else ringPush(trimmed)
    }
  })
  proc.on('error', (error) => {
    ringPush(String(error))
    handleExit(-1, null)
  })
  proc.on('close', (code, signal) => handleExit(code, signal))
}

async function ensureEngine(config: EngineConfig, settings: Settings): Promise<number> {
  if (!child) {
    spawnServer(settings)
    const result = (await request('hello', {
      client: 'MossStudio',
      protocol_version: 2,
      devices: true,
    })) as unknown as MossInferHello
    if (result.protocol_version !== 2) {
      throw new Error(`E_ENGINE: moss-server 协议不兼容 (protocol ${String(result.protocol_version)})，需要 protocol 2（MossInfer ≥ 2.0）`)
    }
    hello = result
  }
  let device = config.device
  if (device < 0) {
    const first = hello?.probe?.devices?.find((item) => item.supported)
    if (!first) {
      throw new Error('E_DEVICE: MossInfer 需要计算能力 ≥ 8.0 的 NVIDIA GPU（CUDA）')
    }
    device = first.index
  }
  const key = JSON.stringify({ model: config.model, device, mode: config.mode, tier: config.tier })
  if (key !== loadedKey) {
    await request('load', {
      model: config.model,
      mode: config.mode,
      device,
      tier: config.tier,
      cache_dir: join(paths.cache(), 'mossinfer'),
    })
    loadedKey = key
  }
  return device
}

async function pump(): Promise<void> {
  if (active || !queue.length) return
  const next = queue.shift()!
  const { job, params, opts, sink } = next
  try {
    const device = await ensureEngine(
      { model: opts.model, device: opts.device, mode: opts.settings.mossInferMemoryMode, tier: opts.settings.mossInferTier },
      opts.settings,
    )
    sink.event({ type: 'hello', protocol: 1, runner_version: `mossinfer-${hello?.version ?? '2.0.0'}` })
    sink.event({
      type: 'ready',
      device: `cuda:${device}`,
      dtype: 'bf16',
      capabilities: ['progress', 'cancel'],
    })
    const genId = job.id
    active = { jobId: job.id, genId, sink, phase: '', queue: next }
    try {
      const generateParams: Record<string, unknown> = {
        output: opts.output,
        prompt: params.prompt,
        negative_prompt: params.negativePrompt,
        width: params.width,
        height: params.height,
        steps: params.steps,
        cfg: params.cfg,
        seed: params.seed,
        save_metadata: true,
        include_prompts: true,
      }
      if (opts.loras.length) generateParams['loras'] = opts.loras
      await requestWithId(genId, 'generate', generateParams)
    } catch (error) {
      active = null
      sink.event({
        type: 'error',
        code: 'E_ENGINE',
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      })
      sink.done(1)
      void pump()
    }
  } catch (error) {
    sink.event({
      type: 'error',
      code: 'E_ENGINE',
      message: error instanceof Error ? error.message : String(error),
      fatal: true,
    })
    sink.done(1)
    void pump()
  }
}

// The generate request id must be the job id itself so `cancel` matches it exactly.

export async function runMossInferJob(
  job: JobRecord,
  params: JobParams,
  opts: {
    model: string
    device: number
    loras: Array<{ path: string; strength: number }>
    output: string
    settings: Settings
  },
  sink: MossInferSink,
): Promise<void> {
  if (active || queue.length) {
    sink.event({
      type: 'log',
      level: 'info',
      message: 'MossInfer 引擎忙，排队等待上一个任务完成',
    })
  }
  queue.push({ job, params, opts, sink })
  void pump()
}

export function cancelMossInferJob(jobId: string): boolean {
  if (active && active.jobId === jobId) {
    try {
      send({ id: `mi-${++reqSeq}`, method: 'cancel', params: { id: active.genId } })
    } catch {
      // server already gone; exit handler fails the job
    }
    return true
  }
  const index = queue.findIndex((item) => item.job.id === jobId)
  if (index >= 0) {
    const [removed] = queue.splice(index, 1)
    removed.sink.event({ type: 'canceled', at_stage: 'idle' })
    removed.sink.done(130)
    return true
  }
  return false
}

export async function restartMossInfer(): Promise<void> {
  if (!child) return
  const proc = child
  try {
    proc.kill('SIGKILL')
  } catch {
    // already gone
  }
}

export async function shutdownMossInfer(): Promise<void> {
  if (!child) return
  const proc = child
  try {
    const response = request('shutdown', {})
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
}

/**
 * One-shot probe of an arbitrary moss-server binary (post-install validation,
 * flavour recommendation, settings "test" button). Independent of the managed
 * singleton above: spawns, says hello with devices, shuts down.
 */
export async function probeMossInfer(
  serverPath: string,
  extraEnv?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const proc = spawn(serverPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  })
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const splitter = new LineSplitter()
      const timer = setTimeout(() => rejectPromise(new Error('moss-server hello 超时')), 30_000)
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        for (const line of splitter.push(chunk)) {
          if (!line.trim()) continue
          let message: Record<string, unknown>
          try {
            message = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (message['id'] === 'probe') {
            clearTimeout(timer)
            const error = message['error'] as { message?: string } | undefined
            if (error) rejectPromise(new Error(error.message ?? 'hello 失败'))
            else resolvePromise((message['result'] ?? {}) as Record<string, unknown>)
          }
        }
      })
      proc.on('error', (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        rejectPromise(new Error(`moss-server 退出 (code ${code ?? 'null'})，未完成 hello`))
      })
      proc.stdin.write(`${JSON.stringify({ id: 'probe', method: 'hello', params: { client: 'MossStudio', protocol_version: 2, devices: true } })}\n`)
    })
  } finally {
    try {
      proc.stdin.write(`${JSON.stringify({ id: 'bye', method: 'shutdown' })}\n`)
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, 2000).unref()
  }
}
