import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Events } from '@shared/channels'
import type { JobLogLine, JobParams, JobRecord, JobStage, ModelBinding, ModelBundle, GpuInventoryDevice } from '@shared/types'
import { cliUnsupported } from '../lib/cliProtocol'
import { codedError, errorCode } from '../lib/codedError'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { prepareModelSource } from './modelBundles'
import { resolveLegacyModelPath } from './modelReadiness'
import { cancelMossInferJob, releaseStaleMossInferRuntimes, restartMossInfer, runMossInferJob } from './mossInfer'
import { jobWeightPrecisions } from './weightPrecision'
import { cancelCliJob, cliBundleDtypeProblem, hipDeviceIndex, runCliJob, type HipIndexResult } from './cliEngine'
import { currentEngineMachine, localServerPath, resolveDeviceEngine, skippedForMemory, type DeviceEngine } from './engineInstalls'
import { getCatalog } from './models'
import { getSettings } from './settings'
import { writeFileAtomic } from '../lib/atomicWrite'
import { refreshGpuInventory } from './devices'
import { resolveGpuSelection } from '../lib/gpuInventory'
import { selectAutomaticGpu } from '@shared/gpuScheduling'
import { gpuMemoryTooSmall, memoryGb } from '@shared/machineFit'
import { judgeEngineSupport } from '@shared/engineProtocol'
import { CLI_ENGINE_LABEL, cliBundleProblem, type CliEngineKind } from '@shared/cliEngine'
import { isCliEngine } from '@shared/enginePackages'
import { canvasBranchesConflict } from '@shared/canvasJobBranch'
import {
  resolveGpuProfile,
  settingsForGpuProfile,
  withWeightTier,
  type ResolvedGpuProfile,
  type WeightPrecisions,
} from '@shared/gpuProfile'
import { bundleGpuProblem, isFileBundle, profileForBundle } from '@shared/bundleFit'
import { probeLocalEngineGpuCompatibility } from './engines'
import { getTrainingHost } from './trainingHosts'
import { cancelRemoteEngineJob, runRemoteEngineJob } from './remoteEngine'
import { remoteAbsolute } from './ssh'
import { pushDiagnostic } from './diagnostics'
import { pushLocalNotification } from './desktopNotifications'
import { LineSplitter, exitRule, loadRules, matchRule, stripAnsi, toDiagnostic } from './parsers'
import { waitForEngineActivation } from '../lib/engineActivation'
import { jobPreviewPath, previewsDir, PreviewThrottle, queuePositions } from './jobPreview'
import { jobInputFiles } from './generateParams'

const PREFIX = '@@CLOVER@@ '

function channelSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-')
}
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
  /** Runs on a CLI engine (moss-infer-vulkan / moss-infer-hip), possibly not handed to it yet. */
  cli?: boolean
}

const jobs = new Map<string, JobRecord>()
const logs = new Map<string, JobLogLine[]>()
const running = new Map<string, RunningJob>()
/**
 * Jobs canceled after they left the queue but before they reached the engine
 * (while their model, GPU and weights were being looked up): they never start.
 */
const canceledBeforeStart = new Set<string>()
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
  // Live previews belong to running jobs; whatever a previous run left is stale.
  await rm(previewsDir(), { recursive: true, force: true }).catch(() => undefined)
  try {
    const raw = JSON.parse(await readFile(join(jobsDir(), 'jobs.json'), 'utf8')) as Array<JobRecord & { backend?: unknown }>
    for (const stored of raw) {
      const { backend: _legacyBackend, ...rest } = stored
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

/**
 * Work the caller does not wait for (a job's state never waits for the disk): job list, log and
 * preview-removal writes, and engine queue pumps from the moment they are scheduled.
 */
const pendingWork = new Set<Promise<unknown>>()

function inBackground(work: Promise<unknown>): void {
  pendingWork.add(work)
  const done = (): void => {
    pendingWork.delete(work)
  }
  work.then(done, done)
}

/**
 * Resolves once all background work started or scheduled so far has finished: job list, log and
 * preview-removal writes, and engine queue pumps, with the writes and pumps those start in turn.
 * Not called by the app; tests use it before removing the data root.
 */
export async function settleJobWrites(): Promise<void> {
  while (pendingWork.size > 0) await Promise.allSettled([...pendingWork])
}

/** The job list save in progress, and whether jobs changed since it took its snapshot. */
let saving: Promise<void> | null = null
let saveAgain = false
/**
 * A failed save is tried once more after this long (a file briefly locked on Windows), so a job's final
 * state is not left behind. Once: after that, the next change writes again.
 */
const SAVE_RETRY_MS = 1500
let retry: 'ready' | 'scheduled' | 'used' = 'ready'

/** One save: the snapshot is taken right before the write, so a change during the write sets saveAgain. */
async function writeJobList(): Promise<void> {
  await mkdir(jobsDir(), { recursive: true })
  const list = [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 60)
  await writeFileAtomic(join(jobsDir(), 'jobs.json'), JSON.stringify(list, null, 2))
}

async function runSaves(): Promise<void> {
  for (;;) {
    saveAgain = false
    try {
      await writeJobList()
    } catch {
      // Best effort: the jobs stay in memory; one delayed retry, then the next change writes them again.
      saving = null
      scheduleSaveRetry()
      return
    }
    // Checked and cleared in the same turn as the write's end: a change can't slip in between.
    if (!saveAgain) {
      saving = null
      retry = 'ready'
      return
    }
  }
}

function scheduleSaveRetry(): void {
  if (retry !== 'ready') return
  retry = 'scheduled'
  inBackground(
    new Promise<void>((resolve) => {
      // The retry alone never keeps the process alive (quitting with a pending retry loses only that retry).
      setTimeout(() => {
        retry = 'used'
        resolve(saveJobs())
      }, SAVE_RETRY_MS).unref()
    }),
  )
}

/**
 * Writes the job list, one write at a time and atomically (temp file, then rename), so jobs.json is never
 * half written or overwritten by an older snapshot. A call during a save makes that save write once more
 * with the newest jobs. Every caller's promise resolves after a write that includes its change, or after
 * the save fails (best effort). A caller may wait a little longer while job updates keep streaming in.
 */
function saveJobs(): Promise<void> {
  if (saving) {
    saveAgain = true
    return saving
  }
  // Started in a microtask, so `saving` is stored before runSaves can clear it, whatever fails first.
  saving = Promise.resolve().then(runSaves)
  return saving
}

function snapshot(job: JobRecord): JobRecord {
  return { ...job, params: { ...job.params }, progress: { ...job.progress } }
}

function update(job: JobRecord, patch: Partial<JobRecord>): void {
  const previousState = job.state
  Object.assign(job, patch)
  emit(Events.job, snapshot(job))
  if (previousState !== job.state && job.mode !== 'simulate' && (job.state === 'succeeded' || job.state === 'failed')) {
    const training = job.kind === 'training' || job.mode === 'training'
    const label = training ? '训练' : '生成'
    const target = training ? (job.trainerRunName ?? job.instanceName) : (job.caseName ?? job.instanceName)
    pushLocalNotification({
      title: job.state === 'succeeded' ? `${label}完成` : `${label}失败`,
      body: job.state === 'succeeded' ? `${target} · 点击查看终端` : `${target} · ${job.error?.message ?? '查看诊断了解原因'}`,
      windowKind: 'studio',
      route: job.state === 'succeeded' ? undefined : '/diagnostics',
    })
  }
  inBackground(saveJobs())
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
  // Best effort: the line is already in memory and on its way to the renderer.
  inBackground(appendFile(logPath(job.id), `${JSON.stringify(line)}\n`, 'utf8').catch(() => undefined))
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
  clearPreview(job)
  const slot = engineSlotKey(job)
  if (slot) {
    activeEngineSlots.delete(slot)
    if (engineQueues.get(slot)?.length) scheduleEngineQueue(slot)
  }

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

/** Coalesces the engine's preview writes into at most a few renderer updates a second. */
function previewLive(jobId: string): boolean {
  const job = jobs.get(jobId)
  return Boolean(job && running.has(jobId) && (job.state === 'running' || job.state === 'starting'))
}

const previewThrottle = new PreviewThrottle((jobId, preview) => {
  const job = jobs.get(jobId)
  if (job) update(job, { preview })
}, previewLive)

/** A job ended: its live preview goes (the record and the file); the next update carries that. */
function clearPreview(job: JobRecord): void {
  previewThrottle.stop(job.id)
  job.preview = undefined
  if (job.engine === 'mossinfer' && !job.hostId) {
    inBackground(rm(jobPreviewPath(job.id), { force: true }).catch(() => undefined))
  }
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
  if (type === 'preview') {
    const path = typeof event['path'] === 'string' ? (event['path'] as string) : ''
    if (!path || job.state === 'succeeded' || job.state === 'failed' || job.state === 'canceled') return
    previewThrottle.push(job.id, {
      path,
      step: Number(event['step'] ?? 0),
      total: Number(event['total'] ?? job.progress.total),
    })
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
    const rule = loadRules().find((candidate) => candidate.id === code) ??
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

export interface StartEngineJobInput extends Pick<JobParams, 'initImage' | 'mask' | 'control' | 'references' | 'sampling'> {
  projectId?: string
  canvasId?: string
  canvasLineage?: string[]
  /** The canvas's title, shown as the job's name in Activity (trimmed, at most 120 characters). */
  canvasTitle?: string
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
  /** Resolved LoRA adapters; paths must already be validated against the model root. */
  adapters?: Array<{ path: string; strength: number }>
  deviceUuid?: string
  deviceId?: string
  hostId?: string
  remoteModelPath?: string
}

interface QueuedEngineJob {
  input: StartEngineJobInput
  job: JobRecord
}

const engineQueues = new Map<string, QueuedEngineJob[]>()
const activeEngineSlots = new Set<string>()
const canvasReservations = new Map<string, { sourceId: string; path: Set<string> }>()
const pendingAutoGpuAssignments = new Map<string, number>()

/**
 * Restarts the moss-server of the GPU a local job runs on, and only that one:
 * restartMossInfer() without a device would stop every GPU's jobs.
 */
function restartOwnRuntime(job: JobRecord): void {
  if (job.hostId || !job.deviceUuid) return
  void restartMossInfer(job.deviceUuid)
}

/** moss-infer-hip's index of this AMD GPU: among the cards of its gfx target, in inventory order. */
async function hipIndexOf(engine: DeviceEngine, gpu: GpuInventoryDevice): Promise<HipIndexResult> {
  const gfxTarget = gpu.gfxTarget ?? engine.gfxTarget
  if (!gfxTarget) return { ok: true }
  const inventory = await refreshGpuInventory().catch(() => null)
  const same = (inventory?.devices ?? []).filter((device) => device.vendor === 'amd' && device.gfxTarget === gfxTarget)
  const ordinal = same.findIndex((device) => device.uuid === gpu.uuid)
  // Not in the inventory with this gfx target: only a lone card of it can be told apart.
  if (ordinal < 0 && same.length > 1) {
    return {
      ok: false,
      message: `分不清 ${gpu.name} 是 ${same.length} 张 ${gfxTarget} 显卡中的哪一张，请到 设置 › 设备 重新检测显卡后再试`,
    }
  }
  return hipDeviceIndex(engine.binaryPath, { name: gpu.name, gfxTarget }, Math.max(0, ordinal), engine.env)
}

/** An integrated GPU by the machine's Vulkan probe (unknown counts as discrete). */
function integratedGpu(uuid: string): boolean {
  return currentEngineMachine().machine.gpus.find((gpu) => gpu.id === uuid)?.vulkan?.discrete === false
}

/** The installed CLI engine (moss-infer-vulkan / moss-infer-hip) this GPU runs, if it runs one. */
function cliEngineOf(deviceUuid: string | undefined): (DeviceEngine & { kind: CliEngineKind }) | null {
  if (!deviceUuid) return null
  const engine = resolveDeviceEngine(deviceUuid)
  if (!engine || !isCliEngine(engine.package)) return null
  return { ...engine, kind: engine.package.kind as CliEngineKind }
}

/** The JobParams of an engine request; image inputs only when set. */
function paramsOf(input: StartEngineJobInput): JobParams {
  return {
    prompt: input.prompt,
    negativePrompt: input.negativePrompt ?? '',
    width: input.width,
    height: input.height,
    steps: input.steps,
    cfg: input.cfg,
    seed: input.seed,
    profile: input.profile ?? 'base',
    adapters: input.adapters,
    ...(input.initImage ? { initImage: input.initImage } : {}),
    ...(input.mask ? { mask: input.mask } : {}),
    ...(input.control ? { control: input.control } : {}),
    ...(input.references ? { references: input.references } : {}),
    ...(input.sampling ? { sampling: input.sampling } : {}),
  }
}

/** Tell each job still waiting in `slot`'s queue its (1-based) place, when it changed. */
function refreshQueuePositions(slot: string): void {
  const positions = queuePositions(engineQueues.get(slot) ?? [])
  for (const [id, position] of positions) {
    const job = jobs.get(id)
    if (job && job.state === 'queued' && job.queuePosition !== position) update(job, { queuePosition: position })
  }
}

function engineSlotKey(job: { deviceUuid?: string; hostId?: string }): string | null {
  if (job.hostId) return `host:${job.hostId}`
  return job.deviceUuid ? `gpu:${job.deviceUuid}` : null
}

function scheduleEngineQueue(slot: string): void {
  // Tracked from now, not from when it runs: its first write comes after awaited reads.
  inBackground(new Promise<void>((resolve) => setTimeout(() => resolve(pumpEngineQueue(slot)), 0)))
}

async function pumpEngineQueue(slot: string): Promise<void> {
  const queue = engineQueues.get(slot)
  if (activeEngineSlots.has(slot) || !queue?.length) return
  const next = queue.shift()!
  activeEngineSlots.add(slot)
  refreshQueuePositions(slot)
  try {
    await startEngineJobNow(next.input, next.job)
    // Canceled on its way to the engine: nothing runs in the slot.
    if (!running.has(next.job.id)) {
      activeEngineSlots.delete(slot)
      if (queue.length) scheduleEngineQueue(slot)
    }
  } catch (error) {
    canceledBeforeStart.delete(next.job.id)
    update(next.job, {
      queuePosition: undefined,
      state: 'failed',
      // Keep a refusal's own code (E_GPU_TOO_SMALL, E_NOT_SUPPORTED) for the job's Activity entry.
      error: { code: errorCode(error) ?? 'E_ENGINE', message: error instanceof Error ? error.message : String(error) },
      endedAt: new Date().toISOString(),
      exitCode: 1,
    })
    notifyCompleted(next.job)
    activeEngineSlots.delete(slot)
    if (queue.length) scheduleEngineQueue(slot)
  } finally {
    if (!queue.length) engineQueues.delete(slot)
  }
}

async function resolveLocalGpu(
  deviceUuid: string | undefined,
  /** What the job asks for: a job a CLI engine cannot run never goes to a CLI GPU. */
  params: JobParams,
  /** The model it runs: automatic assignment only picks a GPU that can run it (NVFP4 on an RTX 50). */
  model?: { bundle: ModelBundle; files: boolean },
): Promise<GpuInventoryDevice> {
  const settings = getSettings()
  const inventory = await refreshGpuInventory()
  if (!deviceUuid && settings.gpuSelection === 'auto') {
    // GPUs that run a CLI engine (兼容模式 / AMD 原生) are judged by their package, not by moss-server.
    const cliAll = inventory.devices.filter((device) => cliEngineOf(device.uuid))
    const cliAllUuids = new Set(cliAll.map((device) => device.uuid))
    const cudaAll = inventory.devices.filter((device) => !cliAllUuids.has(device.uuid) && (device.vendor ?? 'nvidia') === 'nvidia')
    // One compatibility probe per assignment, asked only when a CUDA GPU is considered.
    let probed: Promise<Awaited<ReturnType<typeof probeLocalEngineGpuCompatibility>>> | null = null
    const cudaCompatible = async (cudaGpus: GpuInventoryDevice[]): Promise<Set<string>> => {
      if (!cudaGpus.length) return new Set()
      probed ??= probeLocalEngineGpuCompatibility().catch((error: unknown) => {
        throw new Error(
          `自动分配无法验证引擎与 GPU 的兼容性：${error instanceof Error ? error.message : String(error)}。请到引擎页测试设备，或手动指定 GPU。`,
        )
      })
      const probe = await probed
      return new Set(
        cudaGpus
          .filter(
            (device) =>
              probe.helloFor(device.uuid) &&
              judgeEngineSupport(
                probe.helloFor(device.uuid)!,
                { index: device.index, name: device.name },
                { inventoryCapability: device.computeCapability },
              ).ok,
          )
          .map((device) => device.uuid),
      )
    }
    /** The GPUs among these that can take this job (engine, then what the job and the model need), or why none can. */
    const fitting = async (
      cliGpus: GpuInventoryDevice[],
      cudaGpus: GpuInventoryDevice[],
    ): Promise<{ uuids: Set<string>; cliUuids: Set<string> } | { refusal: Error }> => {
      const cudaUuids = await cudaCompatible(cudaGpus)
      const cliUuids = new Set(cliGpus.map((device) => device.uuid))
      // Automatic assignment prefers the full engine: CLI GPUs only on a machine without a CUDA one,
      // and only for plain text to image; integrated GPUs only when there is no discrete one.
      const needsCuda = cliUnsupported(cliEngineOf(cliGpus[0]?.uuid)?.kind ?? 'vulkan', params)
      let uuids = cudaUuids
      if (!cudaGpus.length && !needsCuda && cliUuids.size) {
        const discrete = [...cliUuids].filter((uuid) => !integratedGpu(uuid))
        uuids = new Set(discrete.length ? discrete : cliUuids)
      }
      if (needsCuda && !cudaUuids.size && cliUuids.size) {
        return { refusal: codedError('E_NOT_SUPPORTED', `${needsCuda}（这台电脑上没有能运行完整引擎的显卡）`) }
      }
      if (model && uuids.size) {
        // A GPU that cannot run the model would only fail the job: it waits for one that can.
        const problems = [...uuids].map((uuid) => {
          const device = inventory.devices.find((item) => item.uuid === uuid)
          return [uuid, device ? bundleGpuProblem(model.bundle, device, { cli: cliUuids.has(uuid), files: model.files }) : '']
        })
        const capable = problems.filter(([, problem]) => problem === null).map(([uuid]) => uuid!)
        if (!capable.length) return { refusal: codedError('E_MODEL', `「${model.bundle.name}」${problems[0]![1]}，请换一个模型`) }
        uuids = new Set(capable)
      }
      return { uuids, cliUuids }
    }
    // A card with too little memory for the model would only fail the job: the GPUs that are big enough come
    // first, the integrated one included. Only when they leave nothing for this job are the small ones tried too.
    const roomy = (device: GpuInventoryDevice): boolean => !gpuMemoryTooSmall(device.memoryTotalBytes)
    const big = await fitting(cliAll.filter(roomy), cudaAll.filter(roomy))
    let chosen = big
    if (!('uuids' in big) || big.uuids.size === 0) {
      const smallOnes = [...cliAll, ...cudaAll].some((device) => !roomy(device))
      if (smallOnes) {
        let all: typeof big
        try {
          all = await fitting(cliAll, cudaAll)
        } catch (error) {
          // The probe failed for a small card only: the big ones' answer stands.
          if ('refusal' in big) throw big.refusal
          throw error
        }
        if ('uuids' in all && all.uuids.size) chosen = all
        else if ('refusal' in big) chosen = big
        else chosen = all
      }
    }
    if ('refusal' in chosen) throw chosen.refusal
    const compatibleUuids = chosen.uuids
    const loads: Record<string, { runningTasks: number; queuedTasks: number }> = {}
    for (const job of jobs.values()) {
      if (!job.deviceUuid || job.hostId || job.engine !== 'mossinfer') continue
      if (job.state !== 'queued' && job.state !== 'starting' && job.state !== 'running') continue
      const current = loads[job.deviceUuid] ?? { runningTasks: 0, queuedTasks: 0 }
      if (job.state === 'queued') current.queuedTasks += 1
      else current.runningTasks += 1
      loads[job.deviceUuid] = current
    }
    for (const slot of activeEngineSlots) {
      if (!slot.startsWith('gpu:')) continue
      const uuid = slot.slice(4)
      const current = loads[uuid] ?? { runningTasks: 0, queuedTasks: 0 }
      current.runningTasks = Math.max(current.runningTasks, 1)
      loads[uuid] = current
    }
    for (const [uuid, count] of pendingAutoGpuAssignments) {
      const current = loads[uuid] ?? { runningTasks: 0, queuedTasks: 0 }
      current.queuedTasks += count
      loads[uuid] = current
    }
    const automatic = selectAutomaticGpu(inventory.devices, compatibleUuids, loads)
    if (automatic) {
      pendingAutoGpuAssignments.set(automatic.uuid, (pendingAutoGpuAssignments.get(automatic.uuid) ?? 0) + 1)
      return automatic
    }
    if (inventory.devices.length && !compatibleUuids.size) {
      throw new Error('当前引擎未报告支持的 GPU；请在引擎页运行设备兼容性测试，或安装兼容的引擎版本。')
    }
    throw new Error(inventory.error ?? '没有可供自动分配的兼容 NVIDIA GPU；请在引擎页检查设备或手动选择 GPU。')
  }
  const device = resolveGpuSelection(inventory.devices, settings.gpuSelection, deviceUuid)
  if (!device) {
    if (deviceUuid) {
      throw new Error('此 Canvas 绑定的 GPU 当前不可用；请重新扫描设备或为 Canvas 重新分配 GPU。')
    }
    if (typeof settings.gpuSelection === 'object') {
      throw new Error('设置中选择的默认 GPU 当前不可用；请在引擎页重新扫描或选择其他设备。')
    }
    throw new Error(inventory.error ?? '没有可用的 NVIDIA GPU；请在引擎页检查设备或选择远端推理引擎。')
  }
  // Picked by hand, a card the plan left without an engine because it is too small for the model (another GPU
  // runs one): say so, and where the pick was made. A card with no engine for any other reason gets the usual error.
  if (!resolveDeviceEngine(device.uuid) && skippedForMemory(device.uuid)) {
    const where = deviceUuid ? '在画面的「显卡」里换一块，或改回跟随默认。' : '在「设置 › 设备与引擎」里改用另一块显卡。'
    throw codedError('E_GPU_TOO_SMALL', `${device.name} 显存太小（${memoryGb(device.memoryTotalBytes ?? 0)} GB），没有安装引擎。${where}`)
  }
  const pickedCli = cliEngineOf(device.uuid)
  if (pickedCli) {
    // Picked by hand (canvas or default GPU): the job must be one this GPU's CLI engine can run.
    const unsupported = cliUnsupported(pickedCli.kind, params)
    if (unsupported) throw codedError('E_NOT_SUPPORTED', `${device.name}：${unsupported}`)
  }
  if ((settings.gpuSelection !== 'auto' || deviceUuid) && !pickedCli) {
    let probe
    try {
      probe = await probeLocalEngineGpuCompatibility()
    } catch (error) {
      throw new Error(
        `无法确认所选 GPU 与当前引擎的兼容性：${error instanceof Error ? error.message : String(error)}。请到引擎页测试设备后重试。`,
      )
    }
    const hello = probe.helloFor(device.uuid)
    if (!hello) throw new Error(`没有为 ${device.name} 安装可用的引擎；请在引擎页安装引擎后重试。`)
    const verdict = judgeEngineSupport(hello, { index: device.index, name: device.name }, { inventoryCapability: device.computeCapability })
    if (!verdict.ok) {
      throw new Error(`当前引擎不支持 ${device.name}：${verdict.reason ?? 'probe 未提供原因'}。请选择其他 GPU 或切换兼容引擎。`)
    }
  }
  return device
}

function gpuSnapshot(device: GpuInventoryDevice): NonNullable<JobRecord['gpuSnapshot']> {
  return {
    index: device.index,
    name: device.name,
    computeCapability: device.computeCapability,
  }
}

/** Generate directly through MossInfer; no Instance, repo worktree or Python runtime. */
export async function startEngineJob(input: StartEngineJobInput): Promise<JobRecord> {
  if (input.canvasTitle !== undefined) {
    const title = typeof input.canvasTitle === 'string' ? input.canvasTitle.trim().slice(0, 120) : ''
    input = { ...input, canvasTitle: title || undefined }
  }
  await loadJobs()
  // A new engine build is being switched in (and the old one stopped): start on the new one.
  if (!input.hostId) await waitForEngineActivation()
  if (!input.prompt.trim()) throw new Error('提示词不能为空')
  if (
    input.canvasLineage !== undefined &&
    (!Array.isArray(input.canvasLineage) || input.canvasLineage.some((id) => typeof id !== 'string' || id.trim().length === 0))
  ) {
    throw new Error('Canvas 来源链无效，请重新加载 Project 后重试。')
  }

  if (input.projectId && input.canvasId) {
    const lineage = [...new Set([input.canvasId, ...(input.canvasLineage ?? [])])]
    const sourceId = input.canvasLineage?.[0] ?? input.canvasId
    const branch = { sourceId, path: new Set(lineage) }
    const activeCanvasJob = [...jobs.values()].find(
      (job) =>
        job.projectId === input.projectId &&
        job.canvasId !== undefined &&
        canvasBranchesConflict(branch, {
          sourceId: job.canvasLineage?.[0] ?? job.canvasId,
          path: new Set([job.canvasId, ...(job.canvasLineage ?? [])]),
        }) &&
        (job.state === 'queued' || job.state === 'starting' || job.state === 'running'),
    )
    const hasConflictingReservation = [...canvasReservations.values()].some((reservation) => canvasBranchesConflict(branch, reservation))
    if (activeCanvasJob || hasConflictingReservation) {
      const state = activeCanvasJob?.state
      throw new Error(`此 Canvas 已有任务${state === 'queued' ? '排队' : '正在运行'}，请等待完成或先取消该任务。`)
    }
    const reservationId = randomUUID()
    canvasReservations.set(reservationId, branch)
    try {
      return await scheduleEngineJob(input)
    } finally {
      canvasReservations.delete(reservationId)
    }
  }

  return scheduleEngineJob(input)
}

async function scheduleEngineJob(input: StartEngineJobInput): Promise<JobRecord> {
  let assignedGpu: GpuInventoryDevice | undefined
  let assignedInput: StartEngineJobInput | undefined
  let pendingAutoUuid: string | undefined
  let acquiredSlot: string | undefined
  const releaseAutoReservation = (): void => {
    if (!pendingAutoUuid) return
    const remaining = (pendingAutoGpuAssignments.get(pendingAutoUuid) ?? 1) - 1
    if (remaining > 0) pendingAutoGpuAssignments.set(pendingAutoUuid, remaining)
    else pendingAutoGpuAssignments.delete(pendingAutoUuid)
    pendingAutoUuid = undefined
  }
  const settings = getSettings()
  try {
    let model: { bundle: ModelBundle; files: boolean } | undefined
    if (!input.hostId && input.modelBinding) {
      const catalog = await getCatalog(settings)
      const bundle = catalog.bundles.find((item) => item.id === input.modelBinding!.bundleId)
      if (bundle) model = { bundle, files: isFileBundle(bundle, catalog.models) }
    }
    if (input.hostId) {
      assignedInput = { ...input, deviceUuid: undefined }
    } else {
      assignedGpu = await resolveLocalGpu(input.deviceUuid, paramsOf(input), model)
      if (!input.deviceUuid && settings.gpuSelection === 'auto') pendingAutoUuid = assignedGpu.uuid
      assignedInput = { ...input, deviceUuid: assignedGpu.uuid, deviceId: `cuda:${assignedGpu.index}` }
    }

    if (!assignedInput) throw new Error('推理任务设备解析失败。')
    const slot = engineSlotKey(assignedInput)
    if (!slot) throw new Error('无法确定推理设备资源槽；请重新选择 GPU 后重试。')
    const gpuProfile = assignedGpu ? profileForBundle(resolveGpuProfile(settings, assignedGpu), model?.bundle) : undefined
    const queue = engineQueues.get(slot) ?? []
    if (activeEngineSlots.has(slot) || queue.length > 0) {
      const params = paramsOf(input)
      const job: JobRecord = {
        id: `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
        instanceId: 'engine',
        instanceName: input.modelName ?? 'MossInfer',
        workspace: 'clover',
        projectId: assignedInput.projectId,
        canvasId: assignedInput.canvasId,
        canvasLineage: assignedInput.canvasLineage,
        canvasTitle: assignedInput.canvasTitle,
        deviceId: assignedInput.deviceId,
        deviceUuid: assignedInput.deviceUuid,
        gpuSnapshot: assignedGpu ? gpuSnapshot(assignedGpu) : undefined,
        gpuProfile,
        hostId: assignedInput.hostId,
        kind: 'inference',
        mode: 'runner',
        engine: 'mossinfer',
        state: 'queued',
        stage: 'idle',
        params,
        progress: { stage: 'idle', current: 0, total: params.steps, percent: 0 },
        queuePosition: queue.length + 1,
        // How many pictures this one has to wait for; the card says so after it runs.
        queuedBehind: queue.length + (activeEngineSlots.has(slot) ? 1 : 0),
        startedAt: new Date().toISOString(),
      }
      job.logPath = logPath(job.id)
      jobs.set(job.id, job)
      logs.set(job.id, [])
      seqs.set(job.id, 0)
      update(job, {})
      queue.push({ input: assignedInput, job })
      engineQueues.set(slot, queue)
      refreshQueuePositions(slot)
      if (!activeEngineSlots.has(slot)) scheduleEngineQueue(slot)
      return snapshot(job)
    }

    activeEngineSlots.add(slot)
    acquiredSlot = slot
    return await startEngineJobNow(assignedInput)
  } finally {
    releaseAutoReservation()
    if (acquiredSlot) {
      const slotHasRunningJob = [...running.keys()].some((id) => {
        const job = jobs.get(id)
        return job !== undefined && engineSlotKey(job) === acquiredSlot
      })
      if (!slotHasRunningJob) activeEngineSlots.delete(acquiredSlot)
      if (!activeEngineSlots.has(acquiredSlot) && engineQueues.get(acquiredSlot)?.length) {
        scheduleEngineQueue(acquiredSlot)
      }
    }
  }
}

async function startEngineJobNow(input: StartEngineJobInput, queuedJob?: JobRecord): Promise<JobRecord> {
  await loadJobs()
  const settings = getSettings()
  if (!input.prompt.trim()) throw new Error('提示词不能为空')

  let modelPath: string | undefined
  let modelSnapshot: unknown
  let modelFiles: { ditFile?: string; textEncoderFile?: string; vaeFile?: string } = {}
  let modelBundle: ModelBundle | undefined
  const cliEngine = input.hostId ? null : cliEngineOf(input.deviceUuid)
  if (input.hostId && input.modelBinding) {
    // Another computer runs the model folder at its remote path; single files load only here.
    const catalog = await getCatalog(settings)
    const bundle = catalog.bundles.find((item) => item.id === input.modelBinding!.bundleId)
    if (bundle && isFileBundle(bundle, catalog.models)) {
      throw codedError('E_MODEL', `「${bundle.name}」只能在这台电脑上运行，在其他电脑上请用官方模型`)
    }
  }
  if (!input.hostId) {
    if (input.modelBinding && cliEngine) {
      // A CLI engine reads a bf16 bundle folder: say so before anything is materialized or started.
      const catalog = await getCatalog(settings)
      const bundle = catalog.bundles.find((item) => item.id === input.modelBinding!.bundleId)
      const problem = cliBundleProblem(
        cliEngine.kind,
        { name: bundle?.name ?? input.modelName ?? input.modelBinding.bundleId, components: input.modelBinding },
        catalog.models,
      )
      if (problem) throw codedError('E_MODEL', problem)
    }
    if (input.modelBinding) {
      const source = await prepareModelSource(input.modelBinding, settings)
      modelPath = source.model
      modelBundle = source.bundle
      const manifest = JSON.parse(await readFile(join(modelPath, 'clover_model.json'), 'utf8')) as Record<string, unknown>
      const files = Object.fromEntries(
        Object.entries({ ditFile: source.ditFile, textEncoderFile: source.textEncoderFile, vaeFile: source.vaeFile }).filter(
          ([, path]) => path,
        ),
      )
      modelSnapshot = Object.keys(files).length ? { ...manifest, files } : manifest
      modelFiles = {
        ditFile: source.ditFile,
        textEncoderFile: source.textEncoderFile,
        vaeFile: source.vaeFile,
      }
    } else {
      modelPath = (await resolveLegacyModelPath(join(paths.hub(settings.modelsRoot), 'models--OpenMOSS-Team--MOSS-Image-SFT'))) ?? undefined
    }
    // Single files replace the folder's weights; the engine still reads its configs and tokenizer.
    if (!modelPath) {
      throw new Error('模型权重尚未就绪，请先在模型库下载 MOSS-Image，或扫描本地模型文件')
    }
    if (cliEngine && modelPath) {
      // The catalog may not describe every file: the weights themselves must be bf16.
      const dtypeProblem = await cliBundleDtypeProblem(cliEngine.kind, modelPath)
      if (dtypeProblem) throw codedError('E_MODEL', dtypeProblem)
    }
  }

  const localGpu = input.hostId ? null : await resolveLocalGpu(input.deviceUuid, paramsOf(input))
  if (localGpu && !cliEngineOf(localGpu.uuid)) {
    // Each GPU runs the moss-server of its own package (engineInstalls.ts).
    const serverPath = localServerPath(localGpu.uuid)
    if (!serverPath || !existsSync(serverPath)) throw new Error('未找到 moss-server；请先在引擎页下载或配置引擎')
  }
  const resolvedDeviceId = localGpu ? `cuda:${localGpu.index}` : input.deviceId
  if (localGpu && modelBundle && !cliEngineOf(localGpu.uuid)) {
    const problem = bundleGpuProblem(modelBundle, localGpu)
    if (problem) throw codedError('E_MODEL', `「${modelBundle.name}」${problem}，请换一个模型`)
  }
  // The tier asked for, settled by the weights this job loads (an INT8 DiT runs High, INT4 Turbo).
  // When the engine has no name for them (NVFP4, or no inspect), the bundle's own tier decides.
  const requestedProfile = localGpu ? (queuedJob?.gpuProfile ?? resolveGpuProfile(settings, localGpu)) : undefined
  let gpuProfile: ResolvedGpuProfile | undefined
  if (localGpu && requestedProfile) {
    const weights: WeightPrecisions = cliEngine
      ? { dit: 'bf16', textEncoder: 'bf16' }
      : await jobWeightPrecisions(modelFiles, localGpu.uuid)
    const known = weights.dit !== null && weights.textEncoder !== null
    gpuProfile =
      modelBundle?.tier && !known ? profileForBundle(requestedProfile, modelBundle) : withWeightTier(requestedProfile, weights, localGpu)
  }
  const executionSettings = gpuProfile ? settingsForGpuProfile(settings, gpuProfile) : settings

  if (input.hostId) {
    const host = getTrainingHost(settings, input.hostId)
    if (!host || host.kind !== 'ssh') throw new Error('远端引擎主机不存在')
    if (!input.remoteModelPath?.trim()) throw new Error('远端模型路径未配置')
    const outputRoot = await remoteAbsolute(host, host.outputRoot ?? '~/.mossstudio/outputs')
    const remoteOutput = `${outputRoot.replace(/\/$/, '')}/${Date.now().toString(36)}-${randomUUID().slice(0, 6)}.png`
    const localOutput = join(paths.outputs(), `${channelSafe(host.id)}-${Date.now().toString(36)}.png`)
    const params = paramsOf(input)
    const job: JobRecord = queuedJob ?? {
      id: `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      instanceId: 'engine',
      instanceName: input.modelName ?? host.name,
      workspace: 'clover',
      projectId: input.projectId,
      canvasId: input.canvasId,
      canvasLineage: input.canvasLineage,
      canvasTitle: input.canvasTitle,
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
    if (queuedJob && canceledBeforeStart.delete(queuedJob.id)) return snapshot(queuedJob)
    Object.assign(job, {
      instanceName: input.modelName ?? host.name,
      projectId: input.projectId,
      canvasId: input.canvasId,
      canvasLineage: input.canvasLineage,
      canvasTitle: input.canvasTitle,
      deviceId: input.deviceId,
      hostId: host.id,
      state: 'starting' as const,
      params,
      progress: { stage: 'idle' as const, current: 0, total: params.steps, percent: 0 },
      queuePosition: undefined,
      // It is this job's turn now: the wait is over, the run starts here.
      runStartedAt: new Date().toISOString(),
      preview: undefined,
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
    const runningJob: RunningJob = {
      child: undefined,
      out: new LineSplitter(),
      err: new LineSplitter(),
      readyTimer,
      lastLines: [],
      cancelRequested: false,
    }
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
        jobId: job.id,
      },
      {
        event: (payload) => handleRunnerEvent(job, runningJob, JSON.stringify(payload)),
        stderr: (line) => appendLog(job, 'stderr', line, runningJob),
        done: (code) => finish(job, runningJob, code),
      },
    ).catch((error: unknown) => {
      handleRunnerEvent(
        job,
        runningJob,
        JSON.stringify({ type: 'error', code: 'E_REMOTE', message: String(error instanceof Error ? error.message : error), fatal: true }),
      )
      finish(job, runningJob, -1)
    })
    return snapshot(job)
  }

  const params = paramsOf(input)
  const job: JobRecord = queuedJob ?? {
    id: `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    instanceId: 'engine',
    instanceName: input.modelName ?? 'MossInfer',
    workspace: 'clover',
    projectId: input.projectId,
    canvasId: input.canvasId,
    canvasLineage: input.canvasLineage,
    canvasTitle: input.canvasTitle,
    modelSnapshot,
    deviceId: resolvedDeviceId,
    deviceUuid: localGpu?.uuid,
    gpuSnapshot: localGpu ? gpuSnapshot(localGpu) : undefined,
    gpuProfile,
    kind: 'inference',
    mode: 'runner',
    engine: 'mossinfer',
    state: 'starting',
    stage: 'idle',
    params,
    progress: { stage: 'idle', current: 0, total: params.steps, percent: 0 },
    startedAt: new Date().toISOString(),
  }
  if (queuedJob && canceledBeforeStart.delete(queuedJob.id)) return snapshot(queuedJob)
  Object.assign(job, {
    instanceName: input.modelName ?? 'MossInfer',
    projectId: input.projectId,
    canvasId: input.canvasId,
    canvasLineage: input.canvasLineage,
    canvasTitle: input.canvasTitle,
    deviceId: resolvedDeviceId,
    deviceUuid: localGpu?.uuid,
    gpuSnapshot: localGpu ? gpuSnapshot(localGpu) : undefined,
    gpuProfile,
    modelSnapshot,
    state: 'starting' as const,
    params,
    progress: { stage: 'idle' as const, current: 0, total: params.steps, percent: 0 },
    queuePosition: undefined,
    // It is this job's turn now: the wait is over, the run starts here.
    runStartedAt: new Date().toISOString(),
    preview: undefined,
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
  if (canceledBeforeStart.delete(job.id)) return snapshot(job)
  const readyTimer = setTimeout(() => {
    if (job.state === 'starting') {
      pushDiagnostic({
        jobId: job.id,
        ruleId: 'E_TIMEOUT',
        severity: 'error',
        title: '启动超时',
        explain: 'moss-server 在 180 秒内没有就绪，通常是引擎启动或模型加载失败。',
        solutions: [
          { label: '查看日志', action: 'open_log' },
          { label: '打开引擎', action: 'open_settings' },
        ],
        raw: 'ready timeout',
        signature: `E_TIMEOUT:${job.id}`,
      })
      update(job, { state: 'failed', error: { code: 'E_TIMEOUT', message: '启动超时' } })
      restartOwnRuntime(job)
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
  const output = join(outputDir, `${job.id}-1.png`)
  const sink = {
    event: (payload: Record<string, unknown>) => handleRunnerEvent(job, runningJob, JSON.stringify(payload)),
    stderr: (line: string) => appendLog(job, 'stderr', line, runningJob),
    done: (code: number) => finish(job, runningJob, code),
  }
  if (cliEngine) {
    const gpu = localGpu!
    const gfxTarget = gpu.gfxTarget ?? cliEngine.gfxTarget
    runningJob.cli = true
    appendLog(job, 'system', `引擎：${CLI_ENGINE_LABEL[cliEngine.kind]}（${cliEngine.binaryPath}，${cliEngine.version}）`, runningJob)
    void (async () => {
      // A moss-server left from when this GPU ran CUDA would hold its memory through the whole job.
      const released = await releaseStaleMossInferRuntimes(gpu.uuid)
      if (released.length) appendLog(job, 'system', '已停止这张显卡上之前的 CUDA 引擎，释放显存', runningJob)
      let cliDeviceIndex = cliEngine.kind === 'vulkan' ? cliEngine.vulkanIndex : undefined
      if (cliEngine.kind === 'hip') {
        const found = await hipIndexOf(cliEngine, gpu)
        if (!found.ok) {
          handleRunnerEvent(job, runningJob, JSON.stringify({ type: 'error', code: 'E_DEVICE', message: found.message, fatal: true }))
          finish(job, runningJob, 1)
          return
        }
        cliDeviceIndex = found.index
      }
      // Canceled while the device was being looked up: the program is never started.
      if (runningJob.cancelRequested) {
        handleRunnerEvent(job, runningJob, JSON.stringify({ type: 'canceled', at_stage: 'idle' }))
        finish(job, runningJob, 130)
        return
      }
      await runCliJob(
        job,
        params,
        {
          kind: cliEngine.kind,
          binary: cliEngine.binaryPath,
          version: cliEngine.version,
          model: modelPath ?? '',
          output,
          deviceUuid: gpu.uuid,
          cliDeviceIndex,
          // Vulkan prints the name its own --list-devices gave that index; HIP its own name, checked with the gfx target.
          expectedDevice: {
            name: (cliEngine.kind === 'vulkan' ? cliEngine.expectedVulkanName : undefined) ?? gpu.name,
            ...(gfxTarget ? { gfxTarget } : {}),
          },
          ...(cliEngine.env ? { env: cliEngine.env } : {}),
        },
        sink,
      )
    })().catch((error: unknown) => {
      handleRunnerEvent(
        job,
        runningJob,
        JSON.stringify({ type: 'error', code: 'E_ENGINE', message: String(error instanceof Error ? error.message : error), fatal: true }),
      )
      finish(job, runningJob, -1)
    })
    return snapshot(job)
  }
  void runMossInferJob(
    job,
    params,
    {
      model: modelPath ?? '',
      device: 0,
      deviceUuid: localGpu!.uuid,
      systemDeviceIndex: localGpu!.index,
      loras: params.adapters ?? [],
      output,
      previewOutput: jobPreviewPath(job.id),
      settings: executionSettings,
      ...modelFiles,
    },
    sink,
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
  for (const [slot, queue] of engineQueues) {
    const queuedIndex = queue.findIndex((entry) => entry.job.id === id)
    if (queuedIndex < 0) continue
    queue.splice(queuedIndex, 1)
    if (!queue.length) engineQueues.delete(slot)
    update(job, { state: 'canceled', queuePosition: undefined, endedAt: new Date().toISOString() })
    refreshQueuePositions(slot)
    notifyCompleted(job)
    if (queue.length) scheduleEngineQueue(slot)
    return snapshot(job)
  }
  if (!runningJob) {
    if (job.state === 'queued' || job.state === 'running' || job.state === 'starting') {
      // On its way to the engine: startEngineJobNow sees this and stops before starting it.
      canceledBeforeStart.add(job.id)
      update(job, { state: 'canceled', queuePosition: undefined, endedAt: new Date().toISOString() })
      notifyCompleted(job)
    }
    return snapshot(job)
  }
  runningJob.cancelRequested = true
  appendLog(job, 'system', '正在停止任务…', runningJob)
  if (job.engine === 'mossinfer' && job.hostId) {
    // Its own SSH session carries the cancel (and is closed if the host does not confirm); local engines are not involved.
    cancelRemoteEngineJob(job.id)
    return snapshot(job)
  }
  // A CLI engine terminates its own process (then kills it after a grace period).
  // Not handed to the CLI engine yet (device lookup): the dispatch sees cancelRequested and never starts it.
  if (job.engine === 'mossinfer' && (cancelCliJob(job.id) || runningJob.cli)) return snapshot(job)
  if (job.engine === 'mossinfer') {
    cancelMossInferJob(job.id)
    // server 卡死兜底：5 秒后仍无 done-cancelled 则重启该 GPU 的引擎，exit 处理会失败活动任务
    runningJob.killTimer = setTimeout(() => restartOwnRuntime(job), 5000)
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
  // Waits for the save in flight and the one more it makes for this change.
  if (removed) await saveJobs()
  return removed
}

/** Every input picture a waiting or running job will read (masks, start pictures…): they must stay on disk. */
export function activeJobInputPaths(): string[] {
  return [...jobs.values()]
    .filter((job) => job.state === 'queued' || job.state === 'starting' || job.state === 'running')
    .flatMap((job) => jobInputFiles(job.params).map((file) => file.path))
}

export async function listJobs(): Promise<JobRecord[]> {
  await loadJobs()
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(snapshot)
}

export async function getGpuJobCounts(): Promise<Record<string, { runningTasks: number; queuedTasks: number }>> {
  await loadJobs()
  const counts: Record<string, { runningTasks: number; queuedTasks: number }> = {}
  for (const job of jobs.values()) {
    if (!job.deviceUuid || job.hostId || job.engine !== 'mossinfer') continue
    if (job.state !== 'queued' && job.state !== 'starting' && job.state !== 'running') continue
    const count = counts[job.deviceUuid] ?? { runningTasks: 0, queuedTasks: 0 }
    if (job.state === 'queued') count.queuedTasks += 1
    else count.runningTasks += 1
    counts[job.deviceUuid] = count
  }
  return counts
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
