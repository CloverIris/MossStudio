import { useCallback, useEffect, useRef, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { EngineHello } from '@shared/engineProtocol'
import type {
  EngineGpuProbeSnapshot,
  GpuInventorySnapshot,
  LocalEngineVersion,
  MossInferDownloadState,
  MossInferRelease,
  RemoteEngineInstallOptions,
} from '@shared/types'
import { call } from '../../lib/api'
import { planEngineInstall, type SystemCudaCheck } from '../../lib/engineInstall'
import { useApp } from '../../store'
import { errorText } from './fields'

export interface LocalInstallOptions {
  channel: 'stable' | 'dev'
  variant: 'system-cuda' | 'bundled'
  architecture: RemoteEngineInstallOptions['architecture']
  flavour?: 'cu12' | 'cu13'
  releaseTag?: string
  /** Download the CUDA runtime next to a system-CUDA package. */
  cudaWheels?: boolean
  /** The system CUDA check already ran for this install. */
  preflighted?: boolean
}

export type InstallOutcome =
  | { kind: 'started' }
  /** The system-CUDA package was asked for but this computer has no matching CUDA library. */
  | { kind: 'needs-cuda'; check: SystemCudaCheck }
  | { kind: 'failed'; message: string }

/**
 * Local engine state for 设置 › 设备与引擎: installed versions, the release
 * feed, the GPU compatibility probe, and install actions.
 */
export function useEngine(inventory: GpuInventorySnapshot | null) {
  const readiness = useApp((state) => state.engineReadiness)
  const download = useApp((state) => state.mossInferDownload)
  const setDownload = useApp((state) => state.setMossInferDownload)
  const refreshReadiness = useApp((state) => state.refreshEngineReadiness)
  const [versions, setVersions] = useState<LocalEngineVersion[]>([])
  const [releases, setReleases] = useState<MossInferRelease[] | null>(null)
  const [releasesError, setReleasesError] = useState<string | null>(null)
  const [loadingReleases, setLoadingReleases] = useState(false)
  const [probe, setProbe] = useState<EngineGpuProbeSnapshot | null>(null)
  const [hello, setHello] = useState<EngineHello | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const probedKey = useRef<string | null>(null)

  const refreshVersions = useCallback(async () => {
    try { setVersions(await call<LocalEngineVersion[]>(Ipc.engineVersions)) } catch { /* keep the last list */ }
  }, [])

  // The list changes when an install finishes or another version becomes current.
  useEffect(() => { void refreshVersions() }, [refreshVersions, readiness?.path, download?.phase])

  const loadReleases = useCallback(async (): Promise<MossInferRelease[] | null> => {
    setLoadingReleases(true)
    setReleasesError(null)
    try {
      const next = await call<MossInferRelease[]>(Ipc.mossInferReleases)
      setReleases(next)
      return next
    } catch (error) {
      setReleasesError(errorText(error))
      return null
    } finally {
      setLoadingReleases(false)
    }
  }, [])

  const runProbe = useCallback(async (): Promise<boolean> => {
    setProbing(true)
    try {
      const result = await call<{ hello: EngineHello; gpuCompatibility: EngineGpuProbeSnapshot }>(Ipc.engineProbe)
      setHello(result.hello)
      setProbe(result.gpuCompatibility)
      setProbeError(null)
      return true
    } catch (error) {
      setProbeError(errorText(error))
      return false
    } finally {
      setProbing(false)
    }
  }, [])

  // Check GPU compatibility once per engine build and GPU scan.
  useEffect(() => {
    if (readiness?.state !== 'ready' || !readiness.path) return
    const key = `${readiness.path}:${inventory?.scannedAt ?? ''}`
    if (probedKey.current === key) return
    probedKey.current = key
    void runProbe()
  }, [readiness?.state, readiness?.path, inventory?.scannedAt, runProbe])

  const install = useCallback(async (options: LocalInstallOptions): Promise<InstallOutcome> => {
    try {
      if (options.variant === 'system-cuda' && !options.cudaWheels && !options.preflighted) {
        const check = await call<SystemCudaCheck>(Ipc.engineSystemCuda)
        const plan = planEngineInstall(check)
        if (plan.kind === 'driver') return { kind: 'failed', message: plan.message }
        if (!check.supported) return { kind: 'needs-cuda', check }
      }
      const pending = call<MossInferDownloadState>(Ipc.mossInferDownload, {
        channel: options.channel,
        variant: options.variant,
        architecture: options.architecture,
        ...(options.flavour ? { flavour: options.flavour } : {}),
        ...(options.cudaWheels ? { cudaWheels: true } : {}),
        ...(options.channel === 'stable' && options.releaseTag ? { releaseTag: options.releaseTag } : {}),
      })
      // Progress arrives through events; the call itself resolves when the install ends.
      void pending.then((state) => { setDownload(state); void refreshReadiness(); void refreshVersions() }, () => undefined)
      return { kind: 'started' }
    } catch (error) {
      return { kind: 'failed', message: errorText(error) }
    }
  }, [refreshReadiness, refreshVersions, setDownload])

  /** The automatic choice used by 安装引擎: small package when CUDA is present, self-contained otherwise. */
  const installRecommended = useCallback(async (): Promise<InstallOutcome> => {
    try {
      const plan = planEngineInstall(await call<SystemCudaCheck>(Ipc.engineSystemCuda))
      if (plan.kind === 'driver') return { kind: 'failed', message: plan.message }
      return install({ channel: plan.channel, variant: plan.variant, architecture: plan.architecture, preflighted: true })
    } catch (error) {
      return { kind: 'failed', message: errorText(error) }
    }
  }, [install])

  const cancelInstall = useCallback(async () => {
    try { await call(Ipc.mossInferDownloadCancel) } catch { /* already finished */ }
  }, [])

  return {
    readiness,
    download,
    versions,
    current: versions.find((version) => version.current) ?? null,
    releases,
    releasesError,
    loadingReleases,
    loadReleases,
    probe,
    hello,
    probeError,
    probing,
    runProbe,
    install,
    installRecommended,
    cancelInstall,
    refreshVersions,
  }
}

export type EngineState = ReturnType<typeof useEngine>
