import { bestBundleFor, bundleGpusProblem, isFileBundle } from '@shared/bundleFit'
import type { AdapterEntry, DownloadTask, GpuInventoryDevice, ModelBundle, ModelEntry } from '@shared/types'

/**
 * Pure helpers for the Models page. A "model" here is a whole catalog bundle
 * (main model + text encoder + VAE + configuration); its parts are only named
 * under 高级. State texts use plain words from the user's side.
 */

/** Decimal sizes, like the download sites: "9.5 GB", "320 MB", "74 MB". */
export function sizeText(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '—'
  if (bytes >= 1e12) return `${trim(bytes / 1e12)} TB`
  if (bytes >= 1e9) return `${trim(bytes / 1e9)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${Math.round(bytes)} B`
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')
}

export const ACTIVE_STATES: ReadonlySet<DownloadTask['state']> = new Set(['queued', 'running', 'verifying'])

export function isActive(task: DownloadTask | undefined): boolean {
  return Boolean(task && ACTIVE_STATES.has(task.state))
}

/** Latest task for a catalog entry, ignoring canceled ones. */
export function taskFor(tasks: readonly DownloadTask[], kind: DownloadTask['kind'], id: string): DownloadTask | undefined {
  return tasks.filter((task) => task.kind === kind && task.targetId === id && task.state !== 'canceled').at(-1)
}

/** Ids a bundle needs, in order, without blanks or duplicates. */
export function bundleComponentIds(bundle: ModelBundle): string[] {
  return [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae, bundle.support].filter(
    (id, index, list): id is string => Boolean(id) && list.indexOf(id) === index,
  )
}

export type BundleStatus = 'ready' | 'downloading' | 'verifying' | 'paused' | 'failed' | 'partial' | 'missing' | 'unavailable'
export type BundleAction = 'download' | 'resume' | 'pause' | null

/** Pill tone of a state: ready is ok, in progress is accent, partly done is warn, failed is danger. */
export type StateTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

const BUNDLE_TONE: Record<BundleStatus, StateTone> = {
  ready: 'ok',
  downloading: 'accent',
  verifying: 'accent',
  paused: 'neutral',
  failed: 'danger',
  partial: 'warn',
  missing: 'neutral',
  unavailable: 'warn',
}

export function bundleTone(status: BundleStatus): StateTone {
  return BUNDLE_TONE[status]
}

export interface BundleView {
  bundle: ModelBundle
  components: ModelEntry[]
  missing: ModelEntry[]
  /** Download tasks of the missing parts. */
  tasks: DownloadTask[]
  totalBytes: number
  remainingBytes: number
  /** Progress over the missing parts, 0–100, whole numbers. */
  percent: number
  status: BundleStatus
  /** One line in plain words: "可以使用", "还差 1 个文件 · 320 MB", "下载中 42%". The total size is not part of it. */
  stateText: string
  action: BundleAction
  actionLabel: string
  /** Why this model cannot run where the page points (the GPU, another computer); it is then not offered for download. */
  blocked: string | null
}

/**
 * Whole-model state. `isInstalled` decides per part (local catalog flag, or a
 * remote host's inventory); `tasks` are the downloads for the same machine.
 * A `blocked` model keeps its state but offers no new download; one already
 * started can still be paused, continued or retried.
 */
export function bundleView(
  bundle: ModelBundle,
  models: readonly ModelEntry[],
  tasks: readonly DownloadTask[],
  isInstalled: (model: ModelEntry) => boolean = (model) => model.installed,
  blocked: string | null = null,
): BundleView {
  const view = bundleState(bundle, models, tasks, isInstalled)
  if (!blocked) return { ...view, blocked: null }
  // A download already started (pause, continue, retry) stays in the user's hands; only new ones are not offered.
  return view.action === 'download' ? { ...view, blocked, action: null, actionLabel: '' } : { ...view, blocked }
}

function bundleState(
  bundle: ModelBundle,
  models: readonly ModelEntry[],
  tasks: readonly DownloadTask[],
  isInstalled: (model: ModelEntry) => boolean,
): Omit<BundleView, 'blocked'> {
  const ids = bundleComponentIds(bundle)
  const components = ids.map((id) => models.find((model) => model.id === id)).filter((model): model is ModelEntry => Boolean(model))
  const totalBytes = components.reduce((sum, model) => sum + (model.sizeBytes || 0), 0)
  const missing = components.filter((model) => !isInstalled(model))
  const partTasks = missing.map((model) => taskFor(tasks, 'model', model.id)).filter((task): task is DownloadTask => Boolean(task))
  let done = 0
  let size = 0
  for (const model of missing) {
    const task = taskFor(tasks, 'model', model.id)
    const total = task?.totalBytes || model.sizeBytes || 0
    size += total
    done += task?.state === 'done' ? total : Math.min(total, task?.bytes ?? 0)
  }
  const remainingBytes = Math.max(0, size - done)
  const percent = size > 0 ? Math.floor((done / size) * 100) : 0
  const base = { bundle, components, missing, tasks: partTasks, totalBytes, remainingBytes, percent }

  if (components.length < ids.length) {
    return { ...base, status: 'unavailable', stateText: '模型信息不完整，刷新后再试', action: null, actionLabel: '' }
  }
  if (missing.length === 0) return { ...base, status: 'ready', stateText: '可以使用', action: null, actionLabel: '' }
  const active = partTasks.filter((task) => ACTIVE_STATES.has(task.state))
  // Parts shared with another model (text encoder, VAE, configs) downloading for
  // that one do not make this model "downloading" while its main model waits.
  const started = partTasks.length === missing.length || partTasks.some((task) => task.targetId === bundle.components.dit)
  if (active.length && started) {
    if (active.every((task) => task.state === 'verifying')) {
      return { ...base, status: 'verifying', stateText: '正在校验文件', action: null, actionLabel: '' }
    }
    return { ...base, status: 'downloading', stateText: `下载中 ${percent}%`, action: 'pause', actionLabel: '暂停' }
  }
  if (partTasks.some((task) => task.state === 'error')) {
    return {
      ...base,
      status: 'failed',
      stateText: `下载没有完成 · 还差 ${sizeText(remainingBytes)}`,
      action: 'resume',
      actionLabel: '重试',
    }
  }
  if (partTasks.some((task) => task.state === 'paused')) {
    return {
      ...base,
      status: 'paused',
      stateText: `已暂停 ${percent}% · 还差 ${sizeText(remainingBytes)}`,
      action: 'resume',
      actionLabel: '继续',
    }
  }
  if (missing.length < components.length) {
    return {
      ...base,
      status: 'partial',
      stateText: `还差 ${missing.length} 个文件 · ${sizeText(remainingBytes)}`,
      action: 'download',
      actionLabel: '下载',
    }
  }
  return { ...base, status: 'missing', stateText: '未下载', action: 'download', actionLabel: '下载' }
}

/** Where the page points: this computer (its GPUs, once read, and which of them run a CLI engine) or another computer. */
export interface ModelPlace {
  remote: boolean
  gpus: readonly GpuInventoryDevice[]
  /** GPUs running 兼容模式 / AMD 原生, which read only the official bf16 folders. */
  cliGpus?: ReadonlySet<string>
}

/** Why a whole model cannot run at this place, or null. */
export function bundleBlocker(bundle: ModelBundle, models: readonly ModelEntry[], place: ModelPlace): string | null {
  const files = isFileBundle(bundle, models)
  if (place.remote) return files ? '只能在这台电脑上使用，其他电脑请用官方模型' : null
  return bundleGpusProblem(bundle, place.gpus, { cliGpus: place.cliGpus, files })
}

export interface ModelSections {
  /** The one model shown large: the deep-linked one, else the best pick for this place. */
  featured: BundleView | undefined
  /** Set when the featured model is the best pick for this place; `reason` says why, when the GPU is known. */
  pick: { reason: string | null } | null
  /** Engine-certified models (推荐模型), the featured one excluded. */
  certified: BundleView[]
  /** Everything else (其他模型): models the engine has not verified, local files. */
  others: BundleView[]
}

/**
 * Splits the models of the page. 推荐模型 lists every model the engine
 * certifies; the one that suits this computer best is featured. A model the
 * catalog cannot describe completely is left out.
 */
export function modelSections(
  views: readonly BundleView[],
  models: readonly ModelEntry[],
  place: ModelPlace,
  preferredId?: string | null,
): ModelSections {
  const candidates = views.map((view) => view.bundle).filter((bundle) => !place.remote || !isFileBundle(bundle, models))
  const best = bestBundleFor(candidates, place.remote ? [] : place.gpus, place.cliGpus)
  const featured = views.find((view) => view.bundle.id === preferredId) ?? views.find((view) => view.bundle.id === best?.bundle.id)
  const listed = views.filter((view) => view !== featured && view.status !== 'unavailable')
  return {
    featured,
    pick: featured && best && featured.bundle.id === best.bundle.id ? { reason: best.reason } : null,
    certified: listed.filter((view) => view.bundle.certified),
    others: listed.filter((view) => !view.bundle.certified),
  }
}

/**
 * What deleting a whole model removes: its installed parts that no other
 * model still needs. A shared part (text encoder, VAE) stays while another
 * model is complete, or has its own part installed or downloading.
 * `bytes` is what that frees, at most.
 */
export function bundleDeletePlan(
  bundle: ModelBundle,
  bundles: readonly ModelBundle[],
  models: readonly ModelEntry[],
  isInstalled: (model: ModelEntry) => boolean = (model) => model.installed,
  tasks: readonly DownloadTask[] = [],
): { ids: string[]; bytes: number; kept: string[] } {
  const installed = (id: string): boolean => {
    const model = models.find((entry) => entry.id === id)
    return Boolean(model && isInstalled(model))
  }
  const own = new Set(bundleComponentIds(bundle))
  const started = (id: string): boolean => {
    const task = taskFor(tasks, 'model', id)
    return installed(id) || Boolean(task && task.state !== 'done')
  }
  const othersInUse = new Set(
    bundles
      .filter((other) => {
        if (other.id === bundle.id) return false
        const ids = bundleComponentIds(other)
        return ids.every(installed) || ids.some((id) => !own.has(id) && started(id))
      })
      .flatMap((other) => bundleComponentIds(other)),
  )
  // Files found on this computer only leave the list; the small runtime config they load with stays.
  const localOnly = localFilesOnly(bundle, models)
  const present = bundleComponentIds(bundle)
    .filter(installed)
    .filter((id) => !localOnly || models.find((model) => model.id === id)?.provider === 'local')
  const ids = present.filter((id) => !othersInUse.has(id))
  const kept = present.filter((id) => othersInUse.has(id))
  const bytes = ids.reduce((sum, id) => {
    const model = models.find((entry) => entry.id === id)
    return sum + (model?.installedBytes || model?.sizeBytes || 0)
  }, 0)
  return { ids, bytes, kept }
}

/** A model whose weights are all files registered where they are on this computer (not downloaded). */
export function localFilesOnly(bundle: ModelBundle, models: readonly ModelEntry[]): boolean {
  return [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae].every(
    (id) => models.find((model) => model.id === id)?.provider === 'local',
  )
}

/** Names of complete models (other than `exceptBundleId`) that include a part. */
export function bundlesUsing(id: string, bundles: readonly ModelBundle[], exceptBundleId?: string): ModelBundle[] {
  return bundles.filter((bundle) => bundle.id !== exceptBundleId && bundleComponentIds(bundle).includes(id))
}

/* ------------------------------------------------------------------ */
/* Parts (高级)                                                         */
/* ------------------------------------------------------------------ */

export const ROLE_LABEL: Record<ModelEntry['role'], string> = {
  dit: '主模型',
  full: '完整模型',
  text_encoder: '文本编码器',
  vae: 'VAE',
  support: '运行配置',
}

/**
 * Whether a part is worth offering at all. Single-file ComfyUI exports of the
 * old FP16-fixed weights cannot be used by the engine, so they are not listed.
 */
export function isOfferedComponent(model: ModelEntry): boolean {
  if ((model.format ?? 'diffusers') !== 'comfyui') return true
  if (model.provider === 'local') return true
  const legacy = model.precision === 'fp16' || model.tags.includes('fixed')
  return !legacy
}

export interface ItemState {
  /** The state in a word or two; empty when the entry is simply not downloaded (its 下载 button says so). */
  text: string
  tone: StateTone
  action: 'download' | 'resume' | 'pause' | 'delete' | null
  actionLabel: string
  percent: number | null
}

/** State of one downloadable entry (a part or a LoRA) on one machine. */
export function itemState(
  entry: Pick<ModelEntry | AdapterEntry, 'provider' | 'sizeBytes'> & { installState?: ModelEntry['installState'] },
  installed: boolean,
  task: DownloadTask | undefined,
): ItemState {
  const percent = task && task.totalBytes > 0 ? Math.floor((Math.min(task.bytes, task.totalBytes) / task.totalBytes) * 100) : null
  if (installed)
    return entry.provider === 'local'
      ? { text: '已添加', tone: 'ok', action: 'delete', actionLabel: '移除', percent: null }
      : { text: '已下载', tone: 'ok', action: 'delete', actionLabel: '删除', percent: null }
  if (task && task.state === 'verifying') return { text: '正在校验', tone: 'accent', action: null, actionLabel: '', percent }
  if (task && ACTIVE_STATES.has(task.state)) {
    return {
      text: task.state === 'queued' ? '等待下载' : `下载中 ${percent ?? 0}%`,
      tone: 'accent',
      action: 'pause',
      actionLabel: '暂停',
      percent: percent ?? 0,
    }
  }
  if (task?.state === 'paused')
    return { text: `已暂停 ${percent ?? 0}%`, tone: 'neutral', action: 'resume', actionLabel: '继续', percent: percent ?? 0 }
  if (task?.state === 'error') return { text: '下载失败', tone: 'danger', action: 'resume', actionLabel: '重试', percent }
  if (entry.provider === 'local') return { text: '找不到原文件', tone: 'warn', action: 'delete', actionLabel: '移除', percent: null }
  if (entry.installState === 'partial' || entry.installState === 'error') {
    return { text: '文件不完整', tone: 'warn', action: 'download', actionLabel: '修复', percent: null }
  }
  return { text: '', tone: 'neutral', action: 'download', actionLabel: '下载', percent: null }
}

/** One line for a download task in the queue. */
export function taskText(task: DownloadTask): string {
  if (task.connectionError) return '连接中断，显示的是上次的进度'
  const percent = task.totalBytes > 0 ? `${Math.floor((Math.min(task.bytes, task.totalBytes) / task.totalBytes) * 100)}%` : ''
  const amount = task.totalBytes > 0 ? `${sizeText(task.bytes)} / ${sizeText(task.totalBytes)}` : ''
  switch (task.state) {
    case 'queued':
      return '等待下载'
    case 'running':
      return [`下载中 ${percent}`.trim(), amount, task.speedBps > 0 ? `${sizeText(task.speedBps)}/s` : ''].filter(Boolean).join(' · ')
    case 'verifying':
      return '正在校验文件'
    case 'paused':
      return [`已暂停 ${percent}`.trim(), amount].filter(Boolean).join(' · ')
    case 'error':
      return task.error ? `下载失败：${task.error}` : '下载失败'
    case 'done':
      return '已完成'
    case 'canceled':
      return '已取消'
  }
}

/** Tasks the 下载 tab lists: everything not finished or canceled. */
export function visibleTasks(tasks: readonly DownloadTask[]): DownloadTask[] {
  return tasks.filter((task) => task.state !== 'done' && task.state !== 'canceled')
}

/** Reads the deep-link query (`?bundle=…&component=…&hostId=…`). */
export function parseModelsQuery(search: string): {
  bundleId: string | null
  component: string | null
  hostId: string | null
  tab: 'models' | 'lora' | 'downloads' | null
} {
  const query = new URLSearchParams(search)
  const tab = query.get('tab')
  const component = query.get('component')
  return {
    bundleId: query.get('bundle') || null,
    component: component || null,
    hostId: query.get('hostId') || null,
    tab: tab === 'lora' || tab === 'downloads' || tab === 'models' ? tab : component === 'adapter' ? 'lora' : null,
  }
}
