import { ArrowDownToLine, Pause, Play, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ModelBundle, ModelEntry } from '@shared/types'
import { Button, Card, ConfirmDialog, Group, ProgressBar, Row, Spinner, StatusDot, cn, useToast } from '../../components/ui'
import { bundleDeletePlan, sizeText, type BundleView } from './logic'
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

function ActionIcon({ action }: { action: BundleView['action'] }): React.JSX.Element | null {
  if (action === 'pause') return <Pause className="size-4" strokeWidth={1.6} />
  if (action === 'resume') return <Play className="size-4" strokeWidth={1.6} />
  if (action === 'download') return <ArrowDownToLine className="size-4" strokeWidth={1.6} />
  return null
}

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

function statusTone(view: BundleView): 'ok' | 'warn' | 'error' | 'unknown' {
  if (view.status === 'ready') return 'ok'
  if (view.status === 'failed') return 'error'
  if (view.status === 'unavailable' || view.status === 'partial') return 'warn'
  return 'unknown'
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
          {view.bundle.description ? <p className="text-ui text-ink-2">{view.bundle.description}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {view.status === 'ready' ? (
            <>
              {deletable ? (
                <Button tone="ghost" onClick={() => onDelete(view.bundle)}>
                  <Trash2 className="size-4" strokeWidth={1.6} /> 删除
                </Button>
              ) : null}
              {location.kind === 'local' ? (
                <Button tone="secondary" size="md" onClick={() => navigate('/studio')}>去创作</Button>
              ) : null}
            </>
          ) : view.action ? (
            <Button tone="primary" size="md" data-oobe-hint-target disabled={busy !== null} onClick={() => void act(view)}>
              {busy ? <Spinner /> : <ActionIcon action={view.action} />}
              {view.actionLabel}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <StatusDot status={statusTone(view)} />
          <span className={cn('tabular text-control', view.status === 'failed' ? 'text-danger' : 'text-ink')}>{view.stateText}</span>
          {/* The state line already says the size when nothing is downloaded yet. */}
          {view.stateText.includes(sizeText(view.totalBytes)) ? null : <span className="tabular ml-auto text-caption text-ink-2">{sizeText(view.totalBytes)}</span>}
        </div>
        {progressing ? <ProgressBar value={view.percent} label={`${view.bundle.name} 下载进度`} /> : null}
      </div>
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
            title={view.bundle.name}
            description={
              <span className="flex flex-col gap-1.5">
                <span>{view.bundle.description}</span>
                {progressing ? <ProgressBar value={view.percent} label={`${view.bundle.name} 下载进度`} className="max-w-64" /> : null}
              </span>
            }
          >
            <span className={cn('tabular text-caption', view.status === 'failed' ? 'text-danger' : view.status === 'ready' ? 'text-ok' : 'text-ink-2')}>
              {view.stateText}
            </span>
            {view.status === 'ready' ? (
              deletable(view.bundle) ? <Button tone="ghost" onClick={() => onDelete(view.bundle)}>删除</Button> : null
            ) : view.action ? (
              <Button tone="secondary" disabled={busy !== null} onClick={() => void act(view)}>
                {busy === view.bundle.id ? <Spinner /> : <ActionIcon action={view.action} />}
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
  const plan = bundle ? bundleDeletePlan(bundle, bundles, models, location.isModelInstalled, location.tasks) : { ids: [], bytes: 0, kept: [] }
  const local = bundle ? plan.ids.every((id) => models.find((model) => model.id === id)?.provider === 'local') : false
  const keptNames = plan.kept.map((id) => models.find((model) => model.id === id)?.name ?? id)
  const where = location.kind === 'remote' ? `${location.host?.name ?? '远程主机'} 上的` : ''
  const description = !bundle
    ? ''
    : plan.ids.length === 0
      ? '这个模型的文件都被其他模型共用，删除它不会释放空间。'
      : local
        ? '只移除模型库里的登记，电脑上的原文件不会被删除。'
        : `会删除${where}${plan.ids.length} 个文件，释放约 ${sizeText(plan.bytes)}。` +
          (keptNames.length ? `其他模型还在用的 ${keptNames.join('、')} 会保留。` : '') +
          '需要时可以重新下载。'

  async function confirm(): Promise<void> {
    if (!bundle) return
    onClose()
    try {
      await location.removeMany('model', plan.ids)
      toast.push(`已删除 ${bundle.name}`, 'success')
    } catch (cause) {
      toast.push(`没能删除：${errorText(cause)}`, 'error')
    }
  }

  return (
    <ConfirmDialog
      open={Boolean(bundle) && plan.ids.length > 0}
      title={bundle ? `删除「${bundle.name}」？` : ''}
      description={description}
      confirmLabel={local ? '移除' : '删除'}
      onClose={onClose}
      onConfirm={() => void confirm()}
    />
  )
}
