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
import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Events, Ipc } from '@shared/channels'
import type {
  Catalog,
  EngineRemoteProgress,
  JobRecord,
  LocalEngineVersion,
  ManagedHost,
  ModelBinding,
  MossInferDownloadState,
  MossInferRelease,
  Settings,
} from '@shared/types'
import type { BackendInfo } from '@shared/backend'
import { call, onEvent } from '../lib/api'
import { useApp } from '../store'
import { openWindow } from '../lib/windows'
import { bytes, dateTime } from '../lib/format'
import { electronStudioClient } from '../lib/studioClient'
import { Button, Card, IconButton, Input, Modal, Pill, Segmented, Spinner, useToast } from '../components/ui'

interface LocalEngineInfo {
  available: boolean
  path: string | null
  version?: string
  error?: string
}

type EngineTab = 'inference' | 'developer'

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
  const download = useApp((state) => state.mossInferDownload)
  const setMossInferDownload = useApp((state) => state.setMossInferDownload)
  const [githubToken, setGithubToken] = useState(settings?.githubToken ?? '')
  const [engine, setEngine] = useState<LocalEngineInfo | null>(null)
  const [engineVersions, setEngineVersions] = useState<LocalEngineVersion[]>([])
  const [releases, setReleases] = useState<MossInferRelease[]>([])
  const [releaseTag, setReleaseTag] = useState('')
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [loadingReleases, setLoadingReleases] = useState(false)
  const [probe, setProbe] = useState<Record<string, unknown> | null>(null)
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [remote, setRemote] = useState<Record<string, {
    online: boolean
    available: boolean
    path: string
    root: string
    gpu: string
    error?: string
    checkedAt: string
  }>>({})
  const [remoteProgress, setRemoteProgress] = useState<Record<string, EngineRemoteProgress>>({})
  const [enginePaths, setEnginePaths] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState<string | null>(null)
  const [installingRemote, setInstallingRemote] = useState<string | null>(null)
  const [channel, setChannel] = useState<'stable' | 'dev'>('stable')
  const [variant, setVariant] = useState<'bundled' | 'system-cuda'>('system-cuda')
  const [fallbackOpen, setFallbackOpen] = useState(false)
  const [preflight, setPreflight] = useState<{ supported: boolean; gpu: string; cublasLt: string[]; preferredFlavour?: 'cu12' | 'cu13'; error?: string } | null>(null)
  const [activeTab, setActiveTab] = useState<EngineTab>('inference')
  const [chainTest, setChainTest] = useState<EngineChainTest | null>(null)
  const [chainTesting, setChainTesting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [next, current, versions, hostList] = await Promise.all([
        call<LocalEngineInfo>(Ipc.engineStatus),
        call<MossInferDownloadState | null>(Ipc.mossInferDownloadState),
        call<LocalEngineVersion[]>(Ipc.engineVersions),
        call<ManagedHost[]>(Ipc.hostsList),
      ])
      setEngine(next)
      setMossInferDownload(current)
      setEngineVersions(versions)
      setHosts(hostList.filter((host) => host.kind === 'ssh'))
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [setMossInferDownload, toast])

  useEffect(() => { void refresh() }, [refresh])
  const refreshReleases = useCallback(async () => {
    setLoadingReleases(true)
    setReleaseError(null)
    try {
      const next = await call<MossInferRelease[]>(Ipc.mossInferReleases)
      setReleases(next)
      setReleaseTag((selected) => next.some((release) => release.tag === selected) ? selected : next[0]?.tag ?? '')
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingReleases(false)
    }
  }, [])
  useEffect(() => { void refreshReleases() }, [refreshReleases])
  useEffect(() => {
    const hostId = new URLSearchParams(location.search).get('hostId')
    if (hostId && hostId !== 'local') document.getElementById(`engine-${hostId}`)?.scrollIntoView({ block: 'start' })
  }, [location.key, location.search, hosts])
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
        const result = await call<{ online: boolean; available: boolean; path: string; root: string; gpu: string; error?: string; checkedAt: string }>(Ipc.engineRemoteStatus, { hostId: host.id })
        if (!cancelled) setRemote((previous) => ({ ...previous, [host.id]: result }))
      } catch (error) {
        if (!cancelled) setRemote((previous) => ({ ...previous, [host.id]: { online: false, available: false, path: host.engineRoot ?? '~/.mossstudio/engine', root: host.engineRoot ?? '~/.mossstudio/engine', gpu: '', error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() } }))
      }
    }))
    return () => { cancelled = true }
  }, [hosts])

  async function runDownload(selected: 'bundled' | 'system-cuda', flavour?: 'cu12' | 'cu13', cudaWheels = false): Promise<void> {
    setBusy(true)
    try {
      const next = await call<MossInferDownloadState>(Ipc.mossInferDownload, {
        channel,
        variant: selected,
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

  async function selectEngineVersion(id: string): Promise<void> {
    setBusy(true)
    try {
      await call(Ipc.engineVersionSelect, { id })
      toast.push('已切换当前引擎版本', 'success')
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
      await saveSettings(patch)
      toast.push('引擎性能设置已保存', 'success')
    } catch (error) {
      toast.push(`保存引擎性能设置失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  async function install(): Promise<void> {
    if (variant === 'system-cuda') {
      setBusy(true)
      try {
        const status = await call<{ supported: boolean; gpu: string; cublasLt: string[]; preferredFlavour?: 'cu12' | 'cu13'; error?: string }>(Ipc.engineSystemCuda)
        setPreflight(status)
        if (!status.supported || !status.preferredFlavour) {
          setFallbackOpen(true)
          return
        }
        await runDownload('system-cuda', status.preferredFlavour)
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
      const result = await call<Record<string, unknown>>(Ipc.engineProbe)
      setProbe(result)
      toast.push('引擎 hello 成功', 'success')
    } catch (error) {
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
      const next = await call<LocalEngineInfo>(Ipc.engineSelectDirectory, { path: directory })
      setEngine(next)
      setProbe(null)
      toast.push('第三方 MossInfer 已接入，并设为本机推理引擎', 'success')
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
      if (!engine?.available) throw new Error(engine?.error ?? '当前引擎不可用')
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
      const result = await call<{ path: string; revision: string; files: number }>(Ipc.enginePrepareRemoteModel, { hostId })
      toast.push(`远端模型已准备：${result.files} 个文件`, 'success')
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
    const path = enginePaths[hostId] ?? '~/.mossstudio/engine'
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
    try {
      await call(Ipc.hostsUpdatePaths, { id: hostId, engineRoot: enginePaths[hostId] })
      const result = await call<{ version: string; path: string; asset: string }>(Ipc.engineInstallRemote, { hostId })
      toast.push(`远端引擎 ${result.version} 已安装`, 'success')
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setInstallingRemote(null)
    }
  }

  async function checkRemote(hostId: string): Promise<void> {
    setBusy(true)
    try {
      const result = await call<{
        online: boolean
        available: boolean
        path: string
        root: string
        gpu: string
        error?: string
        checkedAt: string
      }>(Ipc.engineRemoteStatus, { hostId })
      setRemote((previous) => ({ ...previous, [hostId]: result }))
      toast.push(!result.online ? 'SSH 连接失败' : result.available ? 'SSH 在线，引擎就绪' : 'SSH 在线，引擎未安装', !result.online ? 'error' : result.available ? 'success' : 'info')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const downloading = download && !['done', 'error', 'canceled'].includes(download.phase)
  const selectedRelease = releases.find((release) => release.tag === releaseTag)
  const progressIndeterminate = Boolean(download && ['querying', 'extracting', 'cuda_libs'].includes(download.phase))
  const progressPercent = download ? download.phase === 'done' ? 100 : Math.max(0, Math.min(100, download.percent)) : 0

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
          <Pill tone={engine?.available ? 'accent' : 'amber'}>{engine?.available ? '本机引擎就绪' : '本机引擎缺失'}</Pill>
          <IconButton label="刷新" onClick={() => void refresh()} disabled={busy}><RefreshCw className="size-4" /></IconButton>
        </div>
      </header>

      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[14px] font-semibold">当前推理配置</h2>
              <Pill tone={settings?.inferenceBackend === 'mossinfer' && engine?.available ? 'accent' : 'amber'}>
                {settings?.inferenceBackend === 'mossinfer' && engine?.available ? '首页使用 MossInfer' : '首页未使用 MossInfer'}
              </Pill>
            </div>
            <p className="mt-1 break-all font-mono text-caption text-[var(--color-text-secondary)]">
              {settings?.inferenceBackend === 'mossinfer'
                ? engine?.path ?? engine?.error ?? 'MossInfer 引擎路径未配置'
                : '首页当前使用 Runner 后端；下方性能参数仅在 MossInfer 后端生效。'}
            </p>
            {engine?.version ? <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">{engine.version}</p> : null}
          </div>
          <Pill tone={engine?.available ? 'accent' : 'amber'}>{engine?.available ? '本机引擎 ready' : '本机引擎缺失'}</Pill>
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
        </div>
        <p className="mt-2 text-caption leading-4 text-[var(--color-text-tertiary)]">
          参数在下次引擎 load 时生效。BF16 模型配合 exact attention 时请选择 Reference；High 需要量化 DiT 或可用的 8-bit attention，Turbo 需要 INT4 DiT。
        </p>
      </Card>

      <nav role="tablist" aria-label="引擎管理模式" className="flex w-fit max-w-full gap-1 rounded-lg border border-[var(--color-border-subtle)] bg-black/15 p-1">
        {([
          ['inference', '推理引擎'],
          ['developer', '开发模式'],
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
      <Card className="p-4" data-oobe-host="local">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-accent-500/10 p-2 text-accent-300"><Cpu className="size-5" /></div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-semibold">本机 MossInfer</h2>
                <Pill tone={engine?.available ? 'accent' : 'red'}>{engine?.available ? 'ready' : 'missing'}</Pill>
              </div>
              <p className="mt-1 max-w-[720px] break-all font-mono text-caption text-[var(--color-text-tertiary)]">
                {engine?.path ?? engine?.error ?? '未检测到 moss-server'}
              </p>
              {engine?.version ? <p className="mt-1 text-caption text-[var(--color-text-secondary)]">{engine.version}</p> : null}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {(() => {
              // Only offer the repair when the installed engine is the system-cuda variant
              // AND no usable cuBLASLt is in sight (probe result wins over the preflight list).
              const probed = (probe?.['probe'] as { cublaslt?: { source?: string; error?: string } } | undefined)?.cublaslt
              const probeOk = Boolean(probed && !probed.error && probed.source)
              const preflightOk = Boolean(preflight && preflight.cublasLt.length > 0)
              const needsCudaLibs = Boolean(engine?.available) && (engine?.path?.includes('system-cuda') ?? false) && !probeOk && !preflightOk
              return needsCudaLibs ? (
                <Button tone="ghost" onClick={() => void installCudaWheels()} disabled={busy || !engine?.available}>
                  <ShieldCheck className="size-4" /> 补 CUDA 库
                </Button>
              ) : null
            })()}
          </div>
        </div>

        <div className="mt-4 grid gap-2 border-t border-[var(--color-border-subtle)] pt-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">渠道</span>
            <select value={channel} onChange={(event) => setChannel(event.target.value as 'stable' | 'dev')} className="app-input w-full">
              <option value="stable">GitHub Release（正式版）</option>
              <option value="dev">Dev artifact（需要 GitHub token）</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">包类型</span>
            <select value={variant} onChange={(event) => setVariant(event.target.value as 'bundled' | 'system-cuda')} className="app-input w-full">
              <option value="system-cuda">system CUDA（默认，需系统 cuBLASLt）</option>
              <option value="bundled">bundled CUDA（+700MB，免系统库）</option>
            </select>
          </label>
          <Button data-oobe="engine" data-oobe-hint="选择渠道和包类型后下载引擎。缺少系统 CUDA 库时，可在弹窗中选择 bundled 包。" tone="primary" className="self-end" onClick={() => void install()} disabled={busy || Boolean(downloading)}>
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
                  disabled={loadingReleases || releases.length === 0 || Boolean(downloading)}
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
              <Button tone="ghost" onClick={() => void refreshReleases()} disabled={loadingReleases || Boolean(downloading)}>
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

        {preflight ? (
          <p className="mt-2 text-caption leading-4 text-[var(--color-text-tertiary)]">
            预检：{preflight.gpu || preflight.error} · flavour {preflight.preferredFlavour ?? '无'} · cuBLASLt {preflight.cublasLt.length ? preflight.cublasLt.join(', ') : '未找到'}
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

        {download ? (
          <div
            role="status"
            aria-live="polite"
            className={`mt-3 rounded-lg border p-3 ${
              download.phase === 'error'
                ? 'border-red-400/25 bg-red-400/[0.05]'
                : download.phase === 'done'
                  ? 'border-emerald-400/25 bg-emerald-400/[0.04]'
                  : 'border-[var(--color-border-subtle)] bg-white/[0.025]'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-caption">
              <span className="flex items-center gap-1.5 font-medium">
                {download.phase === 'done' ? <CheckCircle2 className="size-4 text-emerald-300" /> : null}
                {download.phase !== 'done' && download.phase !== 'error' && download.phase !== 'canceled' ? <RefreshCw className="size-3.5 animate-spin text-accent-300" /> : null}
                {downloadPhaseLabels[download.phase]}{download.version ? ` · ${download.version}` : ''}
              </span>
              <span className="text-[var(--color-text-tertiary)]">
                {download.phase === 'downloading' ? `${bytes(download.bytes)} / ${bytes(download.totalBytes)} · ${bytes(download.speedBps)}/s` : download.updatedAt ? dateTime(download.updatedAt) : ''}
              </span>
              {download.phase === 'querying' || download.phase === 'downloading' ? (
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
                aria-label={`${downloadPhaseLabels[download.phase]}进度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressIndeterminate ? undefined : progressPercent}
                aria-valuetext={downloadPhaseLabels[download.phase]}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
            >
                <div
                  className={`h-full transition-[width] duration-300 ${
                    download.phase === 'error' ? 'bg-red-400' : download.phase === 'done' ? 'bg-emerald-400' : 'bg-accent-400'
                  } ${progressIndeterminate ? 'w-1/3 animate-pulse' : ''}`}
                  style={progressIndeterminate ? undefined : { width: `${progressPercent}%` }}
                />
            </div>
            {download.note ? <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">{download.note}</p> : null}
            {download.error ? <p className="mt-1 break-words text-caption text-red-300">{download.error}</p> : null}
            {download.serverPath ? <p className="mt-1 break-all font-mono text-micro text-[var(--color-text-tertiary)]">{download.serverPath}</p> : null}
          </div>
        ) : null}

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
                    </div>
                    <p className="mt-0.5 truncate font-mono text-micro text-[var(--color-text-tertiary)]">{version.path}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!version.current ? (
                      <Button tone="secondary" onClick={() => void selectEngineVersion(version.id)} disabled={busy || Boolean(downloading)}>
                        切换到此版本
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`删除引擎版本 ${version.name}`}
                      title={version.current ? '当前使用的版本不能删除' : '删除此版本'}
                      onClick={() => void removeEngineVersion(version)}
                      disabled={version.current || busy || Boolean(downloading)}
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

      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold">远端引擎</h2>
            <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">Linux x86_64 + NVIDIA，SSH 启动同一 sidecar 协议。</p>
          </div>
          <div className="flex items-center gap-1.5">
            <Pill tone={hosts.some((host) => remote[host.id]?.online) ? 'accent' : 'neutral'}>
              {hosts.filter((host) => remote[host.id]?.online).length}/{hosts.length} SSH 在线
            </Pill>
            <Pill tone={hosts.some((host) => remote[host.id]?.available) ? 'accent' : 'amber'}>
              {hosts.filter((host) => remote[host.id]?.available).length} 引擎就绪
            </Pill>
          </div>
        </div>
        {!githubToken.trim() ? (
          <div className="mt-3 rounded border border-amber-500/25 bg-amber-500/[0.05] px-2.5 py-2 text-caption leading-4 text-amber-200">
            上游目前没有 GitHub Release，远端安装需要 GitHub Token；Token 只在本地调用 GitHub API，不会发到远端。
          </div>
        ) : null}
        <div className="mt-3 space-y-1.5">
          {hosts.length === 0 ? <p className="text-caption text-[var(--color-text-tertiary)]">还没有 SSH 主机。先在设备页添加 Linux NVIDIA 主机。</p> : null}
          {hosts.map((host) => {
            const status = remote[host.id]
            const progress = remoteProgress[host.id]
            return (
              <div key={host.id} id={`engine-${host.id}`} data-oobe-host={host.id} className="scroll-mt-4 rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.02] p-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <HardDrive className="size-4 text-[var(--color-text-tertiary)]" />
                      <span className="text-ui font-medium">{host.name}</span>
                      <span className="font-mono text-micro text-[var(--color-text-tertiary)]">{host.user}@{host.host}</span>
                      <Pill tone={status?.online ? 'accent' : 'red'}>{status ? (status.online ? 'SSH 在线' : 'SSH 离线') : '检测中'}</Pill>
                      <Pill tone={status?.available ? 'accent' : status?.online ? 'amber' : 'neutral'}>
                        {status?.available ? '引擎 ready' : status?.online ? '引擎 missing' : '未知'}
                      </Pill>
                    </div>
                    <p className="mt-1 truncate text-caption text-[var(--color-text-secondary)]">{status?.gpu || '等待 GPU 探测'}</p>
                    <p className="mt-0.5 truncate font-mono text-micro text-[var(--color-text-tertiary)]">
                      {status?.path ?? host.engineRoot ?? '~/.mossstudio/engine/bin/moss-server'}
                      {status?.checkedAt ? ` · ${dateTime(status.checkedAt)}` : ''}
                      {status?.error ? ` · ${status.error}` : ''}
                    </p>
                    {host.modelPath ? <p className="mt-0.5 truncate font-mono text-micro text-[var(--color-text-tertiary)]">模型：{host.modelPath}</p> : null}
                    <div className="mt-1.5 flex items-center gap-1">
                      <span className="shrink-0 text-micro text-[var(--color-text-tertiary)]">引擎目录</span>
                      <Input value={enginePaths[host.id] ?? ''} onChange={(event) => setEnginePaths((previous) => ({ ...previous, [host.id]: event.target.value }))} className="h-6 min-w-0 flex-1 font-mono text-micro" />
                      <Button tone="ghost" onClick={() => void saveEnginePath(host.id)}>保存路径</Button>
                      <Button tone="ghost" onClick={() => void autoFindEngine(host.id)}>自动查找</Button>
                      <Button tone="ghost" onClick={() => void deleteEngine(host.id)}>删除</Button>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    <Button tone="ghost" onClick={() => void checkRemote(host.id)} disabled={busy}>检测</Button>
                    <Button tone="ghost" onClick={() => void openSshTerminal(host.id)}>SSH 终端</Button>
                    {installingRemote === host.id ? <span className="px-1 text-micro text-amber-300">安装中…</span> : <Button data-oobe="engine" data-oobe-hint="为清单选中的 SSH 主机安装引擎；已有引擎可先自动查找并检测。" tone="ghost" onClick={() => void installRemote(host.id)} disabled={busy || installingRemote !== null}>安装/更新</Button>}
                    <Button tone="ghost" onClick={() => void prepareModel(host.id)} disabled={busy || preparing !== null}>{preparing === host.id ? <Spinner className="size-4" /> : '准备模型'}</Button>
                  </div>
                </div>
                {progress ? (
                  <div className="mt-2">
                    <div className="flex justify-between text-micro">
                      <span className={progress.phase === 'error' ? 'text-red-300' : 'text-[var(--color-text-secondary)]'}>{progress.message}</span>
                      <span className="text-[var(--color-text-tertiary)]">{progress.percent ?? 0}%</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                      <div className={`h-full rounded-full ${progress.phase === 'error' ? 'bg-red-400' : 'bg-accent-400'} transition-all`} style={{ width: `${progress.percent ?? 0}%` }} />
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </Card>
      </div>
      ) : (
      <div role="tabpanel" id="engine-panel-developer" aria-labelledby="engine-tab-developer" className="space-y-4">
        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold">第三方 / 本地开发引擎</h2>
              <p className="mt-1 max-w-[760px] text-caption leading-4 text-[var(--color-text-tertiary)]">
                用于 SM75、定制编译或本地调试。选择包含 moss-server 的安装根目录或 bin 目录；接入前会验证 protocol 2，成功后会设为首页使用的 MossInfer 引擎。
              </p>
            </div>
            <Pill tone={settings?.inferenceBackend === 'mossinfer' && engine?.available ? 'accent' : 'neutral'}>
              {settings?.inferenceBackend === 'mossinfer' && engine?.available ? '当前激活' : '未激活'}
            </Pill>
          </div>
          <div className="mt-3 rounded-lg border border-[var(--color-border-subtle)] bg-black/15 p-3">
            <p className="text-caption font-medium">当前引擎路径</p>
            <p className="mt-1 break-all font-mono text-caption text-[var(--color-text-secondary)]">
              {engine?.path ?? engine?.error ?? '未配置本机引擎'}
            </p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button tone="secondary" onClick={() => void probeEngine()} disabled={busy || !engine?.available}>
              {busy ? <Spinner className="size-4" /> : <SquareTerminal className="size-4" />} 测试 hello / GPU
            </Button>
            <Button tone="primary" onClick={() => void selectThirdPartyEngine()} disabled={busy}>
              <FolderOpen className="size-4" /> 选择第三方引擎目录
            </Button>
          </div>
          {probe ? (
            <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-black/25 p-3 font-mono text-caption leading-4 text-[var(--color-text-secondary)]">{JSON.stringify(probe, null, 2)}</pre>
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
            <Button tone="primary" onClick={() => void runEngineChainTest()} disabled={chainTesting || busy || !engine?.available}>
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
        title="没有可用的系统 cuBLASLt"
        description={preflight?.error ?? '系统 CUDA 库缺失或版本不匹配。'}
        width="max-w-lg"
        footer={
          <>
            <Button tone="ghost" onClick={() => setFallbackOpen(false)}>取消</Button>
            <Button data-oobe="engine" data-oobe-hint="选择一种方式补齐 CUDA 库：自动解压系统库，或下载包含 CUDA 的 bundled 包。" tone="primary" onClick={() => { setFallbackOpen(false); void runDownload('system-cuda', preflight?.preferredFlavour ?? 'cu13', true) }}>下载 system + 解压 CUDA 库</Button>
            <Button data-oobe="engine" tone="secondary" onClick={() => { setFallbackOpen(false); void runDownload('bundled') }}>下载 bundled（+700MB）</Button>
          </>
        }
      >
        <div className="p-4 text-ui leading-5 text-[var(--color-text-secondary)]">
          system-cuda 包需要系统提供 libcublasLt。可以直接下载 system 引擎并由 MossStudio 原生解压 NVIDIA wheels（不需要 Python/uv/pip），或下载完整 bundled 包。
        </div>
      </Modal>
    </div>
  )
}
