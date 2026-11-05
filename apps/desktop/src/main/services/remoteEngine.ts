import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import type { JobParams, RemoteCudaProbe, RemoteEngineInfo, TrainingHost } from '@shared/types'
import { decodeEngineHello, ENGINE_PROTOCOL_VERSION, protocolCompatible, type EngineHello } from '@shared/engineProtocol'
import { buildGenerateParams, jobInputFiles, outputSizeOf, rewriteJobInputPaths } from './generateParams'
import { LineSplitter } from './parsers'
import { posixQuote, remoteAbsolute, sshArgs, sshCommand, sshExec, sshEnv, sshWriteFile } from './ssh'
import { probeRemoteCuda } from './remoteCuda'

export interface RemoteEngineSink {
  event: (payload: Record<string, unknown>) => void
  stderr: (line: string) => void
  done: (code: number) => void
}

export interface RemoteEngineOptions {
  engineRoot?: string
  model: string
  output: string
  localOutput: string
  params: JobParams
  mode: 'min_memory' | 'balanced' | 'max_speed'
  tier: 'reference' | 'high' | 'turbo'
  device?: number
  /** Names the host folder the job's input pictures are uploaded to. */
  jobId?: string
}

function rootOf(host: TrainingHost): string {
  return host.engineRoot?.trim() || '~/.mossstudio/engine'
}

export type RemoteEngineStatus = RemoteEngineInfo

const CUDA_CACHE_MS = 60_000
const cudaCache = new Map<string, { at: number; gpu: string; cuda: RemoteCudaProbe }>()
const statusRequests = new Map<string, { promise: Promise<RemoteEngineStatus>; scansCuda: boolean }>()

export async function remoteEngineStatus(host: TrainingHost, refreshCuda = false): Promise<RemoteEngineStatus> {
  const key = JSON.stringify([host.id, host.host, host.port, host.user, rootOf(host)])
  const running = statusRequests.get(key)
  if (running) {
    if (!refreshCuda || running.scansCuda) return running.promise
    await running.promise
    if (statusRequests.get(key) === running) statusRequests.delete(key)
    return remoteEngineStatus(host, true)
  }
  const previous = cudaCache.get(key)
  const cached = !refreshCuda && previous && Date.now() - previous.at < CUDA_CACHE_MS ? previous : undefined
  const promise = (async (): Promise<RemoteEngineStatus> => {
    const status = await probeRemoteCuda(host, !cached)
    if (status.cuda) cudaCache.set(key, { at: Date.now(), gpu: status.gpu, cuda: status.cuda })
    else if (cached) { status.gpu = status.gpu || cached.gpu; status.cuda = cached.cuda }
    return status
  })()
  statusRequests.set(key, { promise, scansCuda: !cached })
  try { return await promise }
  finally { if (statusRequests.get(key)?.promise === promise) statusRequests.delete(key) }
}

function hostKey(host: TrainingHost): string {
  return JSON.stringify([host.id, host.host, host.port, host.user, rootOf(host)])
}

const HELLO_TTL_MS = 10 * 60_000
/** A failed probe is retried sooner: the host may just have come up. */
const HELLO_FAILURE_TTL_MS = 30_000
const helloCache = new Map<string, { at: number; hello: EngineHello | null }>()
const helloRequests = new Map<string, Promise<EngineHello | null>>()

/** Remember what a host's engine said in a job's hello (so features need no extra SSH round). */
export function rememberRemoteHello(host: TrainingHost, hello: EngineHello): void {
  helloCache.set(hostKey(host), { at: Date.now(), hello })
}

/**
 * The hello of the engine on an SSH host: the last one a job saw, or a one-off
 * `hello` over SSH (cached for ten minutes; a failure for 30 seconds, so a host
 * that is off does not cost an SSH timeout on every question). null = not usable.
 */
export async function remoteEngineHello(host: TrainingHost): Promise<EngineHello | null> {
  const key = hostKey(host)
  const cached = helloCache.get(key)
  if (cached && Date.now() - cached.at < (cached.hello ? HELLO_TTL_MS : HELLO_FAILURE_TTL_MS)) return cached.hello
  const running = helloRequests.get(key)
  if (running) return running
  const promise = (async (): Promise<EngineHello | null> => {
    try {
      const root = (await remoteAbsolute(host, rootOf(host))).replace(/\/$/, '')
      const lines = [
        { id: 'probe', method: 'hello', params: { client: 'MossStudio', protocol_version: ENGINE_PROTOCOL_VERSION } },
        { id: 'bye', method: 'shutdown', params: {} },
      ].map((line) => JSON.stringify(line)).join('\n')
      const result = await sshExec(host, `cd ${posixQuote(root)} && exec ./bin/moss-server`, 45_000, `${lines}\n`)
      for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue
        try {
          const message = JSON.parse(line) as Record<string, unknown>
          if (message['id'] === 'probe' && message['result']) return decodeEngineHello(message['result'])
        } catch {
          // not a protocol line
        }
      }
      return null
    } catch {
      return null
    }
  })()
  helloRequests.set(key, promise)
  try {
    const hello = await promise
    helloCache.set(key, { at: Date.now(), hello })
    return hello
  } finally {
    helloRequests.delete(key)
  }
}

/** Folder on the host a job's input pictures go to (removed when the job ends). */
export function remoteInputsDir(root: string, jobId: string): string {
  return `${root.replace(/\/$/, '')}/tmp/inputs-${jobId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/**
 * Uploads every input picture of `params` into `dir` on the host and returns
 * the params pointing at the uploaded copies. The same local file is sent once.
 * `stopped` is asked before each file: once the job has ended nothing more is sent.
 */
export async function uploadJobInputs(
  host: TrainingHost,
  params: JobParams,
  dir: string,
  stopped: () => boolean = () => false,
): Promise<JobParams> {
  const files = jobInputFiles(params)
  if (!files.length) return params
  const uploaded = new Map<string, string>()
  for (const file of files) {
    if (uploaded.has(file.path)) continue
    if (stopped()) throw new Error('任务已结束，停止上传输入图片')
    const ext = extname(file.path).toLowerCase() || '.png'
    const target = `${dir}/${uploaded.size + 1}-${file.role}${ext}`
    await sshWriteFile(host, target, await readFile(file.path))
    uploaded.set(file.path, target)
  }
  return rewriteJobInputPaths(params, (path) => uploaded.get(path) ?? path)
}

const PHASE_TO_STAGE: Record<string, string> = {
  text_encoder: 'text',
  dit_load: 'load',
  denoise: 'denoise',
  decode: 'decode',
}

function mapError(code: string): string {
  if (code === 'out_of_memory') return 'E_OOM'
  if (code === 'invalid_argument' || code === 'invalid_params') return 'E_INPUT'
  return `E_${code.toUpperCase()}`
}

/** How long a canceled remote generation may take to confirm before its SSH session is closed. */
export const REMOTE_CANCEL_TIMEOUT_MS = 5000

/** Running remote jobs by job id: how to stop each one through its own SSH session. */
const remoteJobs = new Map<string, { cancel: () => void }>()

/**
 * Cancels a remote job over its own session: the engine's `cancel` for a
 * running generation (the session is closed if it does not confirm within
 * REMOTE_CANCEL_TIMEOUT_MS), or the session itself before generating began.
 * Never touches a local engine. false = no such remote job.
 */
export function cancelRemoteEngineJob(jobId: string): boolean {
  const job = remoteJobs.get(jobId)
  if (!job) return false
  job.cancel()
  return true
}

/** One SSH process per remote job; stdio is the sidecar JSON-lines protocol. */
export async function runRemoteEngineJob(
  host: TrainingHost,
  opts: RemoteEngineOptions,
  sink: RemoteEngineSink,
): Promise<void> {
  // A cancel may come while the session is still being set up.
  let cancelBeforeStart = false
  const handle = { cancel: (): void => { cancelBeforeStart = true } }
  const jobKey = opts.jobId
  if (jobKey) remoteJobs.set(jobKey, handle)
  const forget = (): void => {
    if (jobKey && remoteJobs.get(jobKey) === handle) remoteJobs.delete(jobKey)
  }
  let root: string
  try {
    root = await remoteAbsolute(host, rootOf(host))
    await sshExec(host, `mkdir -p ${posixQuote(dirname(opts.output))}`, 20_000)
  } catch (error) {
    forget()
    throw error
  }
  if (cancelBeforeStart) {
    forget()
    sink.event({ type: 'canceled', at_stage: 'idle' })
    sink.done(130)
    return
  }
  const server = `${root.replace(/\/$/, '')}/bin/moss-server`
  const remoteOutput = opts.output

  const child = spawn(sshCommand(), sshArgs(host, `cd ${posixQuote(root)} && exec ${posixQuote(server)}`), {
    env: sshEnv(host),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const out = new LineSplitter()
  const err = new LineSplitter()
  const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  let seq = 0
  let finished = false
  let phase = ''
  /** The id of the generate request (what the engine's cancel names), once sent. */
  let generateId: string | null = null
  let cancelTimer: NodeJS.Timeout | null = null
  const inputsDir = jobInputFiles(opts.params).length ? remoteInputsDir(root, opts.jobId ?? randomUUID()) : null

  const removeInputs = (): void => {
    if (inputsDir) void sshExec(host, `rm -rf ${posixQuote(inputsDir)}`, 30_000).catch(() => undefined)
  }
  const finish = (code: number): void => {
    if (finished) return
    finished = true
    if (cancelTimer) clearTimeout(cancelTimer)
    forget()
    removeInputs()
    sink.done(code)
  }
  /** Ends the job as canceled, then closes the session (its close no longer reports anything). */
  const closeCanceled = (): void => {
    if (finished) return
    sink.event({ type: 'canceled', at_stage: PHASE_TO_STAGE[phase] ?? 'idle' })
    finish(130)
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  const send = (line: Record<string, unknown>): void => {
    if (!child.stdin.writable) throw new Error('远端 moss-server 未连接')
    child.stdin.write(`${JSON.stringify(line)}\n`)
  }
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = `remote-${++seq}`
      if (method === 'generate') generateId = id
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`远端 moss-server ${method} 超时`))
      }, 180_000)
      pending.set(id, { resolve, reject, timer })
      try {
        send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })

  const dispatch = (line: string): void => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      sink.stderr(line)
      return
    }
    const id = String(message['id'] ?? '')
    if (typeof message['event'] === 'string') {
      const event = message['event'] as string
      if (event === 'log') {
        sink.event({ type: 'log', level: message['level'] === 'warning' ? 'warn' : 'info', message: String(message['message'] ?? '') })
      } else if (event === 'plan') {
        sink.event({ type: 'log', level: 'info', message: String(message['explanation'] ?? '') })
      } else if (event === 'progress') {
        const nextPhase = String(message['phase'] ?? '')
        const stage = PHASE_TO_STAGE[nextPhase] ?? 'denoise'
        if (nextPhase !== phase) {
          phase = nextPhase
          sink.event({ type: 'stage', name: stage })
        }
        const step = Number(message['step'] ?? 0)
        const total = Number(message['total_steps'] ?? opts.params.steps)
        const stepSeconds = Number(message['step_seconds'] ?? 0)
        sink.event({
          type: 'progress', stage, current: step, total, percent: total ? Math.round((step / total) * 1000) / 10 : 0,
          eta_ms: stepSeconds > 0 ? Math.round((total - step) * stepSeconds * 1000) : undefined,
        })
      } else if (event === 'done') {
        const status = String(message['status'] ?? 'error')
        if (status === 'ok') {
          void (async () => {
            try {
              // base64 keeps the first remote implementation independent of scp banner/quoting.
              const b64 = await sshExec(host, `base64 < ${posixQuote(remoteOutput)}`, 120_000)
              if (b64.code !== 0) throw new Error(b64.stderr.trim() || '读取远端输出失败')
              await mkdir(dirname(opts.localOutput), { recursive: true })
              await writeFile(opts.localOutput, Buffer.from(b64.stdout.replace(/\s/g, ''), 'base64'))
              const size = outputSizeOf(opts.params)
              sink.event({ type: 'result', images: [{ path: opts.localOutput, width: size.width, height: size.height, seed: opts.params.seed }], timings: {} })
              finish(0)
            } catch (error) {
              sink.event({ type: 'error', code: 'E_REMOTE_OUTPUT', message: String(error instanceof Error ? error.message : error), fatal: true })
              finish(1)
            }
          })()
        } else if (status === 'cancelled') {
          sink.event({ type: 'canceled', at_stage: PHASE_TO_STAGE[phase] ?? 'denoise' })
          finish(130)
        } else {
          const error = (message['error'] ?? {}) as { code?: string; message?: string }
          sink.event({ type: 'error', code: mapError(String(error.code ?? 'internal')), message: String(error.message ?? '远端生成失败'), fatal: true })
          finish(1)
        }
      }
      return
    }
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    const error = message['error'] as { code?: string; message?: string } | undefined
    if (error) entry.reject(new Error(`${error.code ?? 'error'}: ${error.message ?? ''}`))
    else entry.resolve((message['result'] ?? {}) as Record<string, unknown>)
  }

  handle.cancel = (): void => {
    if (finished || cancelTimer) return
    if (!generateId) {
      // Nothing is generating yet (connecting, loading, uploading): the session goes.
      closeCanceled()
      return
    }
    try {
      send({ id: `remote-${++seq}`, method: 'cancel', params: { id: generateId } })
    } catch {
      closeCanceled()
      return
    }
    // The engine answers with done "cancelled"; one that does not is closed.
    cancelTimer = setTimeout(closeCanceled, REMOTE_CANCEL_TIMEOUT_MS)
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { for (const line of out.push(chunk)) if (line.trim()) dispatch(line.trimEnd()) })
  child.stderr.on('data', (chunk: string) => { for (const line of err.push(chunk)) if (line.trim()) sink.stderr(line.trimEnd()) })
  child.on('error', (error) => {
    sink.event({ type: 'error', code: 'E_REMOTE_SPAWN', message: String(error), fatal: true })
    finish(-1)
  })
  child.on('close', (code) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`远端 moss-server 退出 (${code ?? 'null'})`))
    }
    pending.clear()
    if (!finished) {
      sink.event({ type: 'error', code: 'E_REMOTE_EXIT', message: `远端 moss-server 退出 (${code ?? 'null'})`, fatal: true })
      finish(code ?? -1)
    }
  })

  try {
    const hello = decodeEngineHello(await request('hello', { client: 'MossStudio', protocol_version: 2, devices: true }))
    if (!protocolCompatible(hello)) throw new Error('远端 moss-server 协议不兼容，需要 protocol 2（MossInfer ≥ 2.0）')
    rememberRemoteHello(host, hello)
    sink.event({ type: 'hello', protocol: 1, runner_version: `mossinfer-remote-${hello.version ?? ''}` })
    await request('load', {
      model: opts.model,
      mode: opts.mode,
      device: opts.device ?? -1,
      tier: opts.tier,
      cache_dir: `${root.replace(/\/$/, '')}/cache`,
    })
    sink.event({ type: 'ready', device: opts.device === undefined ? 'cuda:auto' : `cuda:${opts.device}`, dtype: 'bf16', capabilities: ['progress', 'cancel'] })
    // A job that ended mid-upload (canceled, server gone) already removed the folder:
    // remove it again once the last write settled, and do not generate.
    const params = inputsDir
      ? await uploadJobInputs(host, opts.params, inputsDir, () => finished).finally(() => { if (finished) removeInputs() })
      : opts.params
    if (finished) return
    await request('generate', buildGenerateParams(params, { output: remoteOutput }))
  } catch (error) {
    if (finished) return
    sink.event({ type: 'error', code: 'E_REMOTE', message: String(error instanceof Error ? error.message : error), fatal: true })
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    finish(1)
  }
}
