import type {
  DownloadTask,
  EnginePlanView,
  EngineReadiness,
  GpuInventorySnapshot,
  GpuSelection,
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
import { bytes } from '../../lib/format'
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
 * - blocked: no GPU the engine runs on (or macOS), nothing can be prepared here
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
}

/** Rough size of an engine package, for the "需要约 N GB" sentence. */
export const ENGINE_ESTIMATE_BYTES = 400 * 1024 ** 2

function gpuStep(input: SetupInput): SetupStep {
  const base = { id: 'gpu' as const, title: '检测 GPU' }
  const { gpu, plan } = input
  if (plan?.blocked) return { ...base, state: 'blocked', detail: plan.blocked }
  if (!gpu || plan === null) return { ...base, state: 'running', detail: '正在检测显卡…' }
  if (gpu.status === 'ok' && gpu.devices.length > 0) {
    const uuid = defaultGpuUuid(gpu, input.gpuSelection)
    const device = gpu.devices.find((item) => item.uuid === uuid) ?? gpu.devices[0]!
    const more = gpu.devices.length > 1 ? ` · 共 ${gpu.devices.length} 块` : ''
    return { ...base, state: 'done', detail: `${device.name} · ${gpuMemoryLabel(device)}${more}` }
  }
  if (gpu.status === 'error') {
    return { ...base, state: 'blocked', detail: `检测显卡失败：${gpu.error ?? '未知原因'}` }
  }
  return { ...base, state: 'blocked', detail: '没有找到 NVIDIA 显卡' }
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
  let phase: SetupPhase
  if (steps.every((step) => step.state === 'done')) phase = 'done'
  else if (gpu.state === 'blocked') phase = 'blocked'
  // Detecting the GPU is part of checking; only installs and downloads count as running.
  else if (steps.some((step) => step.id !== 'gpu' && step.state === 'running')) phase = 'running'
  else if (steps.some((step) => step.state === 'error')) phase = 'error'
  else if (!input.gpu || input.plan === null || !input.onboarding || !input.engine) phase = 'checking'
  else phase = 'idle'
  return { steps, phase, modelBytes, engineBytes, lines, ...(input.plan ? { os: input.plan.os } : {}) }
}

/** "需要约 13 GB 空间" — counts only what is still missing. */
export function setupSpaceLabel(view: SetupView): string | null {
  const engineMissing = view.steps.find((step) => step.id === 'engine')?.state !== 'done'
  const total = view.modelBytes + (engineMissing ? view.engineBytes : 0)
  if (total <= 0) return null
  const gb = total / 1024 ** 3
  return gb >= 1 ? `约 ${Math.ceil(gb)} GB` : `约 ${Math.ceil(total / 1024 ** 2)} MB`
}

/** Which steps 开始准备 / 重试 should (re)start. */
export function stepsToStart(view: SetupView): SetupStepId[] {
  return view.steps.filter((step) => step.id !== 'gpu' && (step.state === 'waiting' || step.state === 'error')).map((step) => step.id)
}
