import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  Layers,
  Package,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Ipc } from '@shared/channels'
import type { AdapterEntry, DownloadTask, ManagedHost, ModelEntry } from '@shared/types'
import { Events } from '@shared/channels'
import { call, onEvent } from '../lib/api'
import { percent } from '../lib/format'
import { useApp } from '../store'
import { MotionPanel } from '../components/motion'
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  Input,
  Modal,
  Pill,
  ProgressBar,
  Spinner,
  cn,
  useToast,
} from '../components/ui'

function bytes(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2).replace(/\.?0+$/, '')} GB`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, '')} MB`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`
  return `${value} B`
}

const labels: Record<DownloadTask['state'], string> = {
  queued: '等待下载',
  running: '下载中',
  verifying: '校验中',
  paused: '已暂停',
  canceled: '已取消',
  done: '已完成',
  error: '下载失败',
}
const categories = [
  { id: 'all', name: '全部', icon: Package },
  { id: 'dit', name: 'MOSS 模型', icon: Layers },
  { id: 'text_encoder', name: 'Qwen 编码器', icon: Cpu },
  { id: 'vae', name: 'VAE', icon: Package },
  { id: 'adapter', name: '适配器', icon: ShieldCheck },
] as const
type Entry = { kind: 'model'; value: ModelEntry } | { kind: 'adapter'; value: AdapterEntry }

/** MossInfer 引擎视角的组件兼容性分层。 */
type EngineCompat =
  | { kind: 'bindable'; label: string; hint?: undefined }
  | { kind: 'override'; label: string; hint: string }
  | { kind: 'legacy'; label: string; hint: string }

function engineCompat(model: ModelEntry): EngineCompat {
  const legacy = model.precision === 'fp16' || model.tags.includes('fixed')
  if ((model.format ?? 'diffusers') === 'diffusers') {
    if (legacy) {
      return {
        kind: 'legacy',
        label: '旧 PyTorch 链路',
        hint: 'KBlueLeaf fp16-fixed，面向旧 Python runner（2080Ti / V100）；仍可绑定 fp16 bundle，MossInfer 建议改用 bf16 组合。',
      }
    }
    return { kind: 'bindable', label: '可绑定 bundle' }
  }
  if (legacy) {
    return {
      kind: 'legacy',
      label: '旧 PyTorch 链路',
      hint: 'KBlueLeaf fp16-fixed 单文件，供旧 PyTorch 链路 / ComfyUI 使用；MossInfer 建议改用 bf16 bundle。',
    }
  }
  const file =
    model.role === 'dit'
      ? 'dit_file'
      : model.role === 'text_encoder'
        ? 'text_encoder_file'
        : 'vae_file'
  const tier =
    model.precision === 'int8'
      ? model.role === 'dit'
        ? 'high 档 · INT8 GEMM'
        : 'high 档配套 · INT8 编码器'
      : model.precision === 'int4'
        ? 'turbo 档 · INT4（需显式选择）'
        : model.precision === 'w4a8'
          ? 'W4A8 量化文本编码器'
          : model.precision === 'bf16'
            ? 'reference 档精度'
            : '引擎级覆盖'
  return { kind: 'override', label: '引擎单文件覆盖', hint: `MossInfer · ${file} · ${tier}` }
}

export function ModelsPage(): React.JSX.Element {
  const location = useLocation()
  const catalog = useApp((s) => s.catalog)
  const downloads = useApp((s) => s.downloads)
  const instances = useApp((s) => s.instances)
  const refreshCatalog = useApp((s) => s.refreshCatalog)
  const downloadModel = useApp((s) => s.downloadModel)
  const downloadAdapter = useApp((s) => s.downloadAdapter)
  const pauseDownload = useApp((s) => s.pauseDownload)
  const cancelDownload = useApp((s) => s.cancelDownload)
  const deleteModel = useApp((s) => s.deleteModel)
  const toast = useToast()
  const [category, setCategory] = useState<string>('dit')
  const [format, setFormat] = useState('diffusers')
  const [installedOnly, setInstalledOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [bundleId, setBundleId] = useState('moss-sft')
  const [pending, setPending] = useState<Entry | null>(null)
  const [removing, setRemoving] = useState<Entry | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [mode, setMode] = useState<'local' | 'remote'>('local')
  const deferredQuery = useDeferredValue(query)
  const settings = useApp((s) => s.settings)
  const [localRoot, setLocalRoot] = useState(settings?.modelsRoot ?? '')
  const [localBusy, setLocalBusy] = useState(false)
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [remoteHostId, setRemoteHostId] = useState('')
  const [remoteRoot, setRemoteRoot] = useState('~/.mossstudio/models')
  const [remoteModelPath, setRemoteModelPath] = useState('')
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteScan, setRemoteScan] = useState<{ root: string; files: number; models: Array<{ id: string; installed: boolean; path?: string }>; adapters: Array<{ id: string; installed: boolean; path?: string }> } | null>(null)
  const [remoteScanBusy, setRemoteScanBusy] = useState(false)
  const [remoteCategory, setRemoteCategory] = useState('all')
  const [remoteModelBusy, setRemoteModelBusy] = useState<string | null>(null)
  const remoteHost = hosts.find((host) => host.id === remoteHostId) ?? null
  useEffect(() => {
    const query = new URLSearchParams(location.search)
    const component = query.get('component')
    if (!component) return
    const hostId = query.get('hostId') ?? 'local'
    setMode(hostId === 'local' ? 'local' : 'remote')
    if (hostId !== 'local') setRemoteHostId(hostId)
    if (query.get('bundle')) setBundleId(query.get('bundle')!)
    setCategory(component === 'support' ? 'all' : component)
    setRemoteCategory(component === 'support' ? 'all' : component)
    setFormat('diffusers')
    setInstalledOnly(false)
    setQuery('')
  }, [location.key, location.search])
  useEffect(() => { setLocalRoot(settings?.modelsRoot ?? '') }, [settings?.modelsRoot])
  useEffect(() => {
    const load = async (): Promise<void> => {
      const list = (await call<ManagedHost[]>(Ipc.hostsList)).filter((host) => host.kind === 'ssh')
      setHosts(list)
      setRemoteHostId((current) => current || list[0]?.id || '')
    }
    void load().catch(() => undefined)
    return onEvent(Events.hostsChanged, () => { void load().catch(() => undefined) })
  }, [])
  useEffect(() => {
    if (!remoteHost) return
    void scanRemote()
    setRemoteRoot(remoteHost.modelsRoot ?? '~/.mossstudio/models')
    setRemoteModelPath(remoteHost.modelPath ?? '')
  }, [remoteHost?.id])

  const bundle = catalog?.bundles?.find((b) => b.id === bundleId) ?? catalog?.bundles?.find((b) => b.recommended) ?? catalog?.bundles?.[0]
  const engineLabel =
    settings?.inferenceBackend === 'mossinfer'
      ? `MossInfer · ${settings?.mossInferTier ?? 'high'} 档`
      : 'Python runner'
  const bundleModels = bundle
    ? [...Object.values(bundle.components), bundle.support]
        .map((id) => catalog?.models.find((m) => m.id === id))
        .filter((m): m is ModelEntry => Boolean(m))
    : []
  const missing = bundleModels.filter((m) => !m.installed)
  const remaining = missing.reduce((n, model) => {
    const task = downloads.find((t) => t.kind === 'model' && t.targetId === model.id)
    return n + Math.max(0, (task?.totalBytes || model.sizeBytes) - (task?.bytes ?? 0))
  }, 0)
  const bundleTasks = downloads.filter((t) => missing.some((m) => m.id === t.targetId))
  const bundleRunning = bundleTasks.some((t) =>
    ['running', 'queued', 'verifying'].includes(t.state),
  )
  const active = downloads.filter((t) => t.state !== 'done')
  const list = useMemo((): Entry[] => {
    const entries: Entry[] =
      category === 'adapter'
        ? (catalog?.adapters ?? []).map((value) => ({ kind: 'adapter', value }))
        : (catalog?.models ?? [])
            .filter(
              (m) =>
                (category === 'all' ||
                  m.role === category ||
                  (category === 'dit' && m.role === 'full')) &&
                (format === 'all' || (m.format ?? 'diffusers') === format),
            )
            .map((value) => ({ kind: 'model', value }))
    const q = deferredQuery.trim().toLowerCase()
    return entries.filter(
      ({ value }) =>
        (!installedOnly || value.installed) &&
        (!q ||
          `${value.name} ${value.repo} ${'precision' in value ? value.precision : ''}`
            .toLowerCase()
            .includes(q)),
    )
  }, [catalog, category, format, installedOnly, deferredQuery])

  async function install(): Promise<void> {
    if (!bundle) return
    setBusy('bundle')
    try {
      await call(Ipc.modelBundleInstall, { id: bundle.id })
      await refreshCatalog()
      toast.push('缺失组件已加入下载队列', 'success')
    } catch (e) {
      toast.push(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  async function importFolder(): Promise<void> {
    setBusy('import')
    try {
      const result = await call<{
        canceled: boolean
        added: number
        duplicates: number
      }>(Ipc.modelsImportFolder)
      if (result.canceled) return
      await refreshCatalog()
      setCategory('all')
      setFormat('comfyui')
      setInstalledOnly(false)
      setQuery('')
      toast.push(
        result.added
          ? `已导入 ${result.added} 个模型文件，重复内容 ${result.duplicates} 个已跳过`
          : `所选目录中的 ${result.duplicates} 个文件已导入过`,
        'success',
      )
    } catch (e) {
      toast.push(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  async function start(entry: Entry): Promise<void> {
    setBusy(entry.value.id)
    try {
      if (entry.kind === 'model') await downloadModel(entry.value.id)
      else await downloadAdapter(entry.value.id)
      setPending(null)
    } catch (e) {
      toast.push(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  async function resume(task: DownloadTask): Promise<void> {
    if (task.kind === 'model') {
      const value = catalog?.models.find((m) => m.id === task.targetId)
      if (value) return start({ kind: 'model', value })
    } else {
      const value = catalog?.adapters.find((m) => m.id === task.targetId)
      if (value) return start({ kind: 'adapter', value })
    }
    toast.push('条目已不在当前目录中，请刷新模型库。', 'error')
  }
  async function cancel(task: DownloadTask): Promise<void> {
    try {
      await cancelDownload(task.id)
      toast.push('下载已取消；已写入的临时分片保留，可重新开始', 'info')
    } catch (e) {
      toast.push(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  async function remove(): Promise<void> {
    if (!removing) return
    setBusy('delete')
    try {
      await deleteModel(removing.kind, removing.value.id)
      setRemoving(null)
      toast.push('组件已移除，共享文件已保留', 'success')
    } catch (e) {
      toast.push(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  const users = removing
    ? instances.filter(
        (i) =>
          i.models.includes(removing.value.id) ||
          i.adapters.includes(removing.value.id) ||
          Object.values(i.modelBinding ?? {}).includes(removing.value.id),
      )
    : []

  async function scanRemote(): Promise<void> {
    if (!remoteHost) return
    setRemoteScanBusy(true)
    try {
      const result = await call<{ root: string; files: number; models: Array<{ id: string; installed: boolean; path?: string }>; adapters: Array<{ id: string; installed: boolean; path?: string }> }>(Ipc.modelsRemoteInventory, { hostId: remoteHost.id, modelsRoot: remoteRoot })
      setRemoteScan(result)
    } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') } finally { setRemoteScanBusy(false) }
  }

  async function downloadRemoteModel(model: { id: string; name: string }): Promise<void> {
    if (!remoteHost) return
    setRemoteModelBusy(model.id)
    try {
      await call(Ipc.hostsUpdatePaths, { id: remoteHost.id, modelsRoot: remoteRoot })
      await call(Ipc.modelsRemoteDownload, { hostId: remoteHost.id, modelId: model.id })
      toast.push(`远端模型已下载：${model.name}`, 'success')
      await scanRemote()
    } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') } finally { setRemoteModelBusy(null) }
  }
  async function deleteRemoteModel(model: { id: string; name: string }, path: string): Promise<void> {
    if (!remoteHost) return
    if (!window.confirm(`删除远端模型文件？\n${path}`)) return
    setRemoteModelBusy(model.id)
    try {
      await call(Ipc.remoteResourceRemove, { hostId: remoteHost.id, path })
      toast.push(`远端模型已删除：${model.name}`, 'success')
      await scanRemote()
    } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') } finally { setRemoteModelBusy(null) }
  }

  async function saveRemotePaths(): Promise<void> {
    if (!remoteHost) return
    setRemoteBusy(true)
    try {
      await call(Ipc.hostsUpdatePaths, { id: remoteHost.id, modelsRoot: remoteRoot, modelPath: remoteModelPath })
      toast.push('远端模型路径已保存', 'success')
    } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') } finally { setRemoteBusy(false) }
  }
  async function findRemoteModel(): Promise<void> {
    if (!remoteHost) return
    setRemoteBusy(true)
    try {
      const result = await call<{ found?: string; message: string }>(Ipc.remoteResourceInspect, { hostId: remoteHost.id, kind: 'models', path: remoteRoot })
      if (result.found) { setRemoteModelPath(result.found); await call(Ipc.hostsUpdatePaths, { id: remoteHost.id, modelPath: result.found }) }
      toast.push(result.message, result.found ? 'success' : 'info')
    } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') } finally { setRemoteBusy(false) }
  }
  async function prepareRemote(): Promise<void> {
    if (!remoteHost) return
    setRemoteBusy(true)
    try {
      await call(Ipc.hostsUpdatePaths, { id: remoteHost.id, modelsRoot: remoteRoot })
      const result = await call<{ path: string; files: number }>(Ipc.enginePrepareRemoteModel, { hostId: remoteHost.id })
      setRemoteModelPath(result.path)
      toast.push(`远端模型已准备：${result.files} 个文件`, 'success')
    } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') } finally { setRemoteBusy(false) }
  }
  async function removeRemote(): Promise<void> {
    if (!remoteHost || !remoteModelPath) return
    if (!window.confirm(`删除远端模型目录？\n${remoteModelPath}`)) return
    setRemoteBusy(true)
    try {
      await call(Ipc.remoteResourceRemove, { hostId: remoteHost.id, path: remoteModelPath })
      setRemoteModelPath('')
      await call(Ipc.hostsUpdatePaths, { id: remoteHost.id, modelPath: '' })
      toast.push('远端模型目录已删除', 'success')
    } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') } finally { setRemoteBusy(false) }
  }

  async function saveLocalRoot(): Promise<void> {
    setLocalBusy(true)
    try {
      await call(Ipc.settingsUpdate, { modelsRoot: localRoot.trim() || null })
      await refreshCatalog()
      toast.push('本地模型目录已更新', 'success')
    } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') } finally { setLocalBusy(false) }
  }
  async function pickLocalRoot(): Promise<void> {
    const path = await call<string | null>(Ipc.pickDialog, { kind: 'folder', title: '选择本地模型目录' })
    if (path) setLocalRoot(path)
  }
  async function openLocalRoot(): Promise<void> {
    try { await call(Ipc.openPath, { path: settings?.modelsRoot ?? '' }) } catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') }
  }

  return (
    <div className="model-management space-y-5 pb-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">模型库</h1>
          <p className="mt-1 text-ui text-[var(--color-text-secondary)]">
            MossInfer 按 bundle 组合原地加载模型；单文件组件可作引擎级覆盖。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button tone="secondary" disabled={busy !== null} onClick={() => void importFolder()}>
            {busy === 'import' ? <Spinner className="size-4" /> : <FolderOpen className="size-4" />}
            导入本地模型
          </Button>
          <IconButton label="刷新模型库" onClick={() => void refreshCatalog()}>
            <RefreshCw className="size-4" />
          </IconButton>
        </div>
      </header>

      <div className="flex items-center gap-1 border-b border-[var(--color-border-subtle)]">
        <button type="button" onClick={() => setMode('local')} className={cn('border-b-2 px-4 py-2 text-ui', mode === 'local' ? 'border-accent-400 text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-tertiary)]')}>本地模型管理</button>
        <button type="button" onClick={() => setMode('remote')} className={cn('border-b-2 px-4 py-2 text-ui', mode === 'remote' ? 'border-accent-400 text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-tertiary)]')}>远端模型管理</button>
      </div>

      <div data-oobe-host={remoteHostId} className={mode === 'remote' ? 'space-y-5' : 'hidden'}>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><HardDrive className="size-4 text-accent-300" /><h2 className="text-[14px] font-semibold">远端模型</h2></div>
            <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">在 Linux SSH 主机选择模型缓存目录、自动查找已有模型或准备默认 SFT。</p>
          </div>
          <span className="text-caption text-[var(--color-text-tertiary)]">远端权重不占本机磁盘</span>
        </div>
        {hosts.length === 0 ? <p className="mt-3 text-caption text-[var(--color-text-tertiary)]">还没有 SSH 主机，请先在设备页添加。</p> : (
          <div className="mt-3 space-y-2">
            <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
              <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">SSH 主机</span><select value={remoteHostId} onChange={(event) => setRemoteHostId(event.target.value)} className="app-input w-full">{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>
              <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">模型缓存根目录</span><Input value={remoteRoot} onChange={(event) => setRemoteRoot(event.target.value)} /></label>
            </div>
            <label className="block space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">模型目录（可自动查找）</span><Input value={remoteModelPath} onChange={(event) => setRemoteModelPath(event.target.value)} placeholder="/home/.../snapshots/..." /></label>
            <div className="flex flex-wrap gap-1.5">
              <Button tone="secondary" onClick={() => void saveRemotePaths()} disabled={remoteBusy}>保存路径</Button>
              <Button data-oobe="model" tone="ghost" onClick={() => void findRemoteModel()} disabled={remoteBusy}>自动查找</Button>
              <Button data-oobe="model" data-oobe-hint="在这台 SSH 主机准备完整的默认模型；已有权重可先自动查找。远端下载不占用本机模型空间。" tone="ghost" onClick={() => void prepareRemote()} disabled={remoteBusy}>{remoteBusy ? <Spinner className="size-4" /> : '准备默认 SFT'}</Button>
              <Button tone="ghost" onClick={() => void removeRemote()} disabled={remoteBusy || !remoteModelPath}>删除模型目录</Button>
            </div>
          </div>
        )}
      </Card>


      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav data-oobe="model" data-oobe-hint-title="按组件挑选" data-oobe-hint-position="bottom" data-oobe-hint="也可以在下方按 MOSS 模型、Qwen 编码器、VAE 等分页单独挑选并下载组件，已有编码器和 VAE 可复用。" aria-label="远端组件分类" className="flex max-w-full gap-1 overflow-x-auto border-b border-[var(--color-border-subtle)]">
            {categories.map(({ id, name, icon: Icon }) => (
              <button key={id} onClick={() => setRemoteCategory(id)} className={cn('flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-ui transition-colors', remoteCategory === id ? 'border-accent-400 text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]')}>
                <Icon className="size-4" />{name}
              </button>
            ))}
          </nav>
          <label className="flex h-8 w-full items-center gap-2 rounded-[4px] border border-[var(--color-border-subtle)] bg-white/[0.025] px-2.5 sm:w-52">
            <Search className="size-4 shrink-0 text-[var(--color-text-tertiary)]" />
            <input aria-label="搜索远端模型" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或来源" className="w-full min-w-0 bg-transparent text-ui outline-none" />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {remoteCategory !== 'adapter' ? <select aria-label="远端组件格式" value={format} onChange={(event) => setFormat(event.target.value)} className="model-select"><option value="diffusers">Diffusers · 可绑定 bundle</option><option value="comfyui">ComfyUI 单文件 · MossInfer 覆盖</option><option value="all">全部格式</option></select> : null}
            <label className="flex items-center gap-1.5 text-ui text-[var(--color-text-secondary)]"><input type="checkbox" checked={installedOnly} onChange={(event) => setInstalledOnly(event.target.checked)} className="accent-[var(--color-accent-500)]" />仅已部署</label>
          </div>
          <span className="text-ui text-[var(--color-text-tertiary)]">{remoteScan ? `${remoteScan.root} · ${remoteScan.files} 个文件` : '扫描远端模型'}</span>
        </div>
        {remoteCategory === 'adapter' ? (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {(catalog?.adapters ?? []).filter((adapter) => !query.trim() || `${adapter.name} ${adapter.repo}`.toLowerCase().includes(query.trim().toLowerCase())).map((adapter) => {
              const scan = remoteScan?.adapters.find((entry) => entry.id === adapter.id)
              const installed = Boolean(scan?.installed)
              const working = remoteModelBusy === adapter.id
              return (
                <Card key={adapter.id} className="flex min-w-0 flex-col p-4">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-1.5"><span className="truncate text-[13px] font-medium">{adapter.name}</span><Pill tone={adapter.provider === 'hf' ? 'blue' : 'neutral'}>{adapter.provider.toUpperCase()}</Pill><Pill tone="neutral">{adapter.kind.toUpperCase()}</Pill></div><p className="mt-2 min-h-10 text-ui leading-5 text-[var(--color-text-secondary)]">{adapter.notes ?? '远端适配器。'}</p></div><Pill tone={installed ? 'accent' : 'neutral'}>{installed ? '已部署' : '未部署'}</Pill></div>
                  <details className="my-2 text-caption text-[var(--color-text-tertiary)]"><summary className="cursor-pointer">来源与路径</summary><p className="mt-1 break-all font-mono">{adapter.repo}</p><p className="break-all font-mono">{scan?.path ?? '远端目录未发现此适配器'}</p></details>
                  <div className="mt-auto flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-3"><span className="text-ui tabular-nums text-[var(--color-text-tertiary)]">{bytes(adapter.sizeBytes)} <span className="ml-1.5">{adapter.license}</span></span>{installed && scan?.path ? <Button tone="ghost" onClick={() => void deleteRemoteModel(adapter, scan.path!)} disabled={working}>删除</Button> : <Button tone="secondary" onClick={() => void downloadRemoteModel(adapter)} disabled={working || !remoteHost}>{working ? <Spinner className="size-4" /> : <Download className="size-4" />}下载</Button>}</div>
                </Card>
              )
            })}
          </div>
        ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {(catalog?.models ?? []).filter((model) => (remoteCategory === 'all' || model.role === remoteCategory || (remoteCategory === 'dit' && model.role === 'full')) && (format === 'all' || (model.format ?? 'diffusers') === format) && (!deferredQuery.trim() || `${model.name} ${model.repo}`.toLowerCase().includes(deferredQuery.trim().toLowerCase()))).filter((model) => !installedOnly || remoteScan?.models.find((entry) => entry.id === model.id)?.installed).map((model) => {
            const scan = remoteScan?.models.find((entry) => entry.id === model.id)
            const installed = Boolean(scan?.installed)
            const working = remoteModelBusy === model.id
            return (
              <Card key={model.id} className="flex min-w-0 flex-col p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5"><span className="truncate text-[13px] font-medium">{model.name}</span><Pill tone={model.provider === 'hf' ? 'blue' : 'neutral'}>{model.provider.toUpperCase()}</Pill><Pill tone="neutral">{model.precision.toUpperCase()}</Pill></div>
                    <p className="mt-2 min-h-10 text-ui leading-5 text-[var(--color-text-secondary)]">{model.notes ?? '远端模型组件。'}</p>
                  </div>
                  <Pill tone={installed ? 'accent' : 'neutral'}>{installed ? '已部署' : '未部署'}</Pill>
                </div>
                <details className="my-2 text-caption text-[var(--color-text-tertiary)]"><summary className="cursor-pointer">来源与路径</summary><p className="mt-1 break-all font-mono">{model.repo}</p><p className="break-all font-mono">{scan?.path ?? '远端目录未发现此模型'}</p></details>
                <div className="mt-auto flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-3">
                  <span className="text-ui tabular-nums text-[var(--color-text-tertiary)]">{bytes(model.sizeBytes)} <span className="ml-1.5">{model.license}</span></span>
                  {installed && scan?.path ? <Button tone="ghost" onClick={() => void deleteRemoteModel(model, scan.path!)} disabled={working}>删除</Button> : <Button tone="secondary" onClick={() => void downloadRemoteModel(model)} disabled={working || !remoteHost}>{working ? <Spinner className="size-4" /> : <Download className="size-4" />}下载</Button>}
                </div>
              </Card>
            )
          })}
        </div>
        )}
        {remoteCategory === 'adapter' && (catalog?.adapters?.length ?? 0) === 0 ? <p className="text-caption text-[var(--color-text-tertiary)]">没有适配器。</p> : null}
        {remoteCategory !== 'adapter' && (catalog?.models?.length ?? 0) === 0 ? <EmptyState icon={<Package className="size-6" />} title="模型目录未加载" description="先刷新模型库。" /> : null}
      </section>

      </div>

      <div data-oobe-host="local" className={mode === 'local' ? 'space-y-5' : 'hidden'}>
      {bundle ? (
        <Card data-oobe="model" data-oobe-hint-title="推荐组合" data-oobe-hint-position="bottom" data-oobe-hint="首次使用建议选择推荐组合，点击「补齐组件」即可下载主模型、Qwen 编码器、VAE 与运行配置，已有组件会复用。" className="overflow-hidden">
          <div data-oobe-hint-target className="flex flex-wrap items-start justify-between gap-4 px-5 pt-4">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-ui text-[var(--color-text-secondary)]">
                <Layers className="size-4 text-accent-400" /> 推荐组合 · MossInfer bundle{' '}
                <span className="text-[var(--color-text-tertiary)]">· 引擎原地读取，无需转换</span>
                {bundle.recommended ? <Pill tone="accent">官方推荐</Pill> : null}
              </div>
              <select
                aria-label="推荐模型组合"
                value={bundle.id}
                onChange={(e) => setBundleId(e.target.value)}
                className="model-select !h-9 !text-[16px] !font-semibold !px-2.5"
              >
                {catalog?.bundles?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-ui leading-5 text-[var(--color-text-secondary)]">
                {bundle.description}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Button
                tone={missing.length ? 'primary' : 'secondary'}
                disabled={busy === 'bundle' || bundleRunning || !missing.length}
                onClick={() => void install()}
              >
                {busy === 'bundle' || bundleRunning ? (
                  <Spinner className="size-4" />
                ) : missing.length ? (
                  <ArrowDownToLine className="size-4" />
                ) : (
                  <Check className="size-4" />
                )}
                {bundleRunning ? '正在准备组件' : missing.length ? '补齐组件' : '组合已就绪'}
              </Button>
              <span className="text-ui tabular-nums text-[var(--color-text-tertiary)]">
                {missing.length ? `还需约 ${bytes(remaining)}` : '可在实例详情绑定使用'}
              </span>
            </div>
          </div>
          <div className="mx-5 mt-3 flex items-center gap-2.5">
            <Pill tone={missing.length ? 'amber' : 'accent'}>
              {missing.length ? `缺 ${missing.length} 项` : 'bundle 完整'}
            </Pill>
            <ProgressBar
              value={percent(bundleModels.filter((m) => m.installed).length, bundleModels.length)}
              className="max-w-40 flex-1"
            />
            <span className="text-caption tabular-nums text-[var(--color-text-tertiary)]">
              已就绪 {bundleModels.filter((m) => m.installed).length} / {bundleModels.length}
            </span>
          </div>
          <div className="model-composition mx-5 my-4 grid grid-cols-1 divide-y divide-[var(--color-border-subtle)] rounded-[6px] border border-[var(--color-border-subtle)] md:grid-cols-3 md:divide-x md:divide-y-0">
            {(['dit', 'textEncoder', 'vae'] as const).map((key, i) => {
              const model = catalog?.models.find((m) => m.id === bundle.components[key])
              const task = downloads.find((t) => t.targetId === model?.id && t.kind === 'model')
              return (
                <div key={key} className="min-w-0 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-caption tracking-wide text-[var(--color-text-tertiary)]">
                      {['01 · 主模型', '02 · 文本编码器', '03 · VAE'][i]}
                    </span>
                    <span
                      className={cn(
                        'text-caption',
                        model?.installed ? 'text-accent-400' : 'text-[var(--color-text-secondary)]',
                      )}
                    >
                      {model?.installed
                        ? '已就绪'
                        : task && task.state !== 'done'
                          ? labels[task.state]
                          : '待下载'}
                    </span>
                  </div>
                  <div className="mt-2 truncate text-ui font-medium" title={model?.name}>
                    {model?.name}
                  </div>
                  <div className="mt-1 flex items-center justify-between text-ui text-[var(--color-text-tertiary)]">
                    <span>
                      {model?.precision.toUpperCase()} {i > 0 ? '· 多组合共用' : '· 可独立更换'}
                    </span>
                    <span className="tabular-nums">{bytes(model?.sizeBytes ?? 0)}</span>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border-subtle)] px-5 py-2.5 text-ui text-[var(--color-text-tertiary)]">
            <span>
              含运行配置（{catalog?.models.find((m) => m.id === bundle.support)?.name ?? bundle.support}
              ）；bf16 bundle 对应 MossInfer reference 档
            </span>
            <span>
              当前引擎：{engineLabel} · 切换主模型时复用已下载的编码器与 VAE
            </span>
          </div>
        </Card>
      ) : null}

        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2"><HardDrive className="size-4 text-accent-300" /><h2 className="text-[14px] font-semibold">本地模型目录</h2></div>
              <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">下载、导入和引用都使用这个根目录；修改后会刷新模型库。</p>
            </div>
            <div className="flex flex-wrap gap-1">
              <Button tone="ghost" onClick={() => void openLocalRoot()} disabled={localBusy}>打开目录</Button>
              <Button tone="ghost" onClick={() => void importFolder()} disabled={busy !== null || localBusy}>导入目录</Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Input value={localRoot} onChange={(event) => setLocalRoot(event.target.value)} placeholder={settings?.modelsRoot ?? '默认 ~/.mossstudio/models'} className="min-w-[240px] flex-1 font-mono text-caption" />
            <Button tone="secondary" onClick={() => void pickLocalRoot()} disabled={localBusy}>选择目录</Button>
            <Button tone="primary" onClick={() => void saveLocalRoot()} disabled={localBusy}>保存路径</Button>
          </div>
        </Card>

      {active.length ? (
        <Card className="overflow-hidden">
          <details open>
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-ui font-medium">
              <span className="flex items-center gap-2">
                <Download className="size-4 text-accent-400" /> 下载队列{' '}
                <span className="text-[var(--color-text-tertiary)]">{active.length}</span>
              </span>
              <ChevronDown className="size-4" />
            </summary>
            <div className="max-h-[280px] divide-y divide-[var(--color-border-subtle)] overflow-y-auto border-t border-[var(--color-border-subtle)]">
              {active.map((task) => (
                <div key={task.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="truncate text-ui font-medium">{task.label}</span>
                      <span
                        className={cn(
                          'text-ui',
                          task.state === 'error'
                            ? 'text-red-300'
                            : 'text-[var(--color-text-secondary)]',
                        )}
                      >
                        {labels[task.state]} · {bytes(task.bytes)} / {bytes(task.totalBytes)}
                      </span>
                    </div>
                    <ProgressBar value={percent(task.bytes, task.totalBytes)} className="mt-2" />
                    <p
                      className="mt-1.5 truncate text-caption text-[var(--color-text-tertiary)]"
                      title={task.error ?? task.currentFile}
                    >
                      {task.error ?? task.currentFile ?? '正在获取文件清单'}
                      {task.speedBps > 0 ? ` · ${bytes(task.speedBps)}/s` : ''}
                    </p>
                  </div>
                  {['running', 'queued', 'verifying'].includes(task.state) ? (
                    <IconButton
                      label={`暂停 ${task.label}`}
                      onClick={() => void pauseDownload(task.id)}
                    >
                      <Pause className="size-4" />
                    </IconButton>
                  ) : (
                    <IconButton
                      label={`继续 ${task.label}`}
                      disabled={busy === task.targetId}
                      onClick={() => void resume(task)}
                    >
                      <Play className="size-4" />
                    </IconButton>
                  )}
                  <IconButton label={`取消 ${task.label}`} onClick={() => void cancel(task)}>
                    <X className="size-4" />
                  </IconButton>
                </div>
              ))}
            </div>
          </details>
        </Card>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav
            data-oobe="model" data-oobe-hint-title="按组件挑选" data-oobe-hint-position="bottom" data-oobe-hint="也可以在下方按 MOSS 模型、Qwen 编码器、VAE 等分页单独挑选并下载组件，已有编码器和 VAE 可复用。"
            aria-label="组件分类"
            className="flex max-w-full gap-1 overflow-x-auto border-b border-[var(--color-border-subtle)]"
          >
            {categories.map(({ id, name, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setCategory(id)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-ui transition-colors',
                  category === id
                    ? 'border-accent-400 text-[var(--color-text)]'
                    : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]',
                )}
              >
                <Icon className="size-4" />
                {name}
              </button>
            ))}
          </nav>
          <label className="flex h-8 w-full items-center gap-2 rounded-[4px] border border-[var(--color-border-subtle)] bg-white/[0.025] px-2.5 sm:w-52">
            <Search className="size-4 shrink-0 text-[var(--color-text-tertiary)]" />
            <input
              aria-label="搜索组件"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称或来源"
              className="w-full min-w-0 bg-transparent text-ui outline-none"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {category !== 'adapter' ? (
              <select
                aria-label="组件格式"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
                className="model-select"
              >
                <option value="diffusers">Diffusers · 可绑定 bundle</option>
                <option value="comfyui">ComfyUI 单文件 · MossInfer 覆盖</option>
                <option value="all">全部格式</option>
              </select>
            ) : null}
            <label className="flex items-center gap-1.5 text-ui text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={installedOnly}
                onChange={(e) => setInstalledOnly(e.target.checked)}
                className="accent-[var(--color-accent-500)]"
              />
              仅已安装
            </label>
          </div>
          <span className="text-ui text-[var(--color-text-tertiary)]">
            {list.length} 个组件
          </span>
        </div>
        {format === 'comfyui' && category !== 'adapter' ? (
          <p className="text-ui leading-5 text-[var(--color-text-secondary)]">
            单文件组件不能绑定进 bundle（绑定仅支持 Diffusers 组件）；MossInfer 可通过 dit_file / text_encoder_file / vae_file
            在引擎级覆盖使用，界面接线后续提供。
          </p>
        ) : null}
        <MotionPanel transitionKey={`${category}:${format}:${installedOnly}`}>
          {list.length ? (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {list.map((entry) => {
                const model = entry.value
                const task = downloads.find((t) => t.kind === entry.kind && t.targetId === model.id)
                const working = task && ['queued', 'running', 'verifying'].includes(task.state)
                const component = entry.kind === 'model' ? entry.value : null
                const compat = component ? engineCompat(component) : null
                return (
                  <Card key={model.id} className="flex min-w-0 flex-col p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-[13px] font-medium" title={model.name}>
                          {model.name}
                        </h3>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Pill>
                            {component?.provider === 'local'
                              ? '本地引用'
                              : component?.format === 'comfyui'
                              ? 'ComfyUI 单文件'
                              : entry.kind === 'adapter'
                                ? entry.value.kind.toUpperCase()
                                : 'Diffusers'}
                          </Pill>
                          {compat ? (
                            <Pill
                              tone={
                                compat.kind === 'bindable'
                                  ? 'accent'
                                  : compat.kind === 'override'
                                    ? 'blue'
                                    : 'amber'
                              }
                            >
                              {compat.label}
                            </Pill>
                          ) : null}
                          {component ? <Pill>{component.precision.toUpperCase()}</Pill> : null}
                          {component?.tags.includes('shared') ? (
                            <span className="text-caption text-[var(--color-text-tertiary)]">
                              共享组件
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 text-ui',
                          model.installed ? 'text-accent-400' : 'text-[var(--color-text-tertiary)]',
                        )}
                      >
                        {model.installed
                          ? component?.provider === 'local'
                            ? '已引用'
                            : '已就绪'
                          : working
                            ? labels[task.state]
                            : component?.provider === 'local'
                              ? '源文件不可用'
                            : component?.installState === 'error'
                              ? '需修复'
                              : '未安装'}
                      </span>
                    </div>
                    <p className="mt-3 min-h-10 text-ui leading-5 text-[var(--color-text-secondary)]">
                      {model.notes ?? '独立下载并管理此组件。'}
                    </p>
                    {compat?.hint ? (
                      <p className="mb-1 text-caption leading-4 text-[var(--color-text-tertiary)]">
                        {compat.hint}
                      </p>
                    ) : null}
                    <details className="my-2 text-caption text-[var(--color-text-tertiary)]">
                      <summary className="cursor-pointer">来源与文件</summary>
                      <p className="mt-1 break-all font-mono">{model.repo}</p>
                      <p className="break-all font-mono">
                        {component?.files?.join(' · ') ?? model.files?.join(' · ')}
                      </p>
                    </details>
                    <div className="mt-auto flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-3">
                      <span className="text-ui tabular-nums text-[var(--color-text-tertiary)]">
                        {bytes(model.installed ? model.installedBytes : model.sizeBytes)}{' '}
                        <span className="ml-1.5">{model.license}</span>
                      </span>
                      <div className="flex items-center gap-1">
                        {model.installed ||
                        component?.installState === 'partial' ||
                        component?.installState === 'error' ? (
                          <IconButton label={`删除 ${model.name}`} onClick={() => setRemoving(entry)}>
                            <Trash2 className="size-4" />
                          </IconButton>
                        ) : null}
                        {!model.installed && component?.provider !== 'local' ? (
                          <Button
                            tone="secondary"
                            disabled={working || busy === model.id}
                            onClick={() => setPending(entry)}
                          >
                            {working ? (
                              <Spinner className="size-4" />
                            ) : (
                              <Download className="size-4" />
                            )}
                            {working
                              ? '准备中'
                              : component?.installState === 'error' ||
                                  component?.installState === 'partial'
                                ? '补齐 / 修复'
                                : '下载'}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
          ) : (
            <EmptyState
              icon={<Package className="size-6" />}
              title="没有匹配的组件"
              description="调整搜索词、格式或已安装筛选。"
              action={
                <Button
                  tone="secondary"
                  onClick={() => {
                    setQuery('')
                    setInstalledOnly(false)
                    setFormat('all')
                  }}
                >
                  清除筛选
                </Button>
              }
            />
          )}
        </MotionPanel>
      </section>

      </div>

      <Modal
        open={Boolean(pending)}
        onClose={() => setPending(null)}
        title="下载组件"
        description={pending?.value.name}
        width="max-w-md"
        footer={
          <>
            <Button tone="ghost" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              data-oobe="model" data-oobe-hint="确认组件信息后开始下载，准备清单会自动跟随下载和校验结果更新。"
              tone="primary"
              disabled={busy !== null}
              onClick={() => pending && void start(pending)}
            >
              {busy ? <Spinner className="size-4" /> : <Download className="size-4" />}开始下载
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-ui leading-5 text-[var(--color-text-secondary)]">
          <div className="flex justify-between">
            <span>组件大小</span>
            <span className="tabular-nums text-[var(--color-text)]">
              {bytes(pending?.value.sizeBytes ?? 0)}
            </span>
          </div>
          <p>已缓存的文件会复用；中断后可以继续，完整校验通过后才标记为可用。</p>
          {pending?.kind === 'model' && pending.value.format === 'comfyui' ? (
            <p className="text-amber-300">
              单文件组件暂不能绑定进 bundle；可作为 MossInfer 引擎级覆盖组件（
              {engineCompat(pending.value).hint ?? '引擎级覆盖'}），界面接线后续提供。
            </p>
          ) : null}
        </div>
      </Modal>
      <Modal
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title="移除本地组件"
        description={removing?.value.name}
        width="max-w-md"
        footer={
          <>
            <Button tone="ghost" onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              tone="danger"
              disabled={busy !== null || users.length > 0}
              onClick={() => void remove()}
            >
              移除组件
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-ui leading-5 text-[var(--color-text-secondary)]">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <HardDrive className="size-4" />
              {removing?.kind === 'model' && removing.value.provider === 'local'
                ? '外部文件引用'
                : '最多可释放'}
            </span>
            <span>
              {removing?.kind === 'model' && removing.value.provider === 'local'
                ? '原文件不会删除'
                : bytes(removing?.value.installedBytes ?? 0)}
            </span>
          </div>
          <p>
            {removing?.kind === 'model' && removing.value.provider === 'local'
              ? '移除只会取消模型库中的引用，不会删除或修改原始模型文件。'
              : '只清理此组件独占的受管文件；其他组件或外部缓存仍在使用的文件会保留，实际释放容量取决于共享引用。'}
          </p>
          {users.length ? (
            <p className="text-amber-300">
              正在被 {users.map((i) => i.name).join('、')} 使用，请先到实例详情解除绑定。
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}
