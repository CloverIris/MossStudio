import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JobParams, RemoteCudaProbe, RemoteEngineInfo, TrainingHost } from '@shared/types'
import { LineSplitter } from './parsers'
import { posixQuote, remoteAbsolute, sshArgs, sshCommand, sshExec, sshEnv } from './ssh'
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

/** One SSH process per remote job; stdio is the sidecar JSON-lines protocol. */
export async function runRemoteEngineJob(
  host: TrainingHost,
  opts: RemoteEngineOptions,
  sink: RemoteEngineSink,
): Promise<void> {
  const root = await remoteAbsolute(host, rootOf(host))
  const server = `${root.replace(/\/$/, '')}/bin/moss-server`
  const remoteOutput = opts.output
  await sshExec(host, `mkdir -p ${posixQuote(dirname(remoteOutput))}`, 20_000)

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

  const finish = (code: number): void => {
    if (finished) return
    finished = true
    sink.done(code)
  }
  const send = (line: Record<string, unknown>): void => {
    if (!child.stdin.writable) throw new Error('远端 moss-server 未连接')
    child.stdin.write(`${JSON.stringify(line)}\n`)
  }
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = `remote-${++seq}`
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
              sink.event({ type: 'result', images: [{ path: opts.localOutput, width: opts.params.width, height: opts.params.height, seed: opts.params.seed }], timings: {} })
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
    const hello = await request('hello', { client: 'MossStudio', protocol_version: 2, devices: true })
    if (Number(hello['protocol_version']) !== 2) throw new Error('远端 moss-server 协议不兼容，需要 protocol 2（MossInfer ≥ 2.0）')
    sink.event({ type: 'hello', protocol: 1, runner_version: `mossinfer-remote-${String(hello['version'] ?? '')}` })
    await request('load', {
      model: opts.model,
      mode: opts.mode,
      device: opts.device ?? -1,
      tier: opts.tier,
      cache_dir: `${root.replace(/\/$/, '')}/cache`,
    })
    sink.event({ type: 'ready', device: opts.device === undefined ? 'cuda:auto' : `cuda:${opts.device}`, dtype: 'bf16', capabilities: ['progress', 'cancel'] })
    await request('generate', {
      output: remoteOutput,
      prompt: opts.params.prompt,
      negative_prompt: opts.params.negativePrompt,
      width: opts.params.width,
      height: opts.params.height,
      steps: opts.params.steps,
      cfg: opts.params.cfg,
      seed: opts.params.seed,
      save_metadata: true,
      include_prompts: true,
    })
  } catch (error) {
    sink.event({ type: 'error', code: 'E_REMOTE', message: String(error instanceof Error ? error.message : error), fatal: true })
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    finish(1)
  }
}
