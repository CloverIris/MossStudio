import { useCallback, useRef, useState } from 'react'
import type { BackendInfo } from '@shared/backend'
import type { Catalog, ControlAdapterEntry, EngineFeatures, JobRecord, ManagedHost, ProjectCanvas } from '@shared/types'
import { Ipc } from '@shared/channels'
import { activeCanvasBranchIds, canvasLineage } from '@shared/canvasJobBranch'
import { adapterStatuses, normalizeCanvasAdapters } from '@shared/adapters'
import { call } from '../../lib/api'
import { electronStudioClient } from '../../lib/studioClient'
import { useApp } from '../../store'
import { taskCanvasFor } from './canvases'
import { profileFor, randomSeed, seedForRun } from './defaults'
import { resolveJobInputs } from './jobInputs'
import { compileCanvasPrompt } from './prompt'
import { resolveBundle } from './readiness'
import type { StudioProject } from './useStudioProject'

export type SeedMode = 'auto' | 'new' | 'same'

function isJobRecord(value: unknown): value is JobRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['state'] === 'string' &&
    ['queued', 'starting', 'running', 'succeeded', 'failed', 'canceled'].includes(record['state'])
  )
}

function errorMessage(body: unknown, status: number): string {
  const raw = body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : undefined
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && 'message' in raw && typeof (raw as { message: unknown }).message === 'string') {
    return (raw as { message: string }).message
  }
  return `生成服务返回了错误（${status}）`
}

/**
 * Submitting a run. Reads the canvas from live state at call time, so a
 * description written a moment earlier (by the user or the assistant) is
 * always the one that is sent.
 */
export function useGenerate(options: {
  project: StudioProject
  catalog: Catalog | null
  preferredBundleId: string | null
  remoteHost: ManagedHost | null
  /** Registered control adapters (a canvas's control adapter id resolves to its file). */
  controlAdapters?: readonly ControlAdapterEntry[]
  controlAdaptersLoaded?: boolean
  notify: (message: string, tone: 'info' | 'success' | 'error') => void
}): {
  submitting: boolean
  generate: (canvasId?: string, seed?: SeedMode) => Promise<{ queued: boolean; canvasId?: string; jobId?: string; error?: string }>
} {
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const backend = useRef<BackendInfo | null>(null)
  const latest = useRef(options)
  latest.current = options

  const generate = useCallback(async (canvasId?: string, seedMode: SeedMode = 'auto') => {
    const { project, catalog, preferredBundleId, remoteHost, controlAdapters = [], controlAdaptersLoaded, notify } = latest.current
    const fail = (message: string): { queued: false; error: string } => {
      notify(message, 'error')
      return { queued: false, error: message }
    }
    if (submittingRef.current) return { queued: false, error: '正在提交上一次生成' }
    const requestedId = canvasId ?? project.selectedRef.current
    const requested = project.canvasesRef.current.find((canvas) => canvas.id === requestedId)
    if (!requested) return fail('先选中一个画面')

    // Busy from here on, so a second click shows the state instead of slipping in.
    submittingRef.current = true
    setSubmitting(true)
    const stop = (message: string): { queued: false; error: string } => {
      submittingRef.current = false
      setSubmitting(false)
      return fail(message)
    }

    // Pictures and sampling choices are checked against the engine this run goes to.
    const usesInputs = Boolean(requested.inputs || requested.sampling)
    const features = usesInputs
      ? await call<EngineFeatures | null>(Ipc.engineFeatures, {
          deviceUuid: remoteHost ? undefined : requested.deviceUuid || undefined,
          hostId: remoteHost?.id,
        }).catch(() => null)
      : null
    // Everything below reads the canvases as they are now: edits made while the engine answered are kept.
    const canvases = project.canvasesRef.current
    const source = canvases.find((canvas) => canvas.id === requested.id)
    if (!source) return stop('这个画面已经删除了')
    const jobs = useApp.getState().jobs
    if (activeCanvasBranchIds(canvases, jobs).has(source.id)) return stop('这个画面正在生成，等它完成后再试')

    const choice = resolveBundle(catalog, source.modelBundleId, preferredBundleId)
    if (!choice.bundle)
      return stop(choice.unavailable ? '这个画面用的模型已经不在模型库里，请换一个模型' : '还没有可用的模型，请先到模型页下载')
    if (!choice.installed) return stop(`「${choice.bundle.name}」还没有下载完`)
    const remoteModelPath = remoteHost?.modelPath?.trim()
    if (remoteHost && !remoteModelPath) return stop(`「${remoteHost.name}」还没有设置模型位置，请到 设置 › 设备与引擎 填写`)
    const adapters = normalizeCanvasAdapters(source.adapters)
    if (remoteHost && adapters.length) return stop('在其他电脑上运行时暂不支持 LoRA，请移除 LoRA 或改回这台电脑')
    const missing = adapterStatuses(adapters, catalog?.adapters).filter((item) => !item.installed)
    if (missing.length) return stop(`LoRA ${missing.map((item) => `「${item.name}」`).join('')}找不到了，请移除或到模型库重新安装`)
    // Regions are laid out on the first-pass size.
    const compiled = compileCanvasPrompt(source.baseSize ? { ...source, ...source.baseSize } : source)
    if (!compiled.ok) return stop(compiled.errors[0] ?? '描述还不完整')
    const resolved = resolveJobInputs(source, { canvases, features, controlAdapters, controlAdaptersLoaded })
    if (resolved.blockers.length) return stop(resolved.blockers[0]!.message)

    // 'same' repeats the picture on this card: the seed its run used, not the
    // source's latest seed (a later 换个种子 from this card records a new one).
    const shownSeed = jobs.find((job) => job.id === source.jobId)?.params.seed ?? source.outputs?.[0]?.seed ?? source.seed
    const seed = seedMode === 'same' ? shownSeed : seedMode === 'new' ? randomSeed() : seedForRun(source)
    const runSource: ProjectCanvas = { ...source, seed, modelBundleId: choice.bundle.id }
    let taskId: string | null = null
    let board: ProjectCanvas[] | null = null
    try {
      // An editable source remembers the seed this run used, so 种子 shows it
      // afterwards. A result card's parameters are frozen and stay as they were.
      const withSeed =
        source.kind === 'layout'
          ? canvases.map((canvas) => (canvas.id === source.id ? { ...canvas, seed, modelBundleId: choice.bundle!.id } : canvas))
          : canvases
      const task = taskCanvasFor(runSource, withSeed)
      taskId = task.taskId
      board = task.canvases
      // The selection stays where the user is working; the result card appears on the board.
      project.setCanvases(board)
      const saved = await project.saveNow({ canvases: board, selectedCanvasId: project.selectedRef.current })
      if (!saved) throw new Error('项目没有保存成功，请稍后再试')

      let info = backend.current
      if (!info?.ready) {
        info = await electronStudioClient.backendInfo().catch(() => null)
        backend.current = info
      }
      if (!info?.ready || !info.url || !info.token) throw new Error('生成服务还在启动，请稍等几秒再试')

      const response = await fetch(`${info.url}/api/engine-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
        body: JSON.stringify({
          projectId: saved.id,
          canvasId: taskId,
          // Lineage starts at the source, as the scheduler expects.
          canvasLineage: canvasLineage(source, canvases),
          modelBinding: { bundleId: choice.bundle.id, ...choice.bundle.components },
          modelName: choice.bundle.name,
          deviceId: remoteHost ? source.deviceId || undefined : undefined,
          deviceUuid: remoteHost ? undefined : source.deviceUuid || undefined,
          hostId: remoteHost?.id,
          remoteModelPath: remoteHost ? remoteModelPath : undefined,
          prompt: compiled.prompt,
          negativePrompt: source.negative,
          adapters,
          ...resolved.params,
          width: resolved.size.width,
          height: resolved.size.height,
          steps: source.steps,
          cfg: source.cfg,
          seed,
          profile: profileFor(source.steps),
          mode: 'runner',
        }),
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new Error(errorMessage(body, response.status))
      if (!isJobRecord(body)) throw new Error('生成服务返回了无法识别的任务')
      const observed = useApp.getState().jobs.find((job) => job.id === body.id)
      board = project.canvasesRef.current.map((canvas) =>
        canvas.id === taskId
          ? {
              ...canvas,
              jobId: body.id,
              jobState: observed?.state ?? body.state,
              deviceId: body.deviceId ?? canvas.deviceId,
              deviceUuid: body.deviceUuid ?? canvas.deviceUuid,
            }
          : canvas,
      )
      project.setCanvases(board)
      const linked = await project.saveNow()
      if (!linked) notify('已开始生成，但项目没有保存成功；进度可以在「活动」里查看', 'error')
      return { queued: true, canvasId: taskId, jobId: body.id }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (taskId) {
        const id = taskId
        project.setCanvases((previous) =>
          previous.map((canvas) => (canvas.id === id ? { ...canvas, jobState: 'failed', error: { code: 'E_SUBMIT', message } } : canvas)),
        )
        void project.saveNow()
      }
      return fail(message)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [])

  return { submitting, generate }
}
