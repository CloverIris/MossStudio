import {
  CheckCircle2,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Events, Ipc } from '@shared/channels'
import type {
  Catalog,
  DownloadTask,
  RemoteEngineInstallOptions,
  RemoteEngineInfo,
  EngineRemoteProgress,
  EngineGpuProbeSnapshot,
  GpuInventorySnapshot,
  GpuProfileOverride,
  JobRecord,
  LocalEngineVersion,
  ManagedHost,
  ModelBinding,
  MossInferDownloadState,
  MossInferRelease,
  Settings,
} from '@shared/types'
import type { BackendInfo } from '@shared/backend'
import type { EngineHello } from '@shared/engineProtocol'
import { recommendGpuMemoryMode } from '@shared/gpuProfile'
import { selectAutomaticGpu } from '@shared/gpuScheduling'
import { gpuRequiresBf16Tier } from '@shared/gpuProfile'
import { call, onEvent } from '../lib/api'
import { useApp } from '../store'
import { openWindow } from '../lib/windows'
import { bytes, dateTime } from '../lib/format'
import { electronStudioClient } from '../lib/studioClient'
import { Button, Card, IconButton, Input, Modal, Pill, Segmented, Spinner, useToast } from '../components/ui'

type EngineTab = 'inference' | 'developer'
type InstallPreferences = Required<Pick<RemoteEngineInstallOptions, 'channel' | 'flavour' | 'variant' | 'architecture'>> & { releaseTag: string }

interface EngineChainTest {
  phase: 'running' | 'succeeded' | 'failed'
  message: string
  jobId?: string
  outputPath?: string
  suggestReference?: boolean
}

const downloadPhaseLabels: Record<MossInferDownloadState['phase'], string> = {
  querying: '检查上游版本',
  downloading: '下载引擎包',
  verifying: '校验文件',
  extracting: '解压并安装',
  cuda_libs: '准备 CUDA 库',
  done: '安装完成',
  error: '安装失败',
  canceled: '已取消',
}

export function EnginePage(): React.JSX.Element {
  const location = useLocation()
  const toast = useToast()
  const settings = useApp((state) => state.settings)
  const saveSettings = useApp((state) => state.saveSettings)
  const gpuTelemetry = useApp((state) => state.gpuTelemetry)
  const download = useApp((state) => state.mossInferDownload)
  const engine = useApp((state) => state.engineReadiness)
  const setMossInferDownload = useApp((state) => state.setMossInferDownload)
  const refreshEngineReadiness = useApp((state) => state.refreshEngineReadiness)
  const [githubToken, setGithubToken] = useState(settings?.githubToken ?? '')
  const [gpuInventory, setGpuInventory] = useState<GpuInventorySnapshot | null>(null)
  const [refreshingGpu, setRefreshingGpu] = useState(false)
  const [engineVersions, setEngineVersions] = useState<LocalEngineVersion[]>([])
  const [releases, setReleases] = useState<MossInferRelease[]>([])
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [loadingReleases, setLoadingReleases] = useState(true)
  const [hello, setHello] = useState<EngineHello | null>(null)
  const [gpuProbe, setGpuProbe] = useState<EngineGpuProbeSnapshot | null>(null)
  const [gpuProbeError, setGpuProbeError] = useState<string | null>(null)
  const lastAutoProbeKey = useRef<string | null>(null)
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [remote, setRemote] = useState<Record<string, RemoteEngineInfo>>({})
  const [remoteProgress, setRemoteProgress] = useState<Record<string, EngineRemoteProgress>>({})
  const [enginePaths, setEnginePaths] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState<string | null>(null)
  const [installingRemote, setInstallingRemote] = useState<string | null>(null)
  const [engineHostId, setEngineHostId] = useState('local')
  const [installPreferences, setInstallPreferences] = useState<Record<string, Partial<InstallPreferences>>>({})
  const discoveredCuda = remote[engineHostId]?.cuda
  const detectedFlavour = engineHostId === 'local' ? 'cu13' : discoveredCuda?.recommendedFlavour ?? 'cu13'
  const preferredFlavour = installPreferences[engineHostId]?.flavour ?? detectedFlavour
  const defaults: InstallPreferences = {
    channel: 'stable', flavour: detectedFlavour,
    variant: engineHostId === 'local' || discoveredCuda?.flavours.includes(preferredFlavour) ? 'system-cuda' : 'bundled',
    architecture: engineHostId === 'local' ? settings?.mossInferArchitecture ?? 'auto' : 'auto',
    releaseTag: releases[0]?.tag ?? '',
  }
  const { channel, flavour, variant, architecture, releaseTag } = { ...defaults, ...installPreferences[engineHostId] }
  function changeInstallPreferences(patch: Partial<InstallPreferences>): void {
    setInstallPreferences((previous) => ({ ...previous, [engineHostId]: { ...previous[engineHostId], ...patch } }))
  }
  const setChannel = (value: InstallPreferences['channel']): void => changeInstallPreferences({ channel: value })
  const setFlavour = (value: InstallPreferences['flavour']): void => changeInstallPreferences({ flavour: value })
  const setVariant = (value: InstallPreferences['variant']): void => changeInstallPreferences({ variant: value })
  const setArchitecture = (value: InstallPreferences['architecture']): void => changeInstallPreferences({ architecture: value })
  const setReleaseTag = (value: string): void => changeInstallPreferences({ releaseTag: value })
  const [fallbackOpen, setFallbackOpen] = useState(false)
  const [preflight, setPreflight] = useState<{ supported: boolean; gpu: string; cublasLt: string[]; driverVersion?: string; driverCompatible?: boolean; error?: string } | null>(null)
  const [activeTab, setActiveTab] = useState<EngineTab>('inference')
  const [chainTest, setChainTest] = useState<EngineChainTest | null>(null)
  const [chainTesting, setChainTesting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [, versions, hostList] = await Promise.all([
        refreshEngineReadiness(),
        call<LocalEngineVersion[]>(Ipc.engineVersions),
        call<ManagedHost[]>(Ipc.hostsList),
      ])
      setEngineVersions(versions)
      setHosts(hostList.filter((host) => host.kind === 'ssh'))
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [refreshEngineReadiness, toast])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!engine?.path) return
    const key = `${engine.path}:${gpuInventory?.scannedAt ?? 'not-scanned'}`
    if (lastAutoProbeKey.current === key) return
    lastAutoProbeKey.current = key
    let canceled = false
    void call<{ hello: EngineHello; gpuCompatibility: EngineGpuProbeSnapshot }>(Ipc.engineProbe)
      .then((result) => {
        if (canceled) return
        setHello(result.hello)
        setGpuProbe(result.gpuCompatibility)
        setGpuProbeError(null)
      })
      .catch((error: unknown) => {
        if (!canceled) setGpuProbeError(error instanceof Error ? error.message : String(error))
      })
    return () => { canceled = true }
  }, [engine?.path, gpuInventory?.scannedAt])
  const refreshGpuInventory = useCallback(async () => {
    setRefreshingGpu(true)
    try {
      setGpuInventory(await call<GpuInventorySnapshot>(Ipc.gpuInventoryRefresh))
      setGpuProbe(null)
      setGpuProbeError(null)
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setRefreshingGpu(false)
    }
  }, [toast])
  useEffect(() => {
    let canceled = false
    void call<GpuInventorySnapshot>(Ipc.gpuInventory).then((snapshot) => {
      if (!canceled) setGpuInventory(snapshot)
    }).catch((error: unknown) => {
      if (!canceled) toast.push(error instanceof Error ? error.message : String(error), 'error')
    })
    const off = onEvent<GpuInventorySnapshot>(Events.gpuInventory, (snapshot) => {
      setGpuInventory(snapshot)
      setGpuProbe(null)
      setGpuProbeError(null)
    })
    return () => { canceled = true; off() }
  }, [toast])
  const refreshReleases = useCallback(async () => {
    setLoadingReleases(true)
    setReleaseError(null)
    try {
      const next = await call<MossInferRelease[]>(Ipc.mossInferReleases)
      setReleases(next)
      setInstallPreferences((previous) => Object.fromEntries(Object.entries(previous).map(([id, options]) => [id, {
        ...options, releaseTag: next.some((release) => release.tag === options.releaseTag) ? options.releaseTag : next[0]?.tag ?? '',
      }])))
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingReleases(false)
    }
  }, [])
  useEffect(() => { void refreshReleases() }, [refreshReleases])
  useEffect(() => {
    const hostId = new URLSearchParams(location.search).get('hostId')
    if (hostId) { setEngineHostId(hostId); setActiveTab('inference') }
  }, [location.key, location.search])
  useEffect(() => {
    if (engine && engineHostId !== 'local' && !hosts.some((host) => host.id === engineHostId)) setEngineHostId('local')
  }, [engine, hosts, engineHostId])
  useEffect(() => {
    if (new URLSearchParams(location.search).get('hostId') === engineHostId) {
      document.getElementById(`engine-${engineHostId}`)?.scrollIntoView({ block: 'start' })
    }
  }, [engineHostId, location.key, location.search])
  useEffect(() => { setGithubToken(settings?.githubToken ?? '') }, [settings?.githubToken])
  useEffect(() => onEvent<{ id: string }>(Events.hostsChanged, () => { void refresh() }), [refresh])
  useEffect(() => onEvent<EngineRemoteProgress>(Events.engineRemoteProgress, (progress) => {
    setRemoteProgress((previous) => ({ ...previous, [progress.hostId]: progress }))
  }), [])
  useEffect(() => {
    setEnginePaths((previous) => {
      const next = { ...previous }
      for (const host of hosts) if (next[host.id] === undefined) next[host.id] = host.engineRoot ?? '~/.mossstudio/engine'
      return next
    })
  }, [hosts])
  useEffect(() => {
    if (!hosts.length) return
    let cancelled = false
    void Promise.all(hosts.map(async (host) => {
      try {
        const result = await call<RemoteEngineInfo>(Ipc.engineRemoteStatus, { hostId: host.id })
        if (!cancelled) setRemote((previous) => ({ ...previous, [host.id]: result }))
      } catch (error) {
        if (!cancelled) setRemote((previous) => ({ ...previous, [host.id]: { online: false, available: false, path: host.engineRoot ?? '~/.mossstudio/engine', root: host.engineRoot ?? '~/.mossstudio/engine', gpu: '', error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() } }))
      }
    }))
    return () => { cancelled = true }
  }, [hosts])

  async function runDownload(selected: 'bundled' | 'system-cuda', flavour?: 'cu12' | 'cu13', cudaWheels = false): Promise<void> {
    setBusy(true)
    setGpuProbe(null)
    setGpuProbeError(null)
    try {
      const next = await call<MossInferDownloadState>(Ipc.mossInferDownload, {
        channel,
        variant: selected,
        architecture,
        flavour,
        cudaWheels,
        ...(channel === 'stable' && releaseTag ? { releaseTag } : {}),
      })
      setMossInferDownload(next)
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function selectEngineVersion(version: LocalEngineVersion): Promise<void> {
    setBusy(true)
    const requiresVerification = !version.verified || version.current && engine?.state === 'stale'
    try {
      await call(requiresVerification ? Ipc.engineVersionVerify : Ipc.engineVersionSelect, { id: version.id })
      setHello(null)
      setGpuProbe(null)
      setGpuProbeError(null)
      toast.push(requiresVerification ? '引擎已验证并切换' : '已切换当前引擎版本', 'success')
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function removeEngineVersion(version: LocalEngineVersion): Promise<void> {
    if (!window.confirm(`删除本机引擎版本？\n${version.name}\n\n此操作会删除该版本的全部文件。`)) return
    setBusy(true)
    try {
      await call(Ipc.engineVersionRemove, { id: version.id })
      toast.push(`已删除引擎版本 ${version.name}`, 'success')
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function saveGithubToken(): Promise<void> {
    try {
      await call(Ipc.settingsUpdate, { githubToken: githubToken.trim() || null })
      toast.push('GitHub Token 已保存', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function savePerformanceSettings(
    patch: Partial<Pick<Settings, 'mossInferTier' | 'mossInferMemoryMode'>>,
  ): Promise<void> {
    try {
      await saveSettings({ ...patch, gpuProfileMode: 'custom' })
      toast.push('引擎性能设置已保存', 'success')
    } catch (error) {
      toast.push(`保存引擎性能设置失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  async function saveGpuProfileOverride(
    uuid: string,
    field: 'memoryMode' | 'tier',
    value: string,
  ): Promise<void> {
    if (!settings) return
    const overrides: Record<string, GpuProfileOverride> = { ...settings.gpuProfileOverrides }
    const next: GpuProfileOverride = { ...overrides[uuid] }
    if (field === 'memoryMode') {
      if (value === 'global') delete next.memoryMode
      else if (value === 'min_memory' || value === 'balanced' || value === 'max_speed') next.memoryMode = value
      else return
    } else {
      if (value === 'global') delete next.tier
      else if (value === 'reference' || value === 'high' || value === 'turbo') next.tier = value
      else return
    }
    if (next.memoryMode === undefined && next.tier === undefined) delete overrides[uuid]
    else overrides[uuid] = next
    try {
      await saveSettings({ gpuProfileOverrides: overrides })
      toast.push('该 GPU 的性能策略已保存', 'success')
    } catch (error) {
      toast.push(`保存 GPU 性能策略失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  async function install(): Promise<void> {
    if (engineHostId !== 'local') { await installRemote(engineHostId); return }
    if (variant === 'system-cuda') {
      setBusy(true)
      try {
        const status = await call<{ supported: boolean; gpu: string; cublasLt: string[]; driverVersion?: string; driverCompatible?: boolean; error?: string }>(Ipc.engineSystemCuda)
        setPreflight(status)
        if (!status.supported) {
          setFallbackOpen(true)
          return
        }
        await runDownload('system-cuda', 'cu13')
      } catch (error) {
        toast.push(error instanceof Error ? error.message : String(error), 'error')
      } finally {
        setBusy(false)
      }
      return
    }
    await runDownload('bundled')
  }

  async function probeEngine(): Promise<void> {
    setBusy(true)
    try {
      const result = await call<{ hello: EngineHello; gpuCompatibility: EngineGpuProbeSnapshot }>(Ipc.engineProbe)
      setHello(result.hello)
      setGpuProbe(result.gpuCompatibility)
      setGpuProbeError(null)
      toast.push('引擎 hello 成功', 'success')
    } catch (error) {
      setGpuProbeError(error instanceof Error ? error.message : String(error))
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function selectThirdPartyEngine(): Promise<void> {
    setBusy(true)
    try {
      const directory = await call<string | null>(Ipc.pickDialog, {
        kind: 'folder',
        title: '选择第三方 MossInfer 引擎目录',
      })
      if (!directory) return
      const versions = await call<LocalEngineVersion[]>(Ipc.engineSelectDirectory, { path: directory })
      setEngineVersions(versions)
      setHello(null)
      setGpuProbe(null)
      setGpuProbeError(null)
      toast.push('已登记为外部引擎；点击「验证并切换」后才会用于推理', 'success')
      await refresh()
    } catch (error) {
      toast.push(`接入第三方引擎失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function runEngineChainTest(): Promise<void> {
    setChainTesting(true)
    setChainTest({ phase: 'running', message: '检查模型、后端和当前引擎…' })
    try {
      if (engine?.state !== 'ready') throw new Error(engine?.reason ?? '当前引擎不可用')
      const catalog = await call<Catalog>(Ipc.modelsCatalog)
      const isReady = (candidate: Catalog['bundles'][number]): boolean =>
        [candidate.components.dit, candidate.components.textEncoder, candidate.components.vae, candidate.support]
          .every((id) => {
            const model = catalog.models.find((entry) => entry.id === id)
            return Boolean(model?.installed && (model.installState === undefined || model.installState === 'ready'))
          })
      const bundle = catalog.bundles.find((candidate) => candidate.recommended && isReady(candidate))
        ?? catalog.bundles.find(isReady)
      if (!bundle) throw new Error('没有完整就绪的本机模型组合；请先在模型页准备一组包含 DiT、文本编码器、VAE 和运行配置的模型')

      const backend: BackendInfo = await electronStudioClient.backendInfo()
      if (!backend.ready || !backend.url || !backend.token) {
        throw new Error(backend.error ?? '本机推理后端尚未就绪')
      }

      const modelBinding: ModelBinding = {
        bundleId: bundle.id,
        ...bundle.components,
      }
      const response = await fetch(`${backend.url}/api/engine-jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${backend.token}`,
        },
        body: JSON.stringify({
          modelBinding,
          modelName: bundle.name,
          prompt: 'a red apple on a wooden table',
          negativePrompt: '',
          width: 256,
          height: 256,
          steps: 4,
          cfg: 3,
          seed: 7,
          profile: 'dmd8',
          mode: 'runner',
        }),
      })
      const started = (await response.json()) as {
        id?: unknown
        error?: string | { message?: string }
      }
      if (!response.ok) {
        const message = typeof started.error === 'string' ? started.error : started.error?.message
        throw new Error(message ?? `后端返回 ${response.status}`)
      }
      if (typeof started.id !== 'string') throw new Error('后端未返回有效的推理任务 ID')
      const jobId = started.id
      setChainTest({ phase: 'running', jobId, message: '任务已提交，等待引擎 load 与实际生成…' })

      const deadline = Date.now() + 10 * 60_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const statusResponse = await fetch(`${backend.url}/api/jobs/${encodeURIComponent(jobId)}`, {
          headers: { authorization: `Bearer ${backend.token}` },
        })
        if (!statusResponse.ok) throw new Error(`读取推理任务失败：HTTP ${statusResponse.status}`)
        const job = (await statusResponse.json()) as JobRecord | null
        if (!job) throw new Error('后端未返回测试任务状态')
        if (job.state === 'failed' || job.state === 'canceled') {
          throw new Error(job.error?.message ?? `测试任务${job.state === 'failed' ? '失败' : '已取消'}`)
        }
        if (job.state === 'succeeded') {
          const output = job.outputs?.[0]
          if (job.engine !== 'mossinfer' || !output?.path) {
            throw new Error('任务结束但没有 MossInfer 生成输出')
          }
          setChainTest({
            phase: 'succeeded',
            jobId: job.id,
            outputPath: output.path,
            message: `完整链路通过：${job.engine} · ${output.width}×${output.height} · seed ${output.seed}`,
          })
          return
        }
        setChainTest({
          phase: 'running',
          jobId: job.id,
          message: `推理中：${job.stage} ${job.progress.percent.toFixed(0)}%`,
        })
      }
      throw new Error('真实生成测试超过 10 分钟仍未完成')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setChainTest({
        phase: 'failed',
        message,
        suggestReference: /tier high with attention exact on a bf16/i.test(message),
      })
      toast.push(`引擎链路测试失败：${message}`, 'error')
    } finally {
      setChainTesting(false)
    }
  }

  async function retryChainTestWithReference(): Promise<void> {
    try {
      await saveSettings({ mossInferTier: 'reference' })
      toast.push('已切换到 Reference，重新运行链路测试', 'info')
      await runEngineChainTest()
    } catch (error) {
      toast.push(`切换到 Reference 失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  async function prepareModel(hostId: string): Promise<void> {
    setPreparing(hostId)
    try {
      const result = await call<DownloadTask>(Ipc.enginePrepareRemoteModel, { hostId })
      toast.push(`已加入远端下载队列：${result.label}`, 'success')
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setPreparing(null)
    }
  }

  async function installCudaWheels(): Promise<void> {
    setBusy(true)
    try {
      const result = await call<{ installed: string[]; packages: string[] }>(Ipc.mossInferCudaLibs)
      toast.push(`CUDA 库已解压：${result.installed.length} 个文件`, 'success')
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function openSshTerminal(hostId: string): Promise<void> {
    try {
      await call(Ipc.sshTerminalOpen, { hostId })
      openWindow('terminal')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function autoFindEngine(hostId: string): Promise<void> {
    try {
      const result = await call<{ found?: string; message: string }>(Ipc.remoteResourceInspect, { hostId, kind: 'engine', path: enginePaths[hostId] ?? '~/.mossstudio/engine' })
      if (result.found) {
        const root = result.found.replace(/\/bin\/moss-server$/, '')
        setEnginePaths((previous) => ({ ...previous, [hostId]: root }))
        await call(Ipc.hostsUpdatePaths, { id: hostId, engineRoot: root })
        await refresh()
      }
      toast.push(result.message, result.found ? 'success' : 'info')
    } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') }
  }

  async function deleteEngine(hostId: string): Promise<void> {
    const path = hosts.find((host) => host.id === hostId)?.engineRoot ?? '~/.mossstudio/engine'
    if (!window.confirm(`删除远端引擎目录？\n${path}`)) return
    try {
      await call(Ipc.remoteResourceRemove, { hostId, path })
      toast.push('远端引擎目录已删除', 'success')
      await refresh()
    } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') }
  }

  async function saveEnginePath(hostId: string): Promise<void> {
    try {
      await call(Ipc.hostsUpdatePaths, { id: hostId, engineRoot: enginePaths[hostId] })
      toast.push('引擎路径已更新', 'success')
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function installRemote(hostId: string): Promise<void> {
    setInstallingRemote(hostId)
    setRemoteProgress((previous) => ({ ...previous, [hostId]: { hostId, phase: 'checking', message: '正在检查目标设备…', percent: 0 } }))
    try {
      await call(Ipc.hostsUpdatePaths, { id: hostId, engineRoot: enginePaths[hostId] })
      const result = await call<{ version: string; path: string; asset: string }>(Ipc.engineInstallRemote, {
        hostId, channel, flavour, variant, architecture,
        ...(channel === 'stable' && releaseTag ? { releaseTag } : {}),
      })
      toast.push(`远端引擎 ${result.version} 已安装`, 'success')
      await refresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setRemoteProgress((previous) => ({ ...previous, [hostId]: { hostId, phase: 'error', message, percent: 100 } }))
      toast.push(message, 'error')
    } finally {
      setInstallingRemote(null)
    }
  }

  async function checkRemote(hostId: string): Promise<void> {
    setBusy(true)
    try {
      const result = await call<RemoteEngineInfo>(Ipc.engineRemoteStatus, { hostId, refreshCuda: true })
      setRemote((previous) => ({ ...previous, [hostId]: result }))
      const cudaSummary = result.cuda?.flavours.length ? `系统库依赖检查通过：${result.cuda.flavours.join(' / ')}` : result.cuda?.error ?? '未发现已通过依赖检查的 CUDA 系统库'
      toast.push(!result.online ? 'SSH 连接失败' : `${result.available ? '引擎已安装' : '引擎未安装'} · ${cudaSummary}`, !result.online ? 'error' : 'info')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const downloading = download && !['done', 'error', 'canceled'].includes(download.phase)
  const selectedRelease = releases.find((release) => release.tag === releaseTag)
  const isRemote = engineHostId !== 'local'
  const selectedHost = hosts.find((host) => host.id === engineHostId)
  const selectedRemote = remote[engineHostId]
  const localReady = engine?.state === 'ready'
  const selectedAvailable = isRemote ? selectedRemote?.available : localReady
  const selectedPath = isRemote ? selectedRemote?.path : engine?.path
  const selectedError = isRemote ? selectedRemote?.error : engine?.reason
  const selectedVersion = isRemote ? selectedRemote?.version : engine?.engineVersion
  const deviceLabel = isRemote ? selectedHost?.name ?? '远端设备' : '本机'
  const localStateLabel = !engine ? '检测中'
    : engine.state === 'ready' ? engine.lastAttempt?.error ? '已就绪 · 上次更新失败' : 'ready'
      : engine.state === 'unverified' ? '未验证'
        : engine.state === 'stale' ? '待重新验证'
          : engine.state === 'unsupported' ? '不兼容' : 'missing'
  const selectedStateLabel = isRemote
    ? selectedRemote?.available ? 'ready' : 'missing'
    : localStateLabel
  const selectedTone = selectedAvailable ? 'accent' : !isRemote && engine?.state === 'unsupported' ? 'red' : 'amber'
  const selectedProgress = remoteProgress[engineHostId]
  const installation: MossInferDownloadState | null = isRemote ? selectedProgress ? {
    channel, phase: selectedProgress.phase === 'checking' ? 'querying' : selectedProgress.phase === 'installing' ? 'extracting' : selectedProgress.phase,
    bytes: selectedProgress.bytes ?? 0, totalBytes: selectedProgress.totalBytes ?? 0, speedBps: selectedProgress.speedBps ?? 0, percent: selectedProgress.percent ?? 0, updatedAt: '',
    note: selectedProgress.message, error: selectedProgress.phase === 'error' ? selectedProgress.message : undefined,
  } : null : download
  const installationInProgress = isRemote ? installingRemote === engineHostId : Boolean(downloading)
  const progressIndeterminate = Boolean(installation && ['querying', 'extracting', 'cuda_libs'].includes(installation.phase))
  const progressPercent = installation ? installation.phase === 'done' ? 100 : Math.max(0, Math.min(100, installation.percent)) : 0
  // A failed update must not read as "the engine is broken" when the previous build still runs.
  const phaseLabel = installation
    ? installation.phase === 'error' && !isRemote && localReady
      ? '更新失败 · 当前引擎仍可用'
      : downloadPhaseLabels[installation.phase]
    : ''
  const systemRecommendedGpu = gpuInventory?.devices.find((device) => device.uuid === gpuInventory.recommendedGpuUuid)
  const compatibleGpuUuids = new Set(
    gpuProbe?.devices.filter((device) => device.status === 'supported').map((device) => device.uuid) ?? [],
  )
  const recommendedGpu = gpuProbe && gpuInventory
    ? selectAutomaticGpu(gpuInventory.devices, compatibleGpuUuids, {})
    : systemRecommendedGpu
  const gpuSelection = settings?.gpuSelection
  const configuredGpuUuid = gpuSelection && typeof gpuSelection === 'object' ? gpuSelection.uuid : undefined
  const selectedGpuUuid = configuredGpuUuid ?? recommendedGpu?.uuid
  const selectedGpu = gpuInventory?.devices.find((device) => device.uuid === selectedGpuUuid)
  const savedGpuMissing = Boolean(
    configuredGpuUuid &&
      gpuInventory &&
      !gpuInventory.devices.some((device) => device.uuid === configuredGpuUuid),
  )
  const recommendedMemoryMode = selectedGpu ? recommendGpuMemoryMode(selectedGpu) : null

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">引擎</h1>
          <p className="mt-1 text-ui text-[var(--color-text-secondary)]">
            MossInfer sidecar 管理。推理算法在引擎里；MossStudio 只负责模型、任务和输出。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={selectedTone}>{deviceLabel}引擎{selectedStateLabel}</Pill>
          <IconButton label="刷新" onClick={() => void refresh()} disabled={busy}><RefreshCw className="size-4" /></IconButton>
        </div>
      </header>

      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold">本机 NVIDIA 推理设备</h2>
              <Pill tone={gpuInventory?.status === 'ok' ? 'accent' : gpuInventory?.status === 'error' ? 'red' : 'amber'}>
                {gpuInventory?.status === 'ok' ? `${gpuInventory.devices.length} 张 GPU` : gpuInventory?.status === 'error' ? '扫描失败' : '尚无可用 GPU'}
              </Pill>
            </div>
            <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">
              自动模式会在引擎确认兼容的设备中优先分配空闲且性能更强的 GPU；繁忙时排入负载较低的兼容卡。Canvas 提交后固定到该卡 UUID，不会在队列中漂移。
            </p>
            {gpuInventory?.error ? <p role="status" className="mt-2 text-caption text-amber-200">{gpuInventory.error}</p> : null}
            {gpuInventory?.capabilityNotice ? <p role="status" className="mt-1 text-caption text-amber-200">{gpuInventory.capabilityNotice}</p> : null}
          </div>
          <Button tone="ghost" onClick={() => void refreshGpuInventory()} disabled={refreshingGpu}>
            <RefreshCw className={`size-4 ${refreshingGpu ? 'animate-spin' : ''}`} /> 重新扫描
          </Button>
        </div>
        <div className="mt-3 grid gap-3 border-t border-[var(--color-border-subtle)] pt-3 sm:grid-cols-[minmax(220px,0.7fr)_1.3fr]">
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">自动架构目标 GPU</span>
            <select
              value={settings && typeof settings.gpuSelection === 'object' ? settings.gpuSelection.uuid : 'auto'}
              onChange={(event) => {
                const next = event.target.value === 'auto' ? 'auto' : { uuid: event.target.value }
                void saveSettings({ gpuSelection: next }).then(
                  () => toast.push('默认推理 GPU 已保存', 'success'),
                  (error: unknown) => toast.push(error instanceof Error ? error.message : String(error), 'error'),
                )
              }}
              className="app-input w-full"
            >
              <option value="auto">
                {recommendedGpu
                  ? `自动分配 · 优先 ${recommendedGpu.name}（GPU ${recommendedGpu.index}）`
                  : gpuProbe
                    ? '自动分配 · 没有已确认兼容的 GPU'
                    : '自动分配 · 正在检测引擎兼容性'}
              </option>
              {savedGpuMissing && settings && typeof settings.gpuSelection === 'object' ? (
                <option value={settings.gpuSelection.uuid} disabled>已保存设备未连接 · {settings.gpuSelection.uuid.slice(0, 16)}</option>
              ) : null}
              {(gpuInventory?.devices ?? []).map((device) => (
                <option key={device.uuid} value={device.uuid}>{device.name} · GPU {device.index}</option>
              ))}
            </select>
            {savedGpuMissing ? <p role="status" className="text-caption text-amber-200">保存的 GPU 当前未连接；偏好已保留，请重新扫描或改选设备。</p> : null}
            {selectedGpu ? (
              <p className="text-caption text-[var(--color-text-tertiary)]">
                {gpuSelection === 'auto' ? '推荐参考：' : '当前目标：'}SM{selectedGpu.computeCapability ? `${selectedGpu.computeCapability.major}${selectedGpu.computeCapability.minor}` : '未知'}
                {' · '}{selectedGpu.memoryTotalBytes ? bytes(selectedGpu.memoryTotalBytes) : '显存未知'}
              </p>
            ) : null}
            {selectedGpu && recommendedMemoryMode ? (
              <div className="mt-2 rounded-md border border-accent-500/15 bg-accent-500/[0.04] px-2.5 py-2">
                <p className="text-caption text-[var(--color-text-secondary)]">
                  显存建议：{recommendedMemoryMode === 'min_memory' ? '省显存' : recommendedMemoryMode === 'max_speed' ? '速度优先' : '均衡'}
                  {' · '}依据总显存的保守预设，不会更改模型、权重精度或生成参数。每张 GPU 可单独覆盖策略。
                </p>
                <Button
                  className="mt-1.5"
                  tone="ghost"
                  onClick={() => void saveGpuProfileOverride(selectedGpu.uuid, 'memoryMode', recommendedMemoryMode)}
                >
                  仅应用到此 GPU
                </Button>
              </div>
            ) : null}
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            {(gpuInventory?.devices ?? []).map((device) => {
              const telemetry = gpuTelemetry?.devices.find((candidate) => candidate.uuid === device.uuid)
              return (
              <div key={device.uuid} className="rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.025] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-ui font-medium">{device.name}</span>
                  {device.uuid === selectedGpuUuid ? <Pill tone="accent">{settings?.gpuSelection === 'auto' ? '性能推荐' : '默认'}</Pill> : null}
                  {settings?.gpuProfileOverrides[device.uuid] ? <Pill tone="amber">自定义策略</Pill> : null}
                </div>
                <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">
                  GPU {device.index} · SM{device.computeCapability ? `${device.computeCapability.major}${device.computeCapability.minor}` : '未知'}
                  {' · '}显存 {telemetry?.memoryUsedBytes !== undefined ? bytes(telemetry.memoryUsedBytes) : '未知'}
                  {' / '}{device.memoryTotalBytes ? bytes(device.memoryTotalBytes) : '未知'}
                  {' · '}{telemetry?.memoryFreeBytes !== undefined ? `${bytes(telemetry.memoryFreeBytes)} 可用` : '可用显存未知'}
                  {' · '}GPU {telemetry?.utilizationPercent === undefined ? '—' : `${telemetry.utilizationPercent}%`}
                  {' · '}{telemetry?.runningTasks ?? 0} 运行 / {telemetry?.queuedTasks ?? 0} 排队
                </p>
                {(() => {
                  const compatibility = gpuProbe?.devices.find((candidate) => candidate.uuid === device.uuid)
                  return (
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <Pill tone={
                          compatibility?.status === 'supported'
                            ? 'accent'
                            : compatibility?.status === 'unsupported'
                              ? 'red'
                              : 'amber'
                        }>
                          {compatibility?.status === 'supported'
                            ? '引擎兼容'
                            : compatibility?.status === 'unsupported'
                              ? '引擎不兼容'
                              : '兼容性待测'}
                        </Pill>
                        {gpuProbe ? (
                          <p className="mt-1 text-micro text-[var(--color-text-tertiary)]">
                            Probe {dateTime(gpuProbe.checkedAt)}
                          </p>
                        ) : null}
                        {compatibility?.reason ?? gpuProbeError ? (
                          <p
                            className="mt-1 break-words text-micro leading-4 text-amber-200"
                            title={compatibility?.reason ?? gpuProbeError ?? undefined}
                          >
                            {compatibility?.reason ?? gpuProbeError}
                          </p>
                        ) : null}
                      </div>
                      <Button tone="ghost" disabled={busy || !engine?.path} onClick={() => void probeEngine()}>
                        <ShieldCheck className="size-3.5" /> 测试兼容性
                      </Button>
                    </div>
                  )
                })()}
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="space-y-1">
                    <span className="text-micro text-[var(--color-text-tertiary)]">显存模式</span>
                    <select
                      aria-label={`${device.name} 显存模式`}
                      className="app-input w-full"
                      value={settings?.gpuProfileOverrides[device.uuid]?.memoryMode ?? 'global'}
                      onChange={(event) => void saveGpuProfileOverride(device.uuid, 'memoryMode', event.target.value)}
                    >
                      <option value="global">{settings?.gpuProfileMode === 'auto' ? '自动建议' : '跟随全局'}</option>
                      <option value="min_memory">省显存</option>
                      <option value="balanced">均衡</option>
                      <option value="max_speed">速度优先</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-micro text-[var(--color-text-tertiary)]">质量档</span>
                    <select
                      aria-label={`${device.name} 质量档`}
                      className="app-input w-full"
                      value={gpuRequiresBf16Tier(device) ? 'reference' : settings?.gpuProfileOverrides[device.uuid]?.tier ?? 'global'}
                      onChange={(event) => void saveGpuProfileOverride(device.uuid, 'tier', event.target.value)}
                    >
                      <option value="reference">Reference</option>
                      {!gpuRequiresBf16Tier(device) ? (
                        <>
                          <option value="global">跟随全局</option>
                          <option value="high">High</option>
                          <option value="turbo">Turbo</option>
                        </>
                      ) : null}
                    </select>
                  </label>
                </div>
                {gpuRequiresBf16Tier(device) ? (
                  <p className="mt-1 text-micro text-amber-200">
                    此卡为 SM{device.computeCapability?.major}{device.computeCapability?.minor}，仅使用 Reference（BF16）；其他 GPU 不受影响。
                  </p>
                ) : null}
              </div>
              )
            })}
            {gpuInventory?.status !== 'ok' ? (
              <p className="text-caption text-[var(--color-text-tertiary)]">扫描状态会明确区分未检测到设备与驱动/命令错误；可手动选择引擎架构继续。</p>
            ) : null}
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[14px] font-semibold">当前推理配置</h2>
              <Pill tone={settings?.inferenceBackend === 'mossinfer' && localReady ? 'accent' : 'amber'}>
                {settings?.inferenceBackend === 'mossinfer' && localReady ? '首页使用 MossInfer' : '首页未使用 MossInfer'}
              </Pill>
            </div>
            <p className="mt-1 break-all font-mono text-caption text-[var(--color-text-secondary)]">
              {settings?.inferenceBackend === 'mossinfer'
                ? engine?.path ?? engine?.reason ?? 'MossInfer 引擎路径未配置'
                : '首页当前使用 Runner 后端；下方性能参数仅在 MossInfer 后端生效。'}
            </p>
            {engine?.engineVersion ? <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">{engine.engineVersion}</p> : null}
          </div>
          <Pill tone={localReady ? 'accent' : engine?.state === 'unsupported' ? 'red' : 'amber'}>本机引擎{localStateLabel}</Pill>
        </div>
        <div className="mt-3 grid gap-3 border-t border-[var(--color-border-subtle)] pt-3 sm:grid-cols-2">
          <Segmented
            label="质量档（tier）"
            value={settings?.mossInferTier ?? 'high'}
            onChange={(mossInferTier) => void savePerformanceSettings({ mossInferTier })}
            options={[
              { value: 'reference', label: 'Reference · bf16 精确' },
              { value: 'high', label: 'High · 8bit 注意力' },
              { value: 'turbo', label: 'Turbo · INT4' },
            ]}
          />
          <Segmented
            label="显存模式"
            value={settings?.mossInferMemoryMode ?? 'balanced'}
            onChange={(mossInferMemoryMode) => void savePerformanceSettings({ mossInferMemoryMode })}
            options={[
              { value: 'min_memory', label: '省显存' },
              { value: 'balanced', label: '均衡' },
              { value: 'max_speed', label: '最快' },
            ]}
          />
          <p className="text-caption text-[var(--color-text-tertiary)] sm:col-span-2">
            全局质量档仅作为默认值；推理任务会按实际分配的 GPU 应用配置。计算能力低于 SM 8.0 的 GPU 自动使用 Reference（BF16），不会限制同机其他 GPU 使用 High 或 Turbo。
          </p>
        </div>
        <p className="mt-2 text-caption leading-4 text-[var(--color-text-tertiary)]">
          参数在下次引擎 load 时生效。BF16 模型配合 exact attention 时请选择 Reference；High 需要量化 DiT 或可用的 8-bit attention，Turbo 需要 INT4 DiT。
        </p>
      </Card>

      <nav role="tablist" aria-label="引擎管理模式" className="flex w-fit max-w-full gap-1 rounded-lg border border-[var(--color-border-subtle)] bg-black/15 p-1">
        {([
          ['inference', '推理引擎'],
          ['developer', '自定义推理器'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            id={`engine-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`engine-panel-${id}`}
            onClick={() => setActiveTab(id)}
            className={`rounded-md px-3 py-1.5 text-ui transition ${
              activeTab === id
                ? 'bg-white/[0.09] font-medium text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-tertiary)] hover:bg-white/[0.04] hover:text-[var(--color-text-secondary)]'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {activeTab === 'inference' ? (
      <div role="tabpanel" id="engine-panel-inference" aria-labelledby="engine-tab-inference" className="space-y-4">
      <Card className="p-4" data-oobe-host={engineHostId} id={`engine-${engineHostId}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-accent-500/10 p-2 text-accent-300">{isRemote ? <HardDrive className="size-5" /> : <Cpu className="size-5" />}</div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-semibold">{deviceLabel} MossInfer</h2>
                <Pill tone={selectedTone}>{selectedStateLabel}</Pill>
              </div>
              <p className="mt-1 max-w-[720px] break-all font-mono text-caption text-[var(--color-text-tertiary)]">
                {selectedPath ?? selectedError ?? '未检测到 moss-server'}
              </p>
              {selectedVersion ? <p className="mt-1 text-caption text-[var(--color-text-secondary)]">{selectedVersion}</p> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="space-y-1">
              <span className="text-caption text-[var(--color-text-tertiary)]">设备</span>
              <select aria-label="引擎设备" value={engineHostId} onChange={(event) => setEngineHostId(event.target.value)} className="app-input min-w-48">
                <option value="local">本机</option>
                {hosts.map((host) => <option key={host.id} value={host.id}>{host.name} · SSH</option>)}
              </select>
            </label>
            {isRemote ? <Pill tone={selectedRemote?.online ? 'accent' : 'amber'}>{selectedRemote ? selectedRemote.online ? 'SSH 在线' : 'SSH 离线' : '检测中'}</Pill> : null}
            {(() => {
              if (isRemote) return null
              // Only offer the repair when the installed engine is the system-cuda variant
              // AND no usable cuBLASLt is in sight (probe result wins over the preflight list).
              const probed = hello?.probe?.cublasLt
              const probeOk = Boolean(probed && !probed.error && probed.source)
              const preflightOk = Boolean(preflight && preflight.cublasLt.length > 0)
              const needsCudaLibs = Boolean(engine?.path) && (engine?.variant === 'system-cuda' || (engine?.path?.includes('system-cuda') ?? false)) && !probeOk && !preflightOk
              return needsCudaLibs ? (
                <Button tone="ghost" onClick={() => void installCudaWheels()} disabled={busy || !engine?.path}>
                  <ShieldCheck className="size-4" /> 补 CUDA 库
                </Button>
              ) : null
            })()}
          </div>
        </div>

        {isRemote && selectedRemote?.cuda ? <div data-remote-cuda className="mt-3 rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.025] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-ui font-medium">
              <ShieldCheck className="size-4 text-accent-300" />系统 CUDA 库
              <Pill tone={selectedRemote.cuda.flavours.length ? 'accent' : 'amber'}>{selectedRemote.cuda.flavours.length ? selectedRemote.cuda.flavours.map((value) => `CUDA ${value.slice(2)}`).join(' / ') : '未发现已通过依赖检查的库'}</Pill>
            </div>
            <Button tone="ghost" onClick={() => void checkRemote(engineHostId)} disabled={busy || installationInProgress}><RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} />重新检测 CUDA</Button>
          </div>
          <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">驱动 {selectedRemote.cuda.driverVersion ?? '未知'} · 扫描 {selectedRemote.cuda.durationMs} ms · {dateTime(selectedRemote.cuda.checkedAt)} · 结果缓存 60 秒</p>
          {selectedRemote.cuda.recommendedFlavour ? <p className="mt-1 text-caption text-[var(--color-text-secondary)]">库与驱动匹配建议：CUDA {selectedRemote.cuda.recommendedFlavour.slice(2)} · {selectedRemote.cuda.recommendedVariant}；手动选择会保留。</p> : null}
          {selectedRemote.cuda.error ? <p className="mt-1 text-caption text-amber-200">{selectedRemote.cuda.error}</p> : null}
          {variant === 'system-cuda' && !selectedRemote.cuda.flavours.includes(flavour) ? <p className="mt-1 text-caption text-amber-200">尚未发现已通过依赖检查的 CUDA {flavour.slice(2)} cuBLASLt，可重新检测或改用 bundled 包。</p> : null}
          {selectedRemote.cuda.gpuReason ? <p role="status" className="mt-1 text-caption text-amber-200">{selectedRemote.cuda.gpuReason}</p> : null}
          {selectedRemote.cuda.libraries.length ? <details className="mt-2 text-caption text-[var(--color-text-tertiary)]"><summary className="cursor-pointer">查看 cuBLASLt 路径与依赖检查</summary><ul className="mt-1 space-y-1">{selectedRemote.cuda.libraries.map((library) => <li key={library.path} className="break-all font-mono">{library.path}{library.versionText ? ` · 文件版本 ${library.versionText}` : ''} · {library.dependencyCheck === 'passed' ? '依赖检查通过' : library.dependencyCheck === 'failed' ? '依赖检查失败' : '依赖未验证'}</li>)}</ul></details> : null}
        </div> : null}

        <div className={`mt-4 grid gap-2 border-t border-[var(--color-border-subtle)] pt-3 ${isRemote ? 'sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto]' : 'sm:grid-cols-[1fr_1fr_1fr_auto]'}`}>
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">渠道</span>
            <select value={channel} onChange={(event) => setChannel(event.target.value as 'stable' | 'dev')} className="app-input w-full">
              <option value="stable">GitHub Release（正式版）</option>
              <option value="dev">Dev artifact（需要 GitHub token）</option>
            </select>
          </label>
          {isRemote ? <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">CUDA 版本</span>
            <select value={flavour} onChange={(event) => setFlavour(event.target.value as 'cu12' | 'cu13')} className="app-input w-full">
              <option value="cu13">CUDA 13</option>
              <option value="cu12">CUDA 12</option>
            </select>
          </label> : null}
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">包类型</span>
            <select value={variant} onChange={(event) => setVariant(event.target.value as 'bundled' | 'system-cuda')} className="app-input w-full">
              <option value="system-cuda">system CUDA（默认，需系统 cuBLASLt）</option>
              <option value="bundled">bundled CUDA（内置 CUDA 库）</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">GPU 架构</span>
            <select value={architecture} onChange={(event) => setArchitecture(event.target.value as 'auto' | 'standard' | 'sm75')} className="app-input w-full">
              <option value="auto">{isRemote ? '自动（Linux 标准架构）' : '自动（架构与 CUDA 兼容性）'}</option>
              <option value="standard">标准架构（SM80+）</option>
              <option value="sm75" disabled={isRemote}>SM75（RTX 20 / Turing）</option>
            </select>
          </label>
          <Button data-oobe="engine" data-oobe-hint="为选中的设备安装所选版本与包类型。Linux 远端使用标准架构；SM75 架构包仅支持 Windows。" tone="primary" className="self-end" onClick={() => void install()} disabled={busy || installationInProgress || isRemote && installingRemote !== null}>
            <Download className="size-4" /> 下载/更新引擎
          </Button>
        </div>

        {channel === 'stable' ? (
          <div className="mt-3 rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.025] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="min-w-[220px] flex-1 space-y-1">
                <span className="text-caption text-[var(--color-text-tertiary)]">Release 版本</span>
                <select
                  value={releaseTag}
                  onChange={(event) => setReleaseTag(event.target.value)}
                  disabled={loadingReleases || releases.length === 0 || Boolean(installationInProgress)}
                  className="app-input w-full"
                >
                  {releases.length === 0 ? <option value="">没有已发布的 Release</option> : null}
                  {releases.map((release) => (
                    <option key={release.tag} value={release.tag}>
                      {release.name} · {release.tag}{release.publishedAt ? ` · ${dateTime(release.publishedAt)}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <Button tone="ghost" onClick={() => void refreshReleases()} disabled={loadingReleases || Boolean(installationInProgress)}>
                <RefreshCw className={`size-4 ${loadingReleases ? 'animate-spin' : ''}`} /> 刷新版本
              </Button>
            </div>
            {releaseError ? (
              <p role="status" className="mt-2 text-caption leading-4 text-amber-200">
                无法读取 GitHub Release：{releaseError}。仍可尝试下载；上游没有正式版时会回退到最新成功 CI 构件。
              </p>
            ) : releases.length === 0 && !loadingReleases ? (
              <p role="status" className="mt-2 text-caption leading-4 text-amber-200">
                上游目前没有已发布的 Release。选择正式版下载时会自动回退到最新成功 CI 构件；该构件需要 GitHub Token。
              </p>
            ) : selectedRelease ? (
              <div className="mt-2 space-y-1 text-caption text-[var(--color-text-tertiary)]">
                <p>{selectedRelease.assets.length} 个上游文件 · {selectedRelease.publishedAt ? dateTime(selectedRelease.publishedAt) : '发布时间未知'}</p>
                {selectedRelease.assets.length ? (
                  <p className="break-all font-mono text-micro">{selectedRelease.assets.map((asset) => asset.name).join(' · ')}</p>
                ) : (
                    <div className="flex flex-wrap items-center gap-2 text-amber-200">
                      <span>此 Release 暂无下载文件；不会静默切换版本。</span>
                      <button type="button" className="text-accent-300 hover:underline" onClick={() => setChannel('dev')}>
                        改用最新 CI artifact
                      </button>
                    </div>
                  )}
                {selectedRelease.body.trim() ? (
                  <details className="pt-1">
                    <summary className="cursor-pointer text-[var(--color-text-secondary)]">查看上游说明</summary>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-sans text-caption leading-4">{selectedRelease.body}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {!isRemote && preflight ? (
          <p className="mt-2 text-caption leading-4 text-[var(--color-text-tertiary)]">
            预检：{preflight.gpu || preflight.error} · 驱动 {preflight.driverVersion ?? '未知'} · CUDA 13 cuBLASLt {preflight.cublasLt.length ? preflight.cublasLt.join(', ') : '未找到'}
          </p>
        ) : null}

        <div className="mt-3 grid gap-2 border-t border-[var(--color-border-subtle)] pt-3 sm:grid-cols-[1fr_auto]">
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">GitHub Token（仅 Actions artifact 需要）</span>
            <Input type="password" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} placeholder="github_pat_… / ghp_…" autoComplete="new-password" />
          </label>
          <Button tone="secondary" className="self-end" onClick={() => void saveGithubToken()}>保存 Token</Button>
          <p className="text-caption leading-4 text-[var(--color-text-tertiary)] sm:col-span-2">
            正式 Release 下载不需要 Token；上游没有任何 Release 时，稳定渠道自动回退到最新成功 CI artifact（需要 Token）。选中的 Release 若没有适配包会明确报出缺少的文件，不会静默安装其他版本。Token 仅用于本机 GitHub API 请求，不会发送给远端主机。
          </p>
        </div>

        {installation ? (
          <div
            role="status"
            aria-live="polite"
            className={`mt-3 rounded-lg border p-3 ${
              installation.phase === 'error'
                ? 'border-red-400/25 bg-red-400/[0.05]'
                : installation.phase === 'done'
                  ? 'border-emerald-400/25 bg-emerald-400/[0.04]'
                  : 'border-[var(--color-border-subtle)] bg-white/[0.025]'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-caption">
              <span className="flex items-center gap-1.5 font-medium">
                {installation.phase === 'done' ? <CheckCircle2 className="size-4 text-emerald-300" /> : null}
                {installation.phase !== 'done' && installation.phase !== 'error' && installation.phase !== 'canceled' ? <RefreshCw className="size-3.5 animate-spin text-accent-300" /> : null}
                {phaseLabel}{installation.version ? ` · ${installation.version}` : ''}
              </span>
              <span className="text-[var(--color-text-tertiary)]">
                {installation.phase === 'downloading' ? `${installation.bytes ? bytes(installation.bytes) : '0 B'} / ${installation.totalBytes ? bytes(installation.totalBytes) : '待查询'} · ${installation.speedBps ? bytes(installation.speedBps) : '0 B'}/s` : installation.updatedAt ? dateTime(installation.updatedAt) : ''}
              </span>
              {!isRemote && (installation.phase === 'querying' || installation.phase === 'downloading') ? (
                <button
                  type="button"
                  aria-label="取消引擎安装"
                  className="rounded p-1 text-red-300 transition hover:bg-red-400/10"
                  onClick={() => void call(Ipc.mossInferDownloadCancel).catch((error) => toast.push(error instanceof Error ? error.message : String(error), 'error'))}
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>
            <div
                role="progressbar"
                aria-label={`${downloadPhaseLabels[installation.phase]}进度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressIndeterminate ? undefined : progressPercent}
                aria-valuetext={downloadPhaseLabels[installation.phase]}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
            >
                <div
                  className={`h-full transition-[width] duration-300 ${
                    installation.phase === 'error' ? 'bg-red-400' : installation.phase === 'done' ? 'bg-emerald-400' : 'bg-accent-400'
                  } ${progressIndeterminate ? 'w-1/3 animate-pulse' : ''}`}
                  style={progressIndeterminate ? undefined : { width: `${progressPercent}%` }}
                />
            </div>
            {installation.note ? <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">{installation.note}</p> : null}
            {installation.error ? <p className="mt-1 break-words text-caption text-red-300">{installation.error}</p> : null}
            {installation.serverPath ? <p className="mt-1 break-all font-mono text-micro text-[var(--color-text-tertiary)]">{installation.serverPath}</p> : null}
          </div>
        ) : null}

        {isRemote ? (
        <div className="mt-4 space-y-3 border-t border-[var(--color-border-subtle)] pt-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-ui font-semibold">已安装引擎</h3>
            <Pill tone={selectedAvailable ? 'accent' : 'amber'}>{selectedAvailable ? '当前使用' : '未安装'}</Pill>
          </div>
          {selectedAvailable ? <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border-subtle)] bg-white/[0.02] px-3 py-2">
            <div className="min-w-0"><p className="text-ui font-medium">{selectedRemote?.version ?? '现有远端引擎'}</p><p className="mt-0.5 break-all font-mono text-micro text-[var(--color-text-tertiary)]">{selectedPath}</p></div>
            <IconButton label="删除远端引擎" onClick={() => void deleteEngine(engineHostId)} disabled={busy || installationInProgress}><Trash2 className="size-4" /></IconButton>
          </div> : <p className="rounded-md border border-dashed border-[var(--color-border-subtle)] px-3 py-3 text-caption text-[var(--color-text-tertiary)]">{selectedRemote?.error ?? '尚未发现可用引擎，可安装或自动查找已有目录。'}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-60 flex-1 space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">引擎目录</span><Input aria-label="远端引擎目录" value={enginePaths[engineHostId] ?? ''} onChange={(event) => setEnginePaths((previous) => ({ ...previous, [engineHostId]: event.target.value }))} className="font-mono text-caption" /></label>
            <Button tone="secondary" onClick={() => void saveEnginePath(engineHostId)} disabled={busy || installationInProgress}>保存路径</Button>
            <Button tone="ghost" onClick={() => void autoFindEngine(engineHostId)} disabled={busy || installationInProgress}>自动查找</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button tone="ghost" onClick={() => void checkRemote(engineHostId)} disabled={busy || installationInProgress}><RefreshCw className="size-4" />检测引擎</Button>
            <Button tone="ghost" onClick={() => void openSshTerminal(engineHostId)}><SquareTerminal className="size-4" />SSH 终端</Button>
            <Button tone="ghost" onClick={() => void prepareModel(engineHostId)} disabled={busy || preparing !== null}>{preparing === engineHostId ? <Spinner className="size-4" /> : <PackageCheck className="size-4" />}准备模型</Button>
            <span className="text-caption text-[var(--color-text-tertiary)]">{selectedRemote?.gpu}{selectedRemote?.checkedAt ? ` · ${dateTime(selectedRemote.checkedAt)}` : ''}</span>
          </div>
        </div>
        ) : (
        <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h3 className="text-ui font-semibold">本机已安装版本</h3>
              <p className="mt-0.5 text-caption text-[var(--color-text-tertiary)]">切换版本不会重新下载；当前正在使用的版本不可删除。</p>
            </div>
            <Pill tone={engineVersions.length ? 'neutral' : 'amber'}>{engineVersions.length} 个版本</Pill>
          </div>
          {engineVersions.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed border-[var(--color-border-subtle)] px-3 py-3 text-caption text-[var(--color-text-tertiary)]">
              <PackageCheck className="size-4" /> 尚无受 MossStudio 管理的本机版本。下载成功后会自动登记在这里。
            </div>
          ) : (
            <div className="space-y-1.5">
              {engineVersions.map((version) => (
                <div key={version.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-border-subtle)] bg-white/[0.02] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-caption font-medium">{version.name}</span>
                      {version.current ? <Pill tone="accent">当前使用</Pill> : null}
                      {!version.verified ? <Pill tone="amber">未验证</Pill> : null}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-micro text-[var(--color-text-tertiary)]">{version.path}</p>
                    {version.unverifiedReason ? <p className="mt-1 text-caption text-amber-200">{version.unverifiedReason}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!version.current || !version.verified || engine?.state === 'stale' ? (
                      <Button tone="secondary" onClick={() => void selectEngineVersion(version)} disabled={busy || installationInProgress || isRemote && installingRemote !== null}>
                        {!version.verified || version.current && engine?.state === 'stale' ? '验证并切换' : '切换到此版本'}
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`删除引擎版本 ${version.name}`}
                      title={version.current ? '当前使用的版本不能删除' : '删除此版本'}
                      onClick={() => void removeEngineVersion(version)}
                      disabled={version.current || busy || Boolean(installationInProgress)}
                      className="rounded p-2 text-[var(--color-text-tertiary)] transition hover:bg-red-400/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        )}

      </Card>


      </div>
      ) : (
      <div role="tabpanel" id="engine-panel-developer" aria-labelledby="engine-tab-developer" className="space-y-4">
        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold">第三方 / 本地开发引擎</h2>
              <p className="mt-1 max-w-[760px] text-caption leading-4 text-[var(--color-text-tertiary)]">
                用于自定义编译、未覆盖的 GPU 架构或本地调试。RTX 20/Turing 可优先下载上游 SM75 架构包。选择包含 moss-server 的安装根目录或 bin 目录；接入前会验证 protocol 2。
              </p>
            </div>
            <Pill tone={settings?.inferenceBackend === 'mossinfer' && localReady ? 'accent' : 'neutral'}>
              {settings?.inferenceBackend === 'mossinfer' && localReady ? '当前激活' : '未激活'}
            </Pill>
          </div>
          <div className="mt-3 rounded-lg border border-[var(--color-border-subtle)] bg-black/15 p-3">
            <p className="text-caption font-medium">当前引擎路径</p>
            <p className="mt-1 break-all font-mono text-caption text-[var(--color-text-secondary)]">
              {engine?.path ?? engine?.reason ?? '未配置本机引擎'}
            </p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button tone="secondary" onClick={() => void probeEngine()} disabled={busy || !engine?.path}>
              {busy ? <Spinner className="size-4" /> : <SquareTerminal className="size-4" />} 测试 hello / GPU
            </Button>
            <Button tone="primary" onClick={() => void selectThirdPartyEngine()} disabled={busy}>
              <FolderOpen className="size-4" /> 选择第三方引擎目录
            </Button>
          </div>
          {hello ? (
            <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-black/25 p-3 font-mono text-caption leading-4 text-[var(--color-text-secondary)]">{JSON.stringify(hello.raw, null, 2)}</pre>
          ) : null}
        </Card>

        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold">真实生成链路测试</h2>
              <p className="mt-1 max-w-[760px] text-caption leading-4 text-[var(--color-text-tertiary)]">
                使用一组已就绪的本机模型，沿用 Studio 的后端提交、模型绑定、引擎 load、生成和输出保存链路，执行 256×256 / 4 步测试。会实际占用 GPU 并写入一张测试图片。
              </p>
            </div>
            <Button tone="primary" onClick={() => void runEngineChainTest()} disabled={chainTesting || busy || !localReady}>
              {chainTesting ? <Spinner className="size-4" /> : <Cpu className="size-4" />} 运行真实生成测试
            </Button>
          </div>
          {chainTest ? (
            <div
              role="status"
              aria-live="polite"
              className={`mt-3 rounded-lg border p-3 text-caption ${
                chainTest.phase === 'failed'
                  ? 'border-red-400/25 bg-red-400/[0.05] text-red-200'
                  : chainTest.phase === 'succeeded'
                    ? 'border-emerald-400/25 bg-emerald-400/[0.04] text-emerald-200'
                    : 'border-[var(--color-border-subtle)] bg-white/[0.025] text-[var(--color-text-secondary)]'
              }`}
            >
              <p>{chainTest.message}</p>
              {chainTest.jobId ? <p className="mt-1 font-mono text-micro">任务：{chainTest.jobId}</p> : null}
              {chainTest.outputPath ? <p className="mt-1 break-all font-mono text-micro">{chainTest.outputPath}</p> : null}
              {chainTest.suggestReference ? (
                <Button
                  tone="secondary"
                  className="mt-2"
                  onClick={() => void retryChainTestWithReference()}
                  disabled={chainTesting}
                >
                  切换到 Reference 并重试
                </Button>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>
      )}
      <Modal
        open={fallbackOpen}
        onClose={() => setFallbackOpen(false)}
        title={preflight?.driverCompatible === false ? '需要更新 NVIDIA 显卡驱动' : '没有可用的 CUDA 13 cuBLASLt'}
        description={preflight?.error ?? '系统 CUDA 库缺失或版本不匹配。'}
        width="max-w-lg"
        footer={
          <>
            <Button tone="ghost" onClick={() => setFallbackOpen(false)}>取消</Button>
            {preflight?.driverCompatible === false ? (
              <Button tone="secondary" onClick={() => setFallbackOpen(false)}>知道了</Button>
            ) : (
              <>
                <Button data-oobe="engine" data-oobe-hint="下载并解压 CUDA 13 运行库；不需要 Python、uv 或 pip。" tone="primary" onClick={() => { setFallbackOpen(false); void runDownload('system-cuda', 'cu13', true) }}>准备 CUDA 13 库</Button>
                <Button data-oobe="engine" tone="secondary" onClick={() => { setFallbackOpen(false); void runDownload('bundled', 'cu13') }}>下载 bundled CUDA 13（内置 CUDA 库）</Button>
              </>
            )}
          </>
        }
      >
        <div className="p-4 text-ui leading-5 text-[var(--color-text-secondary)]">
          MossInfer 提供 CUDA 12 和 CUDA 13 构建，远端可选择 CUDA 版本。system-cuda 需要同主版本且兼容的 cuBLASLt；bundled 内置对应计算库。CUDA 13 需要 NVIDIA R580 或更新驱动。
        </div>
      </Modal>
    </div>
  )
}
