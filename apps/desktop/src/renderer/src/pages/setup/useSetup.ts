import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { MossInferDownloadState, OnboardingStatus } from '@shared/types'
import { call } from '../../lib/api'
import { engineDownloadActive, planEngineInstall, type SystemCudaCheck } from '../../lib/engineInstall'
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
    engineDownload,
    engineError,
    onboarding,
    downloads,
    modelError,
  }), [gpu.inventory, settings?.gpuSelection, engine, engineDownload, engineError, onboarding, downloads, modelError])

  const installEngine = useCallback(async () => {
    let check: SystemCudaCheck | null = null
    try { check = await call<SystemCudaCheck>(Ipc.engineSystemCuda) } catch { /* unknown: use the self-contained package */ }
    const plan = planEngineInstall(check)
    if (plan.kind === 'driver') { setEngineError(plan.message); return }
    // Resolves when the install ends; progress arrives through store events meanwhile.
    void call<MossInferDownloadState>(Ipc.mossInferDownload, { channel: plan.channel, variant: plan.variant, architecture: plan.architecture })
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

  return { view, starting, start, gpu }
}
