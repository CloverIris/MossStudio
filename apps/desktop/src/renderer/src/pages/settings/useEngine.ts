import { useCallback, useEffect, useRef, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { EngineHello } from '@shared/engineProtocol'
import type {
  EngineGpuProbeSnapshot,
  EnginePlanView,
  GpuInventorySnapshot,
  LocalEngineVersion,
  MossInferDownloadState,
  MossInferRelease,
} from '@shared/types'
import { parseEngineStamp } from '@shared/engineUpdate'
import { call } from '../../lib/api'
import { useApp } from '../../store'
import { errorText } from './fields'

export interface LocalInstallOptions {
  channel: 'stable' | 'dev'
  releaseTag?: string
  /** Package ids; omitted = what the plan says this computer is missing. */
  packages?: string[]
  /** Reinstall every planned package (a chosen release, a channel switch). */
  all?: boolean
}

export type InstallOutcome = { kind: 'started' } | { kind: 'failed'; message: string }

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
    try {
      setVersions(await call<LocalEngineVersion[]>(Ipc.engineVersions))
    } catch {
      /* keep the last list */
    }
  }, [])

  // The list changes when an install finishes or another version becomes current.
  useEffect(() => {
    void refreshVersions()
  }, [refreshVersions, readiness?.path, download?.phase])

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

  const [plan, setPlan] = useState<EnginePlanView | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planning, setPlanning] = useState(false)
  const loadPlan = useCallback(async (refresh = false): Promise<EnginePlanView | null> => {
    setPlanning(true)
    try {
      const next = await call<EnginePlanView>(Ipc.enginePlan, { refresh })
      setPlan(next)
      setPlanError(null)
      return next
    } catch (error) {
      setPlanError(errorText(error))
      return null
    } finally {
      setPlanning(false)
    }
  }, [])
  // Which package each GPU gets changes with installs and with the per-GPU choice in 高级.
  const overrides = useApp((state) => JSON.stringify(state.settings?.engineDeviceOverrides ?? {}))
  useEffect(() => {
    void loadPlan()
  }, [loadPlan, readiness?.path, download?.phase, overrides])

  const install = useCallback(
    async (options: LocalInstallOptions): Promise<InstallOutcome> => {
      try {
        const pending = call<MossInferDownloadState>(Ipc.mossInferDownload, {
          channel: options.channel,
          ...(options.packages?.length ? { packages: options.packages } : {}),
          ...(options.all ? { all: true } : {}),
          ...(options.channel === 'stable' && options.releaseTag ? { releaseTag: options.releaseTag } : {}),
        })
        // Progress arrives through events; the call itself resolves when the install ends.
        void pending.then(
          (state) => {
            setDownload(state)
            void refreshReadiness()
            void refreshVersions()
            void loadPlan()
          },
          () => undefined,
        )
        return { kind: 'started' }
      } catch (error) {
        return { kind: 'failed', message: errorText(error) }
      }
    },
    [loadPlan, refreshReadiness, refreshVersions, setDownload],
  )

  /** 安装引擎 / 更新: whatever each GPU of this computer is missing, from the latest release. */
  const installRecommended = useCallback((): Promise<InstallOutcome> => install({ channel: 'stable' }), [install])

  const cancelInstall = useCallback(async () => {
    try {
      await call(Ipc.mossInferDownloadCancel)
    } catch {
      /* already finished */
    }
  }, [])

  return {
    readiness,
    download,
    versions,
    // Several installs can be in use (one per kind of GPU): the moss-server one names the version.
    current:
      versions.find((version) => version.current && parseEngineStamp(version.name)?.package.kind === 'cuda') ??
      versions.find((version) => version.current) ??
      null,
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
    plan,
    planError,
    planning,
    loadPlan,
  }
}

export type EngineState = ReturnType<typeof useEngine>
