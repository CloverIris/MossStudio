import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { EnginePlanView, MossInferDownloadState, OnboardingStatus } from '@shared/types'
import { call } from '../../lib/api'
import { engineDownloadActive } from '../../lib/engineInstall'
import { importFolderMessage, type ImportFolderResult } from '../../lib/modelFolder'
import { useGpuInventory } from '../../lib/useGpuInventory'
import { useApp } from '../../store'
import { deriveSetup, modelDownloads, stepsToStart, type SetupView } from './setupState'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Drives first-run preparation. Everything shown is derived from real state
 * (GPU inventory, engine readiness and install progress, model downloads), so
 * leaving and coming back, or a restart halfway, picks up where things are.
 */
export function useSetup(): {
  view: SetupView
  starting: boolean
  start: () => Promise<void>
  gpu: ReturnType<typeof useGpuInventory>
  /** Detect the GPUs again (and re-plan). */
  redetect: () => Promise<void>
  redetecting: boolean
  /** 已有模型文件？: use a model folder where it is; null when canceled, else what happened. */
  chooseModelFolder: () => Promise<{ message: string; ready: boolean } | null>
  usingFolder: boolean
} {
  const settings = useApp((state) => state.settings)
  const engine = useApp((state) => state.engineReadiness)
  const engineDownload = useApp((state) => state.mossInferDownload)
  const downloads = useApp((state) => state.downloads)
  const catalog = useApp((state) => state.catalog)
  const downloadModel = useApp((state) => state.downloadModel)
  const setMossInferDownload = useApp((state) => state.setMossInferDownload)
  const refreshEngineReadiness = useApp((state) => state.refreshEngineReadiness)
  const gpu = useGpuInventory()
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  // null while the machine probe runs; undefined when it failed (then only the NVIDIA inventory is known).
  const [plan, setPlan] = useState<EnginePlanView | null | undefined>(null)
  const [redetecting, setRedetecting] = useState(false)

  const loadPlan = useCallback(async (refresh: boolean): Promise<void> => {
    try {
      setPlan(await call<EnginePlanView>(Ipc.enginePlan, { refresh }))
    } catch {
      setPlan(undefined)
    }
  }, [])
  // First look: probe the machine afresh. Later: re-plan when installs finish (what is still missing).
  useEffect(() => { void loadPlan(true) }, [loadPlan])
  const engineFinished = engineDownload && !engineDownloadActive(engineDownload) ? engineDownload.phase : null
  useEffect(() => { if (engineFinished) void loadPlan(false) }, [engineFinished, engine?.state, loadPlan])

  // Re-read what is installed whenever a download finishes or the engine changes.
  const finished = downloads
    .filter((task) => task.kind === 'model' && !task.hostId && ['done', 'error'].includes(task.state))
    .map((task) => `${task.id}:${task.state}`)
    .join(',')
  const loadStatus = useCallback(async (): Promise<OnboardingStatus | null> => {
    try {
      const next = await call<OnboardingStatus>(Ipc.onboardingStatus, { hostId: 'local' })
      setOnboarding(next)
      return next
    } catch (error) {
      setModelError(message(error))
      return null
    }
  }, [])
  useEffect(() => { void loadStatus() }, [loadStatus, catalog, finished, engine?.state, settings?.modelsRoot])

  const view = useMemo(() => deriveSetup({
    gpu: gpu.inventory,
    gpuSelection: settings?.gpuSelection,
    engine,
    plan,
    engineDownload,
    engineError,
    onboarding,
    downloads,
    modelError,
  }), [gpu.inventory, settings?.gpuSelection, engine, plan, engineDownload, engineError, onboarding, downloads, modelError])

  const installEngine = useCallback(async () => {
    // Main installs what the plan says each GPU needs. Resolves when the install ends; progress arrives through store events.
    void call<MossInferDownloadState>(Ipc.mossInferDownload, { channel: 'stable' })
      .then((state) => { setMossInferDownload(state); void refreshEngineReadiness() })
      .catch((error: unknown) => setEngineError(message(error)))
  }, [refreshEngineReadiness, setMossInferDownload])

  const downloadModels = useCallback(async () => {
    const status = await loadStatus()
    const step = status?.steps.find((item) => item.id === 'model')
    if (!status || !step || step.status === 'ok') return
    const active = new Set(modelDownloads(status, useApp.getState().downloads)
      .filter((task) => ['queued', 'running', 'verifying'].includes(task.state))
      .map((task) => task.targetId))
    const models = useApp.getState().catalog?.models ?? []
    const missing = (step.modelIds ?? []).filter((id) => !active.has(id) && !models.find((model) => model.id === id)?.installed)
    if (missing.length === 0 && (step.modelIds ?? []).length === 0) {
      setModelError('没有找到可下载的推荐模型，请检查网络后重试')
      return
    }
    for (const id of missing) await downloadModel(id)
  }, [downloadModel, loadStatus])

  const start = useCallback(async () => {
    setStarting(true)
    setEngineError(null)
    setModelError(null)
    try {
      const steps = stepsToStart(view)
      // Engine and model download at the same time, so leaving the page loses nothing.
      if (steps.includes('engine') && !engineDownloadActive(useApp.getState().mossInferDownload)) await installEngine()
      if (steps.includes('model')) await downloadModels().catch((error: unknown) => setModelError(message(error)))
    } finally {
      setStarting(false)
    }
  }, [view, installEngine, downloadModels])

  const refreshCatalog = useApp((state) => state.refreshCatalog)
  const [usingFolder, setUsingFolder] = useState(false)
  const chooseModelFolder = useCallback(async (): Promise<{ message: string; ready: boolean } | null> => {
    setUsingFolder(true)
    try {
      const result = await call<ImportFolderResult>(Ipc.modelsImportFolder)
      if (result.canceled) return null
      await refreshCatalog()
      const status = await loadStatus()
      const ready = status?.steps.find((step) => step.id === 'model')?.status === 'ok'
      setModelError(null)
      return {
        ready,
        message: ready
          ? `${importFolderMessage(result)}，不用再下载模型`
          : `${importFolderMessage(result)}，但它不是可以直接使用的 MOSS-Image 模型；仍需下载推荐模型`,
      }
    } finally {
      setUsingFolder(false)
    }
  }, [loadStatus, refreshCatalog])

  const redetect = useCallback(async () => {
    setRedetecting(true)
    try {
      await Promise.all([gpu.refresh(), loadPlan(true)])
    } finally {
      setRedetecting(false)
    }
  }, [gpu, loadPlan])

  return { view, starting, start, gpu, redetect, redetecting, chooseModelFolder, usingFolder }
}
