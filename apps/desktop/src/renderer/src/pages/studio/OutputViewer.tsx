import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect } from 'react'
import type { Catalog, JobRecord, ProjectCanvas } from '@shared/types'
import { Ipc } from '@shared/channels'
import { PromptBlock } from '../../components/common/PromptBlock'
import { Button, IconButton, Modal, cn, useToast } from '../../components/ui'
import { call } from '../../lib/api'
import { dimensions, duration } from '../../lib/format'
import { OutputImage } from './CanvasCard'
import { qualityFor, qualityPreset } from './defaults'
import { canvasDescription } from './prompt'

/** Every output of a run, one at a time, with the parameters that made it. */
export function OutputViewer({
  canvas,
  job,
  catalog,
  index,
  onIndex,
  onClose,
}: {
  canvas: ProjectCanvas | null
  job?: JobRecord
  catalog: Catalog | null
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}): React.JSX.Element {
  const toast = useToast()
  const outputs = (job?.outputs?.length ? job.outputs : canvas?.outputs) ?? []
  const count = outputs.length
  const current = outputs[Math.min(Math.max(0, index), Math.max(0, count - 1))]
  const open = Boolean(canvas && current)

  useEffect(() => {
    if (!open || count < 2) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight') onIndex((index + 1) % count)
      if (event.key === 'ArrowLeft') onIndex((index - 1 + count) % count)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, index, count, onIndex])

  const run = (channel: string, path: string): void => {
    void call(channel, { path }).catch((error: unknown) => toast.push(error instanceof Error ? error.message : String(error), 'error'))
  }
  const quality = canvas ? qualityFor(canvas.steps) : 'custom'
  const model = canvas?.modelBundleId
    ? (catalog?.bundles.find((bundle) => bundle.id === canvas.modelBundleId)?.name ?? canvas.modelBundleId)
    : '—'
  const took = duration(job?.startedAt, job?.endedAt)
  // What this run was told to avoid: the job's own record when there is one, else the canvas.
  const negative = (job ? job.params.negativePrompt : canvas?.negative)?.trim() ?? ''

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={canvas ? `${canvas.title}${count > 1 ? ` · 第 ${Math.min(index, count - 1) + 1} / ${count} 张` : ''}` : '结果'}
      width="max-w-5xl"
      footer={
        current ? (
          <>
            <Button tone="ghost" size="md" onClick={() => run(Ipc.galleryReveal, current.path)}>
              在文件夹中显示
            </Button>
            <Button tone="secondary" size="md" onClick={() => run(Ipc.openPath, current.path)}>
              用默认程序打开
            </Button>
            <Button tone="primary" size="md" onClick={onClose}>
              关闭
            </Button>
          </>
        ) : null
      }
    >
      {canvas && current ? (
        <div className="flex flex-col gap-4">
          <div className="relative flex items-center justify-center rounded-lg bg-well p-2">
            {/* Leaves room for the thumbnails, the prompt and the parameters below without scrolling, down to the 760px minimum window. */}
            <div
              style={{
                aspectRatio: `${current.width || canvas.width} / ${current.height || canvas.height}`,
                height: 'max(200px, calc(100vh - 580px))',
                maxWidth: '100%',
              }}
            >
              <OutputImage path={current.path} alt={`${canvas.title} 第 ${index + 1} 张`} className="object-contain" />
            </div>
            {count > 1 ? (
              <>
                <IconButton
                  label="上一张"
                  onClick={() => onIndex((index - 1 + count) % count)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 bg-raised text-ink shadow-float"
                >
                  <ChevronLeft className="size-5" strokeWidth={1.6} />
                </IconButton>
                <IconButton
                  label="下一张"
                  onClick={() => onIndex((index + 1) % count)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 bg-raised text-ink shadow-float"
                >
                  <ChevronRight className="size-5" strokeWidth={1.6} />
                </IconButton>
              </>
            ) : null}
          </div>
          {count > 1 ? (
            <div className="flex flex-wrap justify-center gap-1.5">
              {outputs.map((output, position) => (
                <button
                  key={output.path}
                  type="button"
                  aria-label={`第 ${position + 1} 张`}
                  aria-current={position === index ? 'true' : undefined}
                  onClick={() => onIndex(position)}
                  className={
                    position === index
                      ? 'size-12 overflow-hidden rounded-md ring-2 ring-accent ring-offset-2 ring-offset-surface'
                      : 'size-12 overflow-hidden rounded-md opacity-70 hover:opacity-100'
                  }
                >
                  <OutputImage path={output.path} alt="" compact />
                </button>
              ))}
            </div>
          ) : null}
          <div className={cn('grid gap-4', negative && 'sm:grid-cols-2')}>
            <PromptBlock title="描述" text={canvasDescription(canvas)} empty="没有描述" />
            {negative ? <PromptBlock title="不想出现的内容" text={negative} /> : null}
          </div>
          <dl className="tabular grid grid-cols-2 gap-x-6 gap-y-2 text-caption sm:grid-cols-4">
            <div>
              <dt className="text-ink-2">尺寸</dt>
              <dd className="text-ink">{dimensions(current.width || canvas.width, current.height || canvas.height)}</dd>
            </div>
            <div>
              <dt className="text-ink-2">质量</dt>
              <dd className="text-ink">
                {quality === 'custom' ? `${canvas.steps} 步` : `${qualityPreset(quality).label} · ${canvas.steps} 步`}
              </dd>
            </div>
            <div>
              <dt className="text-ink-2">种子</dt>
              <dd className="text-ink">{current.seed ?? canvas.seed}</dd>
            </div>
            <div>
              <dt className="text-ink-2">模型</dt>
              <dd className="truncate text-ink">{model}</dd>
            </div>
            {took ? (
              <div>
                <dt className="text-ink-2">用时</dt>
                <dd className="text-ink">{took}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </Modal>
  )
}
