import { MIN_GPU_MEMORY_BYTES, dedicatedGpuMemory, shortDisks, slowReason, tooLittleGpuMemory } from '@shared/machineFit'
import type {
  DownloadTask,
  EnginePlanView,
  EngineReadiness,
  GpuInventoryDevice,
  GpuInventorySnapshot,
  GpuSelection,
  ModelSpaceDisk,
  MossInferDownloadState,
  OnboardingStatus,
} from '@shared/types'
import {
  engineDownloadActive,
  engineDownloadLabel,
  engineDownloadPercent,
  engineInstallError,
  planLines,
  planMissingBytes,
  type PlanLine,
} from '../../lib/engineInstall'
import { bytes, diskFree, diskNeeded, memorySize } from '../../lib/format'
import { defaultGpuUuid, gpuMemoryLabel } from '../settings/devicesModel'

export type SetupStepId = 'gpu' | 'engine' | 'model'
export type SetupStepState = 'waiting' | 'running' | 'done' | 'error' | 'blocked'

export interface SetupStep {
  id: SetupStepId
  title: string
  state: SetupStepState
  detail: string
  /** 0–100 while there is measurable progress. */
  percent?: number
}

/**
 * - checking: still reading what is already on this computer
 * - idle: ready for 开始准备
 * - running: something is being installed or downloaded
 * - done: everything is in place, 开始创作 is available
 * - blocked: no GPU the engine runs on, or too little GPU memory (or macOS); nothing can be prepared here
 * - error: a step failed and needs 重试
 */
export type SetupPhase = 'checking' | 'idle' | 'running' | 'done' | 'blocked' | 'error'

export interface SetupInput {
  gpu: GpuInventorySnapshot | null
  gpuSelection?: GpuSelection
  engine: EngineReadiness | null
  /** What the machine probe found and which package each GPU gets; null while it runs, undefined when it failed. */
  plan?: EnginePlanView | null
  engineDownload: MossInferDownloadState | null
  /** Failure before the download started (e.g. outdated driver) or of the IPC call itself. */
  engineError?: string | null
  onboarding: OnboardingStatus | null
  downloads: DownloadTask[]
  modelError?: string | null
  /** Installed system memory; undefined while not known. */
  systemMemoryBytes?: number
  /** The disks the missing model parts land on (models:space); undefined while not known. */
  disks?: ModelSpaceDisk[]
}

export interface SetupView {
  steps: SetupStep[]
  phase: SetupPhase
  /** Bytes still to download for the recommended model. */
  modelBytes: number
  /** Bytes still to download for the engine packages (an estimate before the plan is known). */
  engineBytes: number
  /** One line per GPU: what runs on it and what will be downloaded. */
  lines: PlanLine[]
  /** From the plan; macOS never runs the engine locally. */
  os?: EnginePlanView['os']
  /** It runs, but slowly: the one most important reason, for the GPU line. */
  slow?: string
  /** The chosen folder has too little room for the download. */
  diskShort?: string
  /** Blocked because the GPU has too little memory, not because nothing runs on it. */
  memoryBlocked?: boolean
}

/** Rough size of an engine package, for the "需要约 N GB" sentence. */
export const ENGINE_ESTIMATE_BYTES = 400 * 1024 ** 2

/** The GPU the GPU line names: the one chosen in settings, else the recommended one. */
function lineDevice(input: SetupInput): GpuInventoryDevice | null {
  const { gpu } = input
  if (gpu?.status !== 'ok' || gpu.devices.length === 0) return null
  const uuid = defaultGpuUuid(gpu, input.gpuSelection)
  return gpu.devices.find((item) => item.uuid === uuid) ?? gpu.devices[0]!
}

/** This GPU runs the Vulkan engine (兼容模式). */
function compatibilityMode(plan: EnginePlanView | null | undefined, device: GpuInventoryDevice): boolean {
  return plan?.choices.find((choice) => choice.gpuId === device.uuid)?.package?.kind === 'vulkan'
}

function gpuStep(input: SetupInput): SetupStep {
  const base = { id: 'gpu' as const, title: '检测 GPU' }
  const { gpu, plan } = input
  if (plan?.blocked) return { ...base, state: 'blocked', detail: plan.blocked }
  if (!gpu || plan === null) return { ...base, state: 'running', detail: '正在检测显卡…' }
  const small = plan ? tooLittleGpuMemory(plan) : null
  if (small) {
    return {
      ...base,
      state: 'blocked',
      detail: `${small.name} 只有 ${memorySize(small.bytes)} 显存，至少需要 ${memorySize(MIN_GPU_MEMORY_BYTES)}。`,
    }
  }
  const device = lineDevice(input)
  if (device) {
    const mode = compatibilityMode(plan, device) ? ' · 兼容模式' : ''
    const more = gpu.devices.length > 1 ? ` · 共 ${gpu.devices.length} 块` : ''
    return { ...base, state: 'done', detail: `${device.name} · ${gpuMemoryLabel(device)}${mode}${more}` }
  }
  if (gpu.status === 'error') {
    return { ...base, state: 'blocked', detail: `检测显卡失败：${gpu.error ?? '未知原因'}` }
  }
  return { ...base, state: 'blocked', detail: '没有找到能用的显卡' }
}

/** It runs, but slowly: one line for the GPU line, the most important reason only. */
function slowLine(input: SetupInput, device: GpuInventoryDevice): string | null {
  const machineGpu = input.plan?.machine.gpus.find((gpu) => gpu.id === device.uuid)
  // Without the machine probe only nvidia-smi rows (no vendor) are known, and their memory is the card's own.
  const gpuMemoryBytes = machineGpu ? dedicatedGpuMemory(machineGpu) : device.vendor ? null : device.memoryTotalBytes
  const reason = slowReason({
    compatibility: compatibilityMode(input.plan, device),
    gpuMemoryBytes,
    systemMemoryBytes: input.systemMemoryBytes,
  })
  switch (reason?.kind) {
    case undefined:
      return null
    case 'compatibility':
      return '能用，但会很慢：一张图可能要几分钟甚至更久。'
    case 'gpuMemory':
      return `显存 ${memorySize(reason.bytes)}，能用，生成会慢一些。`
    case 'systemMemory':
      return `内存 ${memorySize(reason.bytes)}，能用，生成会慢一些。`
  }
}

function engineStep(input: SetupInput, gpuReady: boolean): SetupStep {
  const base = { id: 'engine' as const, title: '安装引擎' }
  const download = input.engineDownload
  if (engineDownloadActive(download)) {
    const percent = engineDownloadPercent(download!)
    return {
      ...base,
      state: 'running',
      detail: `MossInfer · ${engineDownloadLabel(download!)}`,
      ...(percent === null ? {} : { percent }),
    }
  }
  const missing = input.plan?.missing ?? []
  if (input.engine?.state === 'ready' && missing.length === 0) return { ...base, state: 'done', detail: 'MossInfer 已安装' }
  const error = input.engineError ?? engineInstallError(input.engine, download)
  if (error && input.engine?.state !== 'ready') return { ...base, state: 'error', detail: error }
  if (download?.phase === 'canceled' && input.engine?.state !== 'ready') return { ...base, state: 'error', detail: '安装已取消' }
  if (!input.engine) return { ...base, state: 'waiting', detail: '正在检查…' }
  const plan = input.plan
  let detail = '推理引擎 MossInfer，会按你的显卡自动选择版本'
  if (plan && missing.length > 0) {
    const size = bytes(planMissingBytes(plan))
    detail =
      input.engine.state === 'ready'
        ? `还需为其他显卡下载 ${missing.length} 个引擎包 · ${size}`
        : missing.length === 1
          ? `MossInfer · ${size}`
          : `MossInfer · ${missing.length} 个引擎包，共 ${size}`
  }
  return { ...base, state: gpuReady ? 'waiting' : 'blocked', detail }
}

/** Downloads that belong to the recommended local model. */
export function modelDownloads(onboarding: OnboardingStatus | null, downloads: DownloadTask[]): DownloadTask[] {
  const ids = new Set(onboarding?.steps.find((step) => step.id === 'model')?.modelIds ?? [])
  return downloads.filter((task) => task.kind === 'model' && !task.hostId && ids.has(task.targetId))
}

function modelStep(input: SetupInput, gpuReady: boolean): SetupStep {
  const base = { id: 'model' as const, title: '下载推荐模型' }
  const step = input.onboarding?.steps.find((item) => item.id === 'model')
  const name = input.onboarding?.bundleName ?? '推荐模型'
  if (!step) return { ...base, state: 'waiting', detail: '正在检查…' }
  if (step.status === 'ok') return { ...base, state: 'done', detail: `${name} 已就绪` }
  const tasks = modelDownloads(input.onboarding, input.downloads)
  const active = tasks.filter((task) => ['queued', 'running', 'verifying'].includes(task.state))
  const failed = tasks.find((task) => task.state === 'error')
  const total = tasks.reduce((sum, task) => sum + task.totalBytes, 0)
  const done = tasks.reduce((sum, task) => sum + (task.state === 'done' ? task.totalBytes : task.bytes), 0)
  if (active.length > 0) {
    const percent = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : undefined
    const label = active.every((task) => task.state === 'queued')
      ? '排队中'
      : total > 0
        ? `正在下载 ${bytes(done)} / ${bytes(total)}`
        : '正在下载'
    return { ...base, state: 'running', detail: `${name} · ${label}`, ...(percent === undefined ? {} : { percent }) }
  }
  const error = input.modelError ?? failed?.error ?? (failed ? '下载失败' : null)
  if (error) return { ...base, state: 'error', detail: error }
  if (tasks.some((task) => task.state === 'paused')) return { ...base, state: 'error', detail: `${name} · 下载已暂停` }
  const size = step.sizeBytes ? ` · ${bytes(step.sizeBytes)}` : ''
  return { ...base, state: gpuReady ? 'waiting' : 'blocked', detail: `${name}${size}` }
}

export function deriveSetup(input: SetupInput): SetupView {
  const gpu = gpuStep(input)
  const gpuReady = gpu.state === 'done'
  const steps = [gpu, engineStep(input, gpuReady), modelStep(input, gpuReady)]
  const modelBytes = input.onboarding?.steps.find((step) => step.id === 'model')?.sizeBytes ?? 0
  const engineBytes = input.plan ? planMissingBytes(input.plan) : ENGINE_ESTIMATE_BYTES
  const lines = input.plan && !input.plan.blocked ? planLines(input.plan) : []
  const device = gpuReady ? lineDevice(input) : null
  const slow = device ? slowLine(input, device) : null
  let phase: SetupPhase
  if (steps.every((step) => step.state === 'done')) phase = 'done'
  else if (gpu.state === 'blocked') phase = 'blocked'
  // Detecting the GPU is part of checking; only installs and downloads count as running.
  else if (steps.some((step) => step.id !== 'gpu' && step.state === 'running')) phase = 'running'
  else if (steps.some((step) => step.state === 'error')) phase = 'error'
  else if (!input.gpu || input.plan === null || !input.onboarding || !input.engine) phase = 'checking'
  else phase = 'idle'
  const view: SetupView = {
    steps,
    phase,
    modelBytes,
    engineBytes,
    lines,
    ...(input.plan ? { os: input.plan.os } : {}),
    ...(slow ? { slow } : {}),
    ...(gpu.state === 'blocked' && input.plan && !input.plan.blocked && tooLittleGpuMemory(input.plan) ? { memoryBlocked: true } : {}),
  }
  const diskShort = setupDiskShort(input.disks)
  return diskShort ? { ...view, diskShort } : view
}

/** Bytes still to download: the model, plus the engine while it is not done. */
function setupDownloadBytes(view: SetupView): number {
  const engineMissing = view.steps.find((step) => step.id === 'engine')?.state !== 'done'
  return view.modelBytes + (engineMissing ? view.engineBytes : 0)
}

/**
 * A disk the model cannot fit on: what it has and what to look for. Each part
 * asks for the room its own download checks for on start, and parts on one disk
 * add up. The engine package goes to the app's data folder and has its own check.
 */
function setupDiskShort(disks: ModelSpaceDisk[] | undefined): string | null {
  const short = shortDisks(disks ?? []).sort((a, b) => Number(b.modelsFolder) - Number(a.modelsFolder))[0]
  if (!short) return null
  if (short.modelsFolder) return `这个位置只剩 ${diskFree(short.freeBytes)}，换一个有 ${diskNeeded(short.neededBytes)} 空闲的位置。`
  // A part with its own folder (设置 › 存储) does not move with 更改.
  return `${short.path} 只剩 ${diskFree(short.freeBytes)}，需要 ${diskNeeded(short.neededBytes)} 空闲：到「设置 › 存储」给它换个位置。`
}

/** What a computer needs, under the reason it is blocked; null on a Mac, which has its own sentence. */
export function setupNeedLine(view: SetupView): string | null {
  if (view.os === 'macos') return null
  return view.memoryBlocked
    ? `需要显存至少 ${memorySize(MIN_GPU_MEMORY_BYTES)} 的显卡：NVIDIA RTX 30 及更新，或支持 Vulkan 1.2 的显卡。`
    : '需要 NVIDIA RTX 30 及更新的显卡，或支持 Vulkan 1.2 的显卡。'
}

/** "需要约 13 GB 空间" — counts only what is still missing. */
export function setupSpaceLabel(view: SetupView): string | null {
  const total = setupDownloadBytes(view)
  if (total <= 0) return null
  const gb = total / 1024 ** 3
  return gb >= 1 ? `约 ${Math.ceil(gb)} GB` : `约 ${Math.ceil(total / 1024 ** 2)} MB`
}

/** Which steps 开始准备 / 重试 should (re)start. */
export function stepsToStart(view: SetupView): SetupStepId[] {
  return view.steps.filter((step) => step.id !== 'gpu' && (step.state === 'waiting' || step.state === 'error')).map((step) => step.id)
}
