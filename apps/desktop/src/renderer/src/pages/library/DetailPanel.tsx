import { ArrowLeft, ArrowRight, Copy, FolderOpen, ImageIcon, Sparkles, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ipc } from '@shared/channels'
import type { GalleryDetail, GalleryItem } from '@shared/types'
import { call } from '../../lib/api'
import { cloverUrl } from '../../lib/clover'
import { buildReuseRequest, canReuse } from '../../lib/studioReuse'
import { useApp } from '../../store'
import { Button, ConfirmDialog, IconButton, Spinner, useCopyText, useToast } from '../../components/ui'
import { detailFacts } from './logic'

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
const trashName = (): string => (window.clover.platform === 'darwin' ? '废纸篓' : '回收站')

/** Right-hand panel for the selected image: preview, prompt, parameters and actions. */
export function DetailPanel({
  item,
  position,
  total,
  canPrevious,
  canNext,
  projectNames,
  onStep,
  onClose,
  onDeleted,
}: {
  item: GalleryItem
  /** 1-based position of the item in the listing. */
  position: number
  total: number
  canPrevious: boolean
  canNext: boolean
  projectNames: Map<string, string>
  onStep: (delta: -1 | 1) => void
  onClose: () => void
  onDeleted: (path: string) => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const copy = useCopyText()
  const setStudioBackground = useApp((state) => state.setStudioBackground)
  const requestStudioReuse = useApp((state) => state.requestStudioReuse)
  const [detail, setDetail] = useState<GalleryDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const sequence = useRef(0)

  useEffect(() => {
    const run = ++sequence.current
    setError(null)
    setDetail((current) => (current?.path === item.path ? current : null))
    call<GalleryDetail>(Ipc.galleryItem, { path: item.path })
      .then((result) => {
        if (run === sequence.current) setDetail(result)
      })
      .catch((cause: unknown) => {
        if (run === sequence.current) setError(message(cause))
      })
  }, [item.path, attempt])

  const shown = detail?.path === item.path ? detail : null

  const reuse = useCallback(() => {
    if (!shown) return
    requestStudioReuse(buildReuseRequest(shown))
    navigate('/studio')
  }, [navigate, requestStudioReuse, shown])

  const useAsBackground = useCallback(() => {
    const source = shown ?? item
    setStudioBackground(source)
    try {
      localStorage.setItem('clover.studioBackground', JSON.stringify(source))
    } catch {
      // storage may be unavailable; the store still carries it
    }
    navigate('/studio')
  }, [item, navigate, setStudioBackground, shown])

  const reveal = useCallback(() => {
    void call(Ipc.galleryReveal, { path: item.path }).catch((cause: unknown) => toast.push(message(cause), 'error'))
  }, [item.path, toast])

  const remove = useCallback(async () => {
    setConfirming(false)
    setDeleting(true)
    try {
      await call(Ipc.galleryTrash, { path: item.path })
      toast.push(`已移到${trashName()}`, 'success')
      onDeleted(item.path)
    } catch (cause) {
      toast.push(`没能删除：${message(cause)}`, 'error')
    } finally {
      setDeleting(false)
    }
  }, [item.path, onDeleted, toast])

  const projectId = shown?.generation?.projectId ?? shown?.projectId ?? item.projectId
  const facts = shown ? detailFacts(shown, { projectName: projectId ? projectNames.get(projectId) : undefined }) : []
  const prompt = shown?.prompt?.trim()

  return (
    <aside aria-label="作品详情" className="flex h-full w-[380px] shrink-0 flex-col bg-panel">
      <div className="flex h-12 shrink-0 items-center gap-1 px-3">
        <span className="tabular min-w-0 flex-1 truncate px-1 text-caption text-ink-2">
          {position} / {total.toLocaleString('en-US')}
        </span>
        <IconButton label="上一张（←）" disabled={!canPrevious} onClick={() => onStep(-1)}>
          <ArrowLeft className="size-4" strokeWidth={1.6} />
        </IconButton>
        <IconButton label="下一张（→）" disabled={!canNext} onClick={() => onStep(1)}>
          <ArrowRight className="size-4" strokeWidth={1.6} />
        </IconButton>
        <IconButton label="关闭详情（Esc）" onClick={onClose}>
          <X className="size-4" strokeWidth={1.6} />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        <div className="flex aspect-square w-full shrink-0 items-center justify-center overflow-hidden rounded-lg bg-well">
          <img key={item.path} src={cloverUrl(item.path)} alt={item.name} className="size-full object-contain" />
        </div>

        <div className="min-w-0">
          <div className="truncate text-control font-medium text-ink" title={item.name}>{item.name}</div>
        </div>

        {error ? (
          <div className="flex flex-col gap-2 rounded-lg bg-danger-soft p-3">
            <p className="text-ui text-danger">读不到这张图片的信息：{error}</p>
            <div>
              <Button tone="secondary" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
            </div>
          </div>
        ) : !shown ? (
          <div className="flex items-center gap-2 text-ui text-ink-2">
            <Spinner /> 正在读取
          </div>
        ) : (
          <>
            <section aria-label="提示词" className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <h3 className="text-caption font-medium text-ink-2">提示词</h3>
                {prompt ? (
                  <IconButton label="复制提示词" className="size-7" onClick={() => void copy(prompt, '已复制提示词')}>
                    <Copy className="size-3.5" strokeWidth={1.6} />
                  </IconButton>
                ) : null}
              </div>
              <p className="selectable max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-well px-3 py-2.5 text-ui leading-relaxed text-ink [overflow-wrap:anywhere]">
                {prompt || <span className="text-ink-2">这张图片没有记录提示词。</span>}
              </p>
              {shown.generation?.regions ? (
                <p className="text-caption text-ink-2">
                  这张图片按 {shown.generation.regions} 个区域的布局生成；复用时带上整体描述，区域需要重新画。
                </p>
              ) : null}
              {shown.negativePrompt?.trim() ? (
                <p className="text-caption text-ink-2 [overflow-wrap:anywhere]">不想出现：{shown.negativePrompt}</p>
              ) : null}
            </section>

            {facts.length ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-ui">
                {facts.map((fact) => (
                  <div key={fact.label} className="contents">
                    <dt className="text-ink-2">{fact.label}</dt>
                    <dd className="tabular min-w-0 text-ink [overflow-wrap:anywhere]">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 p-4">
        <Button
          tone="primary"
          size="md"
          block
          disabled={!canReuse(shown)}
          title={shown && !canReuse(shown) ? '这张图片没有记录生成参数' : undefined}
          onClick={reuse}
        >
          <Sparkles className="size-4" strokeWidth={1.6} /> 在创作中复用
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button tone="secondary" onClick={useAsBackground}>
            <ImageIcon className="size-4" strokeWidth={1.6} /> 用作底图
          </Button>
          <Button tone="secondary" onClick={reveal}>
            <FolderOpen className="size-4" strokeWidth={1.6} /> 在文件夹中显示
          </Button>
        </div>
        <Button tone="ghost" className="text-danger" disabled={deleting} onClick={() => setConfirming(true)}>
          {deleting ? <Spinner /> : <Trash2 className="size-4" strokeWidth={1.6} />} 删除
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        title="删除这张图片？"
        description={`「${item.name}」会移到系统${trashName()}，需要时可以从那里恢复。`}
        confirmLabel={`移到${trashName()}`}
        onClose={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    </aside>
  )
}
