import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Events } from '@shared/channels'
import type {
  JobLogLine,
  JobParams,
  JobRecord,
  JobStage,
  JobState,
  ModelBinding,
  WorkspaceKind,
} from '@shared/types'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { prepareModelBundle } from './modelBundles'
import { legacyModelReady, resolveLegacyModelPath } from './modelReadiness'
import { cancelMossInferJob, resolveServerPath, restartMossInfer, runMossInferJob } from './mossInfer'
import { getSettings } from './settings'
import { getTrainingHost } from './trainingHosts'
import { runRemoteEngineJob } from './remoteEngine'
import {
  remoteAbsolute,
  sshExec,
} from './ssh'
import { pushDiagnostic } from './diagnostics'
import { pushLocalNotification } from './desktopNotifications'
import {
  LineSplitter,
  exitRule,
  loadRules,
  matchRule,
  parseDownloadProgress,
  parseTqdm,
  progressFor,
  stripAnsi,
  toDiagnostic,
} from './parsers'

const PREFIX = '@@CLOVER@@ '

function channelSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-')
}
const DEFAULT_MODEL = 'OpenMOSS-Team/MOSS-Image-SFT'
const MAX_LOG_LINES = 2000

interface RunningJob {
  child: ChildProcessWithoutNullStreams | undefined
  out: LineSplitter
  err: LineSplitter
  readyTimer: NodeJS.Timeout
  killTimer?: NodeJS.Timeout
  lastLines: string[]
  cancelRequested: boolean
  cancelCommand?: { command: string; args: string[]; env?: NodeJS.ProcessEnv }
}

const jobs = new Map<string, JobRecord>()
const logs = new Map<string, JobLogLine[]>()
const running = new Map<string, RunningJob>()
const seqs = new Map<string, number>()
const completionListeners: Array<(job: JobRecord) => void> = []
let loaded = false

function jobsDir(): string {
  return join(paths.root(), 'jobs')
}

function logPath(jobId: string): string {
  return join(jobsDir(), `${jobId}.jsonl`)
}

async function loadJobs(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(await readFile(join(jobsDir(), 'jobs.json'), 'utf8')) as Array<
      JobRecord & { backend?: unknown }
    >
    for (const stored of raw) {
      const { backend: legacyBackend, ...rest } = stored
      const job: JobRecord = {
        ...rest,
        workspace: 'clover',
      }
      if (job.state === 'running' || job.state === 'starting' || job.state === 'queued') {
        job.state = 'failed'
        job.error = { code: 'E_INTERRUPTED', message: '应用重启，任务已中断' }
        job.endedAt = new Date().toISOString()
      }
      jobs.set(job.id, job)
    }
  } catch {
    // first run
  }
}

async function saveJobs(): Promise<void> {
  try {
    await mkdir(jobsDir(), { recursive: true })
    const list = [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 60)
    await writeFile(join(jobsDir(), 'jobs.json'), JSON.stringify(list, null, 2), 'utf8')
  } catch {
    // best effort
  }
}

function snapshot(job: JobRecord): JobRecord {
  return { ...job, params: { ...job.params }, progress: { ...job.progress } }
}

function update(job: JobRecord, patch: Partial<JobRecord>): void {
  const previousState = job.state
  Object.assign(job, patch)
  emit(Events.job, snapshot(job))
  if (
    previousState !== job.state &&
    job.mode !== 'simulate' &&
    (job.state === 'succeeded' || job.state === 'failed')
  ) {
    const training = job.kind === 'training' || job.mode === 'training'
    const label = training ? '训练' : '生成'
    const target = training
      ? job.trainerRunName ?? job.instanceName
      : job.caseName ?? job.instanceName
    pushLocalNotification({
      title: job.state === 'succeeded' ? `${label}完成` : `${label}失败`,
      body:
        job.state === 'succeeded'
          ? `${target} · 点击查看终端`
          : `${target} · ${job.error?.message ?? '查看诊断了解原因'}`,
      windowKind: 'studio',
      route: job.state === 'succeeded' ? undefined : '/diagnostics',
    })
  }
  void saveJobs()
}

function appendLog(job: JobRecord, stream: JobLogLine['stream'], text: string, runningJob?: RunningJob): void {
  const trimmed = stripAnsi(text).replace(/\r/g, '').trimEnd()
  if (!trimmed) return
  const seq = (seqs.get(job.id) ?? 0) + 1
  seqs.set(job.id, seq)
  const line: JobLogLine = {
    jobId: job.id,
    seq,
    at: new Date().toISOString(),
    stream,
    text: trimmed.slice(0, 8000),
  }
  const list = logs.get(job.id) ?? []
  list.push(line)
  if (list.length > MAX_LOG_LINES) list.splice(0, list.length - MAX_LOG_LINES)
  logs.set(job.id, list)
  if (runningJob) {
    runningJob.lastLines.push(trimmed)
    if (runningJob.lastLines.length > 40) runningJob.lastLines.shift()
  }
  emit(Events.jobLog, line)
  void appendFile(logPath(job.id), `${JSON.stringify(line)}\n`, 'utf8').catch(() => undefined)
}

function recordError(job: JobRecord, raw: string, rule = matchRule(raw)): void {
  if (!rule) return
  const diagnostic = toDiagnostic(rule, raw, job.id)
  pushDiagnostic(diagnostic)
}




function envFor(job: JobRecord): NodeJS.ProcessEnv {
  return {
    PYTHONUNBUFFERED: '1',
    // Upstream reads UTF-8 assets without an explicit encoding; Windows may default to GBK.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: '.',
    PYTORCH_ENABLE_MPS_FALLBACK: '1',
    TOKENIZERS_PARALLELISM: 'false',
    HF_HOME: join(paths.models(getSettings().modelsRoot), 'hf'),
    HF_HUB_CACHE: join(paths.models(getSettings().modelsRoot), 'hf', 'hub'),
    CLOVER_JOB_ID: job.id,
    CLOVER_INSTANCE_ID: job.instanceId,
    ...(job.deviceId?.startsWith('cuda:') ? { CUDA_VISIBLE_DEVICES: job.deviceId.slice(5) } : {}),
  }
}

function killTree(child: ChildProcess): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else if (child.pid) {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

function finish(job: JobRecord, runningJob: RunningJob, code: number | null): void {
  if (!running.has(job.id)) return
  clearTimeout(runningJob.readyTimer)
  if (runningJob.killTimer) clearTimeout(runningJob.killTimer)
  for (const line of runningJob.out.flush()) appendLog(job, 'stdout', line, runningJob)
  for (const line of runningJob.err.flush()) appendLog(job, 'stderr', line, runningJob)
  running.delete(job.id)
  scheduleEngineQueue()

  const exitCode = code ?? -1
  if (job.state === 'succeeded' || job.state === 'canceled') {
    update(job, { endedAt: new Date().toISOString(), exitCode })
    notifyCompleted(job)
    return
  }

  if (runningJob.cancelRequested) {
    update(job, { state: 'canceled', endedAt: new Date().toISOString(), exitCode })
    notifyCompleted(job)
    return
  }

  if (job.error) {
    update(job, { state: 'failed', endedAt: new Date().toISOString(), exitCode })
    return
  }

  if (exitCode === 0 && job.kind === 'training') {
    update(job, {
      state: 'succeeded',
      stage: 'save',
      progress: { ...job.progress, stage: 'save', percent: 100 },
      endedAt: new Date().toISOString(),
      exitCode,
    })
    notifyCompleted(job)
    return
  }

  if (exitCode === 0) {
    update(job, {
      state: 'failed',
      error: { code: 'E_NO_RESULT', message: '进程已退出，但没有返回生成结果' },
      endedAt: new Date().toISOString(),
      exitCode,
    })
    pushDiagnostic({
      jobId: job.id,
      ruleId: 'E_NO_RESULT',
      severity: 'error',
      title: '没有返回结果',
      explain: 'runner 正常退出，但没有发送 result 事件。请检查实例代码与模型路径。',
      solutions: [{ label: '查看日志', action: 'open_log' }],
      raw: runningJob.lastLines.slice(-10).join('\n'),
      signature: `E_NO_RESULT:${job.id}`,
    })
    notifyCompleted(job)
    return
  }

  const last = runningJob.lastLines.slice(-12).join('\n')
  const matched = runningJob.lastLines.map((line) => matchRule(line)).find(Boolean)
  const rule = matched ?? exitRule()
  const diagnostic = toDiagnostic(rule, last, job.id)
  pushDiagnostic(diagnostic)
  update(job, {
    state: 'failed',
    error: { code: rule.id, message: diagnostic.title },
    endedAt: new Date().toISOString(),
    exitCode,
  })
  notifyCompleted(job)
}

function handleRunnerEvent(job: JobRecord, runningJob: RunningJob, payload: string): void {
  let event: Record<string, unknown>
  try {
    event = JSON.parse(payload) as Record<string, unknown>
  } catch {
    appendLog(job, 'system', `无法解析 runner 事件：${payload.slice(0, 200)}`, runningJob)
    return
  }
  const type = String(event['type'] ?? '')
  if (type === 'ready') {
    clearTimeout(runningJob.readyTimer)
    update(job, { state: 'running', stage: 'ready' })
    return
  }
  if (type === 'stage') {
    const stage = String(event['name'] ?? '') as JobStage
    const allowed: JobStage[] = ['load', 'text', 'denoise', 'decode', 'save']
    if (allowed.includes(stage)) {
      update(job, {
        state: job.state === 'starting' ? 'running' : job.state,
        stage,
        progress: {
          ...job.progress,
          stage,
          current: stage === 'denoise' ? 0 : job.progress.current,
          percent: stage === 'denoise' ? 0 : job.progress.percent,
        },
      })
    }
    return
  }
  if (type === 'progress') {
    const current = Number(event['current'] ?? 0)
    const total = Number(event['total'] ?? 0)
    const percent = Number(event['percent'] ?? (total ? (current / total) * 100 : 0))
    update(job, {
      state: job.state === 'starting' ? 'running' : job.state,
      progress: {
        stage: (String(event['stage'] ?? job.stage) as JobStage) || job.stage,
        current,
        total,
        percent: Math.max(job.progress.percent, Math.min(100, percent)),
        etaMs: typeof event['eta_ms'] === 'number' ? (event['eta_ms'] as number) : undefined,
        message: typeof event['message'] === 'string' ? (event['message'] as string) : undefined,
      },
    })
    return
  }
  if (type === 'log') {
    appendLog(job, 'system', String(event['message'] ?? ''), runningJob)
    return
  }
  if (type === 'result') {
    const outputs = Array.isArray(event['images'])
      ? (event['images'] as Array<Record<string, unknown>>).map((image) => ({
          path: String(image['path'] ?? ''),
          width: Number(image['width'] ?? job.params.width),
          height: Number(image['height'] ?? job.params.height),
          seed: Number(image['seed'] ?? job.params.seed),
        }))
      : []
    update(job, {
      state: 'succeeded',
      stage: 'save',
      progress: { ...job.progress, stage: 'save', percent: 100 },
      outputs,
    })
    return
  }
  if (type === 'error') {
    const code = String(event['code'] ?? 'E_INTERNAL')
    const message = String(event['message'] ?? '运行失败')
    const rule =
      loadRules().find((candidate) => candidate.id === code) ??
      matchRule(`${code} ${message}`) ?? {
        id: code,
        match: null,
        severity: 'error' as const,
        title: message.slice(0, 60) || '运行失败',
        explain: message,
        solutions: [{ label: '查看日志', action: 'open_log' }],
      }
    pushDiagnostic(toDiagnostic(rule, String(event['traceback'] ?? message), job.id))
    update(job, {
      state: 'failed',
      error: { code, message },
      endedAt: new Date().toISOString(),
    })
    return
  }
  if (type === 'canceled') {
    update(job, { state: 'canceled', endedAt: new Date().toISOString() })
    return
  }
  if (type === 'bye') {
    const code = Number(event['exit_code'] ?? 0)
    update(job, { exitCode: code })
  }
}

function handleLine(job: JobRecord, runningJob: RunningJob, stream: 'stdout' | 'stderr', raw: string): void {
  const line = stripAnsi(raw).trimEnd()
  if (!line.trim()) return

  if (line.startsWith(PREFIX)) {
    handleRunnerEvent(job, runningJob, line.slice(PREFIX.length))
    return
  }

  appendLog(job, stream, line, runningJob)


  const download = parseDownloadProgress(line)
  if (download) {
    update(job, {
      progress: {
        stage: 'load',
        current: 0,
        total: 0,
        percent: download.percent,
        message: `${download.label ?? '下载'} ${download.rate ?? ''}`.trim(),
      },
    })
    return
  }

  const progress = progressFor(line, job.stage, job.progress)
  if (progress) {
    update(job, { progress })
    return
  }

  const tqdm = parseTqdm(line)
  if (tqdm && job.stage === 'idle') {
    update(job, {
      progress: {
        stage: 'denoise',
        current: tqdm.current,
        total: tqdm.total,
        percent: tqdm.percent,
        etaMs: tqdm.etaMs,
        message: tqdm.rate,
      },
    })
  }

  if (stream === 'stderr' || /error|traceback|exception/i.test(line)) {
    recordError(job, line)
  }
}

export interface StartEngineJobInput {
  projectId?: string
  canvasId?: string
  modelBinding?: ModelBinding
  modelName?: string
  prompt: string
  negativePrompt?: string
  width: number
  height: number
  steps: number
  cfg: number
  seed: number
  profile?: 'base' | 'dmd8'
  deviceId?: string
  hostId?: string
  remoteModelPath?: string
}

interface QueuedEngineJob {
  input: StartEngineJobInput
  job: JobRecord
}

const engineQueue: QueuedEngineJob[] = []
let engineStartClaimed = false

function hasActiveEngineJob(): boolean {
  return [...running.keys()].some((id) => {
    const job = jobs.get(id)
    return job?.kind === 'inference' && job.engine === 'mossinfer' && (job.state === 'starting' || job.state === 'running')
  })
}

function scheduleEngineQueue(): void {
  setTimeout(() => { void pumpEngineQueue() }, 0)
}

async function pumpEngineQueue(): Promise<void> {
  if (engineStartClaimed || hasActiveEngineJob() || engineQueue.length === 0) return
  const next = engineQueue.shift()!
  engineStartClaimed = true
  try {
    await startEngineJobNow(next.input, next.job)
  } catch (error) {
    update(next.job, {
      state: 'failed',
      error: { code: 'E_ENGINE', message: error instanceof Error ? error.message : String(error) },
      endedAt: new Date().toISOString(),
      exitCode: 1,
    })
    notifyCompleted(next.job)
    scheduleEngineQueue()
  } finally {
    engineStartClaimed = false
  }
}

/** Generate directly through MossInfer; no Instance, repo worktree or Python runtime. */
export async function startEngineJob(input: StartEngineJobInput): Promise<JobRecord> {
  await loadJobs()
  if (!input.prompt.trim()) throw new Error('提示词不能为空')

  if (engineStartClaimed || hasActiveEngineJob() || engineQueue.length > 0) {
    const params: JobParams = {
      prompt: input.prompt,
      negativePrompt: input.negativePrompt ?? '',
      width: input.width,
      height: input.height,
      steps: input.steps,
      cfg: input.cfg,
      seed: input.seed,
      profile: input.profile ?? 'base',
    }
    const job: JobRecord = {
      id: `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      instanceId: 'engine',
      instanceName: input.modelName ?? 'MossInfer',
      workspace: 'clover',
      projectId: input.projectId,
      canvasId: input.canvasId,
      deviceId: input.deviceId,
      hostId: input.hostId,
      kind: 'inference',
      mode: 'runner',
      engine: 'mossinfer',
      state: 'queued',
      stage: 'idle',
      params,
      progress: { stage: 'idle', current: 0, total: params.steps, percent: 0 },
      startedAt: new Date().toISOString(),
    }
    job.logPath = logPath(job.id)
    jobs.set(job.id, job)
    logs.set(job.id, [])
    seqs.set(job.id, 0)
    update(job, {})
    engineQueue.push({ input, job })
    return snapshot(job)
  }

  engineStartClaimed = true
  try {
    return await startEngineJobNow(input)
  } finally {
    engineStartClaimed = false
    if (engineQueue.length) scheduleEngineQueue()
  }
}

async function startEngineJobNow(input: StartEngineJobInput, queuedJob?: JobRecord): Promise<JobRecord> {
  await loadJobs()
  const settings = getSettings()
  if (!input.prompt.trim()) throw new Error('提示词不能为空')

  let modelPath: string | undefined
  let modelSnapshot: unknown
  if (!input.hostId) {
    const serverPath = resolveServerPath(settings)
    if (!serverPath || !existsSync(serverPath)) throw new Error('未找到 moss-server；请先在引擎页下载或配置引擎')
    if (input.modelBinding) {
      const bundlePath = await prepareModelBundle(input.modelBinding, settings)
      modelPath = bundlePath
      modelSnapshot = JSON.parse(await readFile(join(bundlePath, 'clover_model.json'), 'utf8'))
    } else {
      modelPath =
        (await resolveLegacyModelPath(
          join(paths.hub(settings.modelsRoot), 'models--OpenMOSS-Team--MOSS-Image-SFT'),
        )) ?? undefined
    }
    if (!modelPath) throw new Error('模型权重尚未就绪，请先在模型库下载 MOSS-Image')
  }

  if (input.hostId) {
    const host = getTrainingHost(settings, input.hostId)
    if (!host || host.kind !== 'ssh') throw new Error('远端引擎主机不存在')
    if (!input.remoteModelPath?.trim()) throw new Error('远端模型路径未配置')
    const outputRoot = await remoteAbsolute(host, host.outputRoot ?? '~/.mossstudio/outputs')
    const remoteOutput = `${outputRoot.replace(/\/$/, '')}/${Date.now().toString(36)}-${randomUUID().slice(0, 6)}.png`
    const localOutput = join(paths.outputs(), `${channelSafe(host.id)}-${Date.now().toString(36)}.png`)
    const params: JobParams = {
      prompt: input.prompt,
      negativePrompt: input.negativePrompt ?? '',
      width: input.width,
      height: input.height,
      steps: input.steps,
      cfg: input.cfg,
      seed: input.seed,
      profile: input.profile ?? 'base',
    }
    const job: JobRecord = queuedJob ?? {
      id: `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      instanceId: 'engine',
      instanceName: input.modelName ?? host.name,
      workspace: 'clover',
      projectId: input.projectId,
      canvasId: input.canvasId,
      deviceId: input.deviceId,
      hostId: host.id,
      kind: 'inference',
      mode: 'runner',
      engine: 'mossinfer',
      state: 'starting',
      stage: 'idle',
      params,
      progress: { stage: 'idle', current: 0, total: params.steps, percent: 0 },
      startedAt: new Date().toISOString(),
    }
    Object.assign(job, {
      instanceName: input.modelName ?? host.name,
      projectId: input.projectId,
      canvasId: input.canvasId,
      deviceId: input.deviceId,
      hostId: host.id,
      state: 'starting' as const,
      params,
      progress: { stage: 'idle' as const, current: 0, total: params.steps, percent: 0 },
      error: undefined,
      endedAt: undefined,
    })
    job.logPath = logPath(job.id)
    jobs.set(job.id, job)
    logs.set(job.id, [])
    seqs.set(job.id, 0)
    emit(Events.job, snapshot(job))
    const readyTimer = setTimeout(() => {
      if (job.state === 'starting') {
        update(job, { state: 'failed', error: { code: 'E_TIMEOUT', message: '远端引擎启动超时' } })
      }
    }, 180_000)
    const runningJob: RunningJob = { child: undefined, out: new LineSplitter(), err: new LineSplitter(), readyTimer, lastLines: [], cancelRequested: false }
    running.set(job.id, runningJob)
    void runRemoteEngineJob(
      host,
      {
        engineRoot: host.engineRoot,
        model: input.remoteModelPath,
        output: remoteOutput,
        localOutput,
        params,
        mode: settings.mossInferMemoryMode,
        tier: settings.mossInferTier,
        device: input.deviceId?.startsWith('cuda:') ? Number(input.deviceId.slice(5)) : undefined,
      },
      {
        event: (payload) => handleRunnerEvent(job, runningJob, JSON.stringify(payload)),
        stderr: (line) => appendLog(job, 'stderr', line, runningJob),
        done: (code) => finish(job, runningJob, code),
      },
    ).catch((error: unknown) => {
      handleRunnerEvent(job, runningJob, JSON.stringify({ type: 'error', code: 'E_REMOTE', message: String(error instanceof Error ? error.message : error), fatal: true }))
      finish(job, runningJob, -1)
    })
    return snapshot(job)
  }

  const params: JobParams = {
    prompt: input.prompt,
    negativePrompt: input.negativePrompt ?? '',
    width: input.width,
    height: input.height,
    steps: input.steps,
    cfg: input.cfg,
    seed: input.seed,
    profile: input.profile ?? 'base',
  }
  const job: JobRecord = queuedJob ?? {
    id: `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    instanceId: 'engine',
    instanceName: input.modelName ?? 'MossInfer',
    workspace: 'clover',
    projectId: input.projectId,
    canvasId: input.canvasId,
    modelSnapshot,
    deviceId: input.deviceId,
    kind: 'inference',
    mode: 'runner',
    engine: 'mossinfer',
    state: 'starting',
    stage: 'idle',
    params,
    progress: { stage: 'idle', current: 0, total: params.steps, percent: 0 },
    startedAt: new Date().toISOString(),
  }
  Object.assign(job, {
    instanceName: input.modelName ?? 'MossInfer',
    projectId: input.projectId,
    canvasId: input.canvasId,
    deviceId: input.deviceId,
    modelSnapshot,
    state: 'starting' as const,
    params,
    progress: { stage: 'idle' as const, current: 0, total: params.steps, percent: 0 },
    error: undefined,
    endedAt: undefined,
  })
  job.logPath = logPath(job.id)
  jobs.set(job.id, job)
  logs.set(job.id, [])
  seqs.set(job.id, 0)
  emit(Events.job, snapshot(job))

  const outputDir = paths.outputs()
  await mkdir(outputDir, { recursive: true })
  const readyTimer = setTimeout(() => {
    if (job.state === 'starting') {
      pushDiagnostic({
        jobId: job.id,
        ruleId: 'E_TIMEOUT',
        severity: 'error',
        title: '启动超时',
        explain: 'moss-server 在 180 秒内没有就绪，通常是引擎启动或模型加载失败。',
        solutions: [{ label: '查看日志', action: 'open_log' }, { label: '打开引擎', action: 'open_settings' }],
        raw: 'ready timeout',
        signature: `E_TIMEOUT:${job.id}`,
      })
      update(job, { state: 'failed', error: { code: 'E_TIMEOUT', message: '启动超时' } })
      void restartMossInfer()
    }
  }, 180_000)
  const runningJob: RunningJob = {
    child: undefined,
    out: new LineSplitter(),
    err: new LineSplitter(),
    readyTimer,
    lastLines: [],
    cancelRequested: false,
  }
  running.set(job.id, runningJob)
  const cudaOrdinal = input.deviceId?.startsWith('cuda:') ? Number(input.deviceId.slice(5)) : -1
  const output = join(outputDir, `${job.id}-1.png`)
  void runMossInferJob(
    job,
    params,
    { model: modelPath!, device: cudaOrdinal, loras: [], output, settings },
    {
      event: (payload) => handleRunnerEvent(job, runningJob, JSON.stringify(payload)),
      stderr: (line) => appendLog(job, 'stderr', line, runningJob),
      done: (code) => finish(job, runningJob, code),
    },
  ).catch((error: unknown) => {
    handleRunnerEvent(
      job,
      runningJob,
      JSON.stringify({
        type: 'error',
        code: 'E_ENGINE',
        message: String(error instanceof Error ? error.message : error),
        fatal: true,
      }),
    )
    finish(job, runningJob, -1)
  })
  return snapshot(job)
}


export interface StartTrainingJobInput {
  versionId: string
  hostId?: string
  runName?: string
  action?: string
  weights?: string
  algo?: string
  name: string
  cwd: string
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  totalSteps?: number
  cancelCommand?: { command: string; args: string[]; env?: NodeJS.ProcessEnv }
}

function trainerMetrics(line: string): { step?: number; loss?: number; gradNorm?: number; lr?: number } | null {
  const stepMatch = line.match(/\bstep\s+([\d,]+)/i)
  const lossMatch = line.match(/\bloss\s*[=:]\s*([-+0-9.eE]+)/i)
  const gradMatch = line.match(/\bgrad(?:_norm|ient_norm)?\s*[=:]\s*([-+0-9.eE]+)/i)
  const lrMatch = line.match(/\blr\s*[=:]\s*([-+0-9.eE]+)/i)
  if (!stepMatch && !lossMatch) return null
  return {
    step: stepMatch ? Number.parseInt(stepMatch[1]!.replace(/,/g, ''), 10) : undefined,
    loss: lossMatch ? Number.parseFloat(lossMatch[1]!) : undefined,
    gradNorm: gradMatch ? Number.parseFloat(gradMatch[1]!) : undefined,
    lr: lrMatch ? Number.parseFloat(lrMatch[1]!) : undefined,
  }
}

export async function startTrainingJob(input: StartTrainingJobInput): Promise<JobRecord> {
  await loadJobs()
  const hostKey = input.hostId ?? 'local'
  const active = [...jobs.values()].filter((item) => item.state === 'running' || item.state === 'starting')
  const trainingConflict = active.find((item) => item.kind === 'training' && (item.hostId ?? 'local') === hostKey)
  if (trainingConflict) throw new Error('该训练主机已有训练任务在运行；每个 host 同时只允许 1 个训练')
  if (hostKey === 'local') {
    const inferenceConflict = active.find((item) => item.kind !== 'training')
    if (inferenceConflict) throw new Error('本机还有推理任务在运行；训练独占本地设备，请先停止推理')
  }
  const job: JobRecord = {
    id: `train-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    instanceId: input.versionId,
    instanceName: input.name,
    kind: 'training',
    trainerVersionId: input.versionId,
    trainerRunName: input.runName,
    trainerAction: input.action,
    trainerWeights: input.weights,
    trainerAlgo: input.algo,
    hostId: input.hostId,
    mode: 'training',
    state: 'starting',
    stage: 'denoise',
    params: { prompt: '', negativePrompt: '', width: 0, height: 0, steps: input.totalSteps ?? 0, cfg: 0, seed: 0, profile: 'base' },
    progress: { stage: 'denoise', current: 0, total: input.totalSteps ?? 0, percent: 0 },
    startedAt: new Date().toISOString(),
  }
  job.logPath = logPath(job.id)
  jobs.set(job.id, job)
  logs.set(job.id, [])
  seqs.set(job.id, 0)
  emit(Events.job, snapshot(job))

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...envFor(job), ...input.env },
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    update(job, { state: 'failed', error: { code: 'E_SPAWN', message: String(error) } })
    throw error
  }

  const runningJob: RunningJob = {
    child,
    out: new LineSplitter(),
    err: new LineSplitter(),
    readyTimer: setTimeout(() => undefined, 0),
    lastLines: [],
    cancelRequested: false,
    cancelCommand: input.cancelCommand,
  }
  clearTimeout(runningJob.readyTimer)
  running.set(job.id, runningJob)
  update(job, { pid: child.pid ?? undefined, state: 'running' })

  const handle = (stream: 'stdout' | 'stderr', raw: string): void => {
    const line = stripAnsi(raw).trimEnd()
    if (!line.trim()) return
    appendLog(job, stream, line, runningJob)
    const metrics = trainerMetrics(line)
    if (metrics) {
      const nextMetrics = { ...job.metrics, ...Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== undefined)) }
      const current = metrics.step ?? job.progress.current
      const total = job.progress.total
      update(job, {
        metrics: nextMetrics as JobRecord['metrics'],
        progress: {
          stage: 'denoise',
          current,
          total,
          percent: total > 0 ? Math.max(job.progress.percent, Math.min(100, (current / total) * 100)) : job.progress.percent,
          message: metrics.loss !== undefined ? `loss ${metrics.loss.toFixed(4)}` : job.progress.message,
        },
      })
      return
    }
    if (stream === 'stderr' || /error|traceback|exception/i.test(line)) recordError(job, line)
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    for (const line of runningJob.out.push(chunk)) handle('stdout', line)
  })
  child.stderr.on('data', (chunk: string) => {
    for (const line of runningJob.err.push(chunk)) handle('stderr', line)
  })
  child.on('error', (error) => {
    appendLog(job, 'system', String(error), runningJob)
    update(job, { state: 'failed', error: { code: 'E_SPAWN', message: String(error) } })
    finish(job, runningJob, -1)
  })
  child.on('close', (code) => finish(job, runningJob, code))
  return snapshot(job)
}

export async function cancelJob(id: string): Promise<JobRecord | null> {
  const job = jobs.get(id)
  const runningJob = running.get(id)
  if (!job) return null
  const queuedIndex = engineQueue.findIndex((entry) => entry.job.id === id)
  if (queuedIndex >= 0) {
    engineQueue.splice(queuedIndex, 1)
    update(job, { state: 'canceled', endedAt: new Date().toISOString() })
    notifyCompleted(job)
    scheduleEngineQueue()
    return snapshot(job)
  }
  if (!runningJob) {
    if (job.state === 'running' || job.state === 'starting') {
      update(job, { state: 'canceled', endedAt: new Date().toISOString() })
    }
    return snapshot(job)
  }
  runningJob.cancelRequested = true
  appendLog(job, 'system', '正在停止任务…', runningJob)
  if (job.engine === 'mossinfer') {
    cancelMossInferJob(job.id)
    // server 卡死兜底：5 秒后仍无 done-cancelled 则重启引擎，exit 处理会失败活动任务
    runningJob.killTimer = setTimeout(() => {
      void restartMossInfer()
    }, 5000)
    return snapshot(job)
  }
  if (runningJob.cancelCommand) {
    try {
      spawn(runningJob.cancelCommand.command, runningJob.cancelCommand.args, {
        env: { ...process.env, ...runningJob.cancelCommand.env },
        windowsHide: true,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
      }).unref()
    } catch {
      // best effort; fall back to local signal below
    }
  }
  try {
    runningJob.child?.stdin.write(`${PREFIX}{"cmd":"cancel"}\n`)
  } catch {
    // ignore
  }
  runningJob.killTimer = setTimeout(() => {
    if (runningJob.child) killTree(runningJob.child)
  }, 5000)
  return snapshot(job)
}

export function onJobCompleted(listener: (job: JobRecord) => void): void {
  completionListeners.push(listener)
}

function notifyCompleted(job: JobRecord): void {
  for (const listener of completionListeners) {
    try {
      listener(snapshot(job))
    } catch {
      // completion listeners must not affect the job record
    }
  }
}

export function inputJob(id: string, text: string): void {
  const job = jobs.get(id)
  const runningJob = running.get(id)
  if (!job || !runningJob || !runningJob.child) return
  try {
    runningJob.child.stdin.write(`${text}\n`)
    appendLog(job, 'system', `> ${text}`, runningJob)
  } catch {
    // stdin may be closed already
  }
}

/** Remove jobs created by old simulation scenarios, including their JSONL. */
export async function purgeLegacySimulationJobs(): Promise<number> {
  await loadJobs()
  let removed = 0
  for (const [id, job] of [...jobs.entries()]) {
    let simulation = /模拟|fake/i.test(job.instanceName || '')
    if (!simulation) {
      try {
        const text = await readFile(logPath(id), 'utf8')
        simulation = /模拟模式|训练（模拟）|模拟训练|fake trainer/i.test(text)
      } catch {
        // no log file
      }
    }
    if (!simulation) continue
    jobs.delete(id)
    logs.delete(id)
    await rm(logPath(id), { force: true }).catch(() => undefined)
    await rm(join(jobsDir(), `${id}.json`), { force: true }).catch(() => undefined)
    removed += 1
  }
  if (removed) await saveJobs()
  return removed
}

export async function listJobs(): Promise<JobRecord[]> {
  await loadJobs()
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(snapshot)
}

export async function getJob(id: string): Promise<JobRecord | null> {
  await loadJobs()
  const job = jobs.get(id)
  return job ? snapshot(job) : null
}

export async function getJobLogs(id: string): Promise<JobLogLine[]> {
  if (logs.has(id)) return [...(logs.get(id) ?? [])]
  try {
    const text = await readFile(logPath(id), 'utf8')
    const parsed = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JobLogLine)
    logs.set(id, parsed.slice(-MAX_LOG_LINES))
    return parsed.slice(-MAX_LOG_LINES)
  } catch {
    return []
  }
}

export async function listJobLogFiles(): Promise<string[]> {
  try {
    return (await readdir(jobsDir())).filter((name) => name.endsWith('.jsonl')).map((name) => join(jobsDir(), name))
  } catch {
    return []
  }
}
