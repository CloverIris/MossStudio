import { ArrowDownToLine, Pause, Play, RotateCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ipc } from '@shared/channels'
import type { ModelBundle, ModelEntry } from '@shared/types'
import { call } from '../../lib/api'
import { Button, Card, ConfirmDialog, Group, Pill, ProgressBar, Row, Spinner, useToast } from '../../components/ui'
import { bundleDeletePlan, bundleTone, sizeText, type BundleView } from './logic'
import type { ModelLocation } from './useModelLocation'

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** Runs a whole-model action (download / resume / pause) on a location. */
async function runBundleAction(view: BundleView, location: ModelLocation): Promise<void> {
  if (view.action === 'pause') {
    for (const task of view.tasks) if (task.state === 'queued' || task.state === 'running') await location.pause(task)
    return
  }
  if (view.action === 'resume') {
    // Resuming re-queues every missing part; finished parts are verified and reused.
    await location.downloadBundle(view.bundle)
    return
  }
  if (view.action === 'download') await location.downloadBundle(view.bundle)
}

/**
 * The icon of a download action, the same in every list and in the queue:
 * pause, continue, retry (a failed download) and download.
 */
export function DownloadActionIcon({
  action,
  label,
}: {
  action: 'download' | 'resume' | 'pause' | null
  label: string
}): React.JSX.Element | null {
  if (action === 'pause') return <Pause className="size-4" strokeWidth={1.6} />
  if (action === 'resume')
    return label === '重试' ? <RotateCw className="size-4" strokeWidth={1.6} /> : <Play className="size-4" strokeWidth={1.6} />
  if (action === 'download') return <ArrowDownToLine className="size-4" strokeWidth={1.6} />
  return null
}

/**
 * Starting a delete from a row or card. Files the app downloaded are deleted
 * (删除); files that stay where they are on this computer are only removed
 * from the list (移除). Both open a confirm.
 */
export function RemoveButton({
  remove,
  name,
  onClick,
  disabled,
}: {
  /** True when the files stay on disk and only the entry goes. */
  remove?: boolean
  name: string
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return remove ? (
    <Button tone="ghost" aria-label={`移除 ${name}`} disabled={disabled} onClick={onClick}>
      <X className="size-4" strokeWidth={1.6} />
      移除
    </Button>
  ) : (
    <Button tone="ghost-danger" aria-label={`删除 ${name}`} disabled={disabled} onClick={onClick}>
      <Trash2 className="size-4" strokeWidth={1.6} />
      删除
    </Button>
  )
}

/** A whole model whose files all stay where they are on this computer (registered, not downloaded). */
const isLocalOnly = (view: BundleView): boolean =>
  view.components.length > 0 && view.components.every((model) => model.provider === 'local')

/** The description of a model with its total size at the end, the same place as for parts and LoRA. */
const describe = (view: BundleView): string => [view.bundle.description, sizeText(view.totalBytes)].filter(Boolean).join(' · ')

function useBundleActions(location: ModelLocation) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  async function act(view: BundleView): Promise<void> {
    setBusy(view.bundle.id)
    try {
      await runBundleAction(view, location)
      if (view.action === 'download' || view.action === 'resume') {
        toast.push(location.kind === 'remote' ? `已开始在 ${location.host?.name ?? '远程主机'} 上下载` : '已开始下载', 'success')
      }
    } catch (cause) {
      toast.push(errorText(cause), 'error')
    } finally {
      setBusy(null)
    }
  }
  return { busy, act }
}

/** The recommended model, with its state in plain words and one main action. */
export function FeaturedModel({
  view,
  location,
  deletable,
  onDelete,
}: {
  view: BundleView
  location: ModelLocation
  deletable: boolean
  onDelete: (bundle: ModelBundle) => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const { busy, act } = useBundleActions(location)
  const progressing = view.status === 'downloading' || view.status === 'paused' || view.status === 'verifying' || view.status === 'failed'
  return (
    <Card data-oobe="model" className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-caption text-ink-2">{view.bundle.recommended ? '推荐模型' : '模型'}</span>
          <h2 className="text-section font-semibold text-ink">{view.bundle.name}</h2>
          <p className="tabular text-ui text-ink-2">{describe(view)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {view.status === 'ready' ? (
            <>
              {deletable ? <RemoveButton remove={isLocalOnly(view)} name={view.bundle.name} onClick={() => onDelete(view.bundle)} /> : null}
              {location.kind === 'local' ? (
                <Button tone="secondary" size="md" onClick={() => navigate('/studio')}>
                  去创作
                </Button>
              ) : null}
            </>
          ) : view.action ? (
            <Button tone="primary" size="md" data-oobe-hint-target disabled={busy !== null} onClick={() => void act(view)}>
              {busy ? <Spinner /> : <DownloadActionIcon action={view.action} label={view.actionLabel} />}
              {view.actionLabel}
            </Button>
          ) : null}
        </div>
      </div>
      {/* Not downloaded yet needs no state: the 下载 button says it. */}
      {view.status !== 'missing' || progressing ? (
        <div className="flex flex-col gap-2.5">
          {view.status !== 'missing' ? (
            <div>
              <Pill tone={bundleTone(view.status)} className="tabular">
                {view.stateText}
              </Pill>
            </div>
          ) : null}
          {progressing ? <ProgressBar value={view.percent} label={`${view.bundle.name} 下载进度`} /> : null}
        </div>
      ) : null}
    </Card>
  )
}

/** Every other model: one row each with its size, state and one action. */
export function ModelList({
  views,
  location,
  highlightId,
  deletable,
  onDelete,
}: {
  views: BundleView[]
  location: ModelLocation
  highlightId?: string | null
  deletable: (bundle: ModelBundle) => boolean
  onDelete: (bundle: ModelBundle) => void
}): React.JSX.Element {
  const { busy, act } = useBundleActions(location)
  return (
    <Group>
      {views.map((view) => {
        const progressing = view.status === 'downloading' || view.status === 'paused' || view.status === 'verifying'
        return (
          <Row
            key={view.bundle.id}
            selected={view.bundle.id === highlightId}
            title={
              <>
                {view.bundle.name}
                {view.bundle.custom ? <span className="ml-2 text-caption text-ink-3">我的组合</span> : null}
              </>
            }
            description={
              <span className="flex flex-col gap-1.5">
                <span className="tabular">{describe(view)}</span>
                {progressing ? <ProgressBar value={view.percent} label={`${view.bundle.name} 下载进度`} className="max-w-64" /> : null}
              </span>
            }
          >
            {view.status !== 'missing' ? (
              <Pill tone={bundleTone(view.status)} className="tabular">
                {view.stateText}
              </Pill>
            ) : null}
            {view.status === 'ready' ? (
              deletable(view.bundle) ? (
                <RemoveButton remove={isLocalOnly(view)} name={view.bundle.name} onClick={() => onDelete(view.bundle)} />
              ) : null
            ) : view.action ? (
              <Button tone="secondary" disabled={busy !== null} onClick={() => void act(view)}>
                {busy === view.bundle.id ? <Spinner /> : <DownloadActionIcon action={view.action} label={view.actionLabel} />}
                {view.actionLabel}
              </Button>
            ) : null}
          </Row>
        )
      })}
    </Group>
  )
}

/** Confirmation for deleting a whole model; keeps parts other complete models still use. */
export function DeleteModelDialog({
  bundle,
  bundles,
  models,
  location,
  onClose,
}: {
  bundle: ModelBundle | null
  bundles: ModelBundle[]
  models: ModelEntry[]
  location: ModelLocation
  onClose: () => void
}): React.JSX.Element {
  const toast = useToast()
  const full = bundle
    ? bundleDeletePlan(bundle, bundles, models, location.isModelInstalled, location.tasks)
    : { ids: [], bytes: 0, kept: [] }
  const providerOf = (id: string) => models.find((model) => model.id === id)?.provider
  // A combination goes with the downloads only it needs; the person's own files stay in the library.
  const custom = Boolean(bundle?.custom)
  const plan = custom
    ? {
        ...full,
        ids: full.ids.filter((id) => providerOf(id) !== 'local'),
        bytes: full.ids
          .filter((id) => providerOf(id) !== 'local')
          .reduce((sum, id) => {
            const model = models.find((entry) => entry.id === id)
            return sum + (model?.installedBytes || model?.sizeBytes || 0)
          }, 0),
      }
    : full
  const local = bundle && !custom ? plan.ids.every((id) => providerOf(id) === 'local') : false
  const keptNames = plan.kept.map((id) => models.find((model) => model.id === id)?.name ?? id)
  const where = location.kind === 'remote' ? `${location.host?.name ?? '远程主机'} 上的` : ''
  const description = !bundle
    ? ''
    : plan.ids.length === 0
      ? custom
        ? '只删除这个组合，它用到的文件都会保留。'
        : '这个模型的文件都被其他模型共用，删除它不会释放空间。'
      : local
        ? '只从模型库里移除，电脑上的原文件不会被删除。'
        : `会删除${where}${plan.ids.length} 个文件，释放约 ${sizeText(plan.bytes)}。` +
          (keptNames.length ? `其他模型还在用的 ${keptNames.join('、')} 会保留。` : '') +
          '需要时可以重新下载。'

  async function confirm(): Promise<void> {
    if (!bundle) return
    onClose()
    try {
      if (plan.ids.length) await location.removeMany('model', plan.ids)
      if (custom) await call(Ipc.modelsDeleteCombination, { id: bundle.id })
      toast.push(`${local ? '已移除' : '已删除'} ${bundle.name}`, 'success')
    } catch (cause) {
      toast.push(`${local ? '没能移除' : '没能删除'}：${errorText(cause)}`, 'error')
    }
  }

  return (
    <ConfirmDialog
      open={Boolean(bundle) && (custom || plan.ids.length > 0)}
      title={bundle ? `${local ? '移除' : '删除'}「${bundle.name}」？` : ''}
      description={description}
      confirmLabel={local ? '移除' : '删除'}
      onClose={onClose}
      onConfirm={() => void confirm()}
    />
  )
}
