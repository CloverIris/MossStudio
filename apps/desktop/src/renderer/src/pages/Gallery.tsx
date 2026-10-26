import { FolderOpen, Image as ImageIcon, Images, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ipc, Events } from '@shared/channels'
import type { GalleryDetail, GalleryItem, GalleryPage, JobRecord } from '@shared/types'
import { call, onEvent } from '../lib/api'
import { cloverUrl } from '../lib/clover'
import { openWindow } from '../lib/windows'
import { bytes, dateTime, relative } from '../lib/format'
import { useApp } from '../store'
import { Button, Card, EmptyState, IconButton, Input, Modal, Pill, Spinner, useToast } from '../components/ui'

const PAGE_SIZE = 48

export function GalleryPage(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const setStudioBackground = useApp((state) => state.setStudioBackground)
  const creatorWindow = window.clover.windowKind === 'creator'
  const [items, setItems] = useState<GalleryItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<GalleryDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const busy = useRef(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 260)
    return () => window.clearTimeout(timer)
  }, [search])

  const load = useCallback(
    async (reset: boolean, cursorValue: string | null, queryValue: string) => {
      if (busy.current) return
      busy.current = true
      setLoading(true)
      try {
        const page = await call<GalleryPage>(Ipc.galleryList, {
          cursor: reset ? undefined : (cursorValue ?? undefined),
          limit: PAGE_SIZE,
          query: queryValue || undefined,
        })
        setItems((previous) => (reset ? page.items : [...previous, ...page.items]))
        setCursor(page.nextCursor)
        setTotal(page.total)
      } catch (error) {
        toast.push(error instanceof Error ? error.message : String(error), 'error')
      } finally {
        busy.current = false
        setLoading(false)
      }
    },
    [toast],
  )

  useEffect(() => {
    void load(true, null, query)
  }, [load, query])

  // New generation results land in the gallery roots; refresh when a job succeeds.
  const queryRef = useRef(query)
  useEffect(() => {
    queryRef.current = query
  }, [query])
  useEffect(
    () =>
      onEvent<JobRecord>(Events.job, (job) => {
        if (job.state === 'succeeded' && (job.outputs?.length ?? 0) > 0) void load(true, null, queryRef.current)
      }),
    [load],
  )

  useEffect(() => {
    const element = sentinel.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && cursor && !busy.current) {
          void load(false, cursor, query)
        }
      },
      { rootMargin: '500px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [cursor, load, query])

  async function openDetail(item: GalleryItem): Promise<void> {
    setDetailLoading(true)
    try {
      const result = await call<GalleryDetail>(Ipc.galleryItem, { path: item.path })
      setDetail(result)
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">画廊</h1>
          <p className="mt-1 text-ui text-[var(--color-text-secondary)]">
            从输出目录与自定义路径读取；分段加载 + content-visibility，大目录也不会一次性渲染。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone="neutral">{total} 张作品</Pill>
          <IconButton label="刷新" onClick={() => void load(true, null, query)} disabled={loading}>
            <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </IconButton>
        </div>
      </header>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索文件名或路径…"
            className="w-full pl-8 pr-3"
          />
        </div>
        <Button
          tone="ghost"
          onClick={() => (creatorWindow ? openWindow('launcher', '/settings') : navigate('/settings'))}
        >
          配置路径
        </Button>
      </div>

      {items.length === 0 && !loading ? (
        <EmptyState
          icon={<Images className="size-8" />}
          title="还没有作品"
          description="生成图片后会自动出现在输出目录；也可以在设置里添加任意本地文件夹。"
          action={
            <Button
              tone="primary"
              onClick={() => (creatorWindow ? openWindow('launcher', '/settings') : navigate('/settings'))}
            >
              打开画廊设置
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => void openDetail(item)}
              className="group relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-subtle)] bg-white/[0.03] text-left shadow-[0_2px_10px_rgba(0,0,0,0.08)] transition hover:-translate-y-0.5 hover:border-accent-400/40 hover:shadow-[0_8px_24px_rgba(0,0,0,0.22)]"
              style={{ contentVisibility: 'auto', containIntrinsicSize: '240px' }}
            >
              <div className="aspect-square w-full overflow-hidden bg-[var(--color-surface-tertiary)]">
                <img
                  src={cloverUrl(item.path)}
                  alt={item.name}
                  loading="lazy"
                  decoding="async"
                  className="size-full object-cover transition duration-200 group-hover:scale-[1.03]"
                />
              </div>
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/25 to-transparent px-2.5 pb-2 pt-7">
                <div className="truncate text-ui font-medium text-white">{item.name}</div>
                <div className="mt-0.5 flex items-center justify-between text-caption text-white/70">
                  <span>{relative(new Date(item.mtime).toISOString())}</span>
                  <span>{item.width && item.height ? `${item.width}×${item.height}` : bytes(item.size)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <div ref={sentinel} className="flex h-12 items-center justify-center">
        {loading ? (
          <Spinner className="text-accent-500" />
        ) : cursor ? (
          <Button tone="ghost" onClick={() => void load(false, cursor, query)}>
            加载更多
          </Button>
        ) : items.length > 0 ? (
          <span className="text-ui text-[var(--color-text-tertiary)]">已加载全部 {total} 张</span>
        ) : null}
      </div>

      <Modal
        open={Boolean(detail) || detailLoading}
        onClose={() => {
          setDetail(null)
          setDetailLoading(false)
        }}
        title={detail?.name ?? '读取作品…'}
        description={detail ? detail.path : undefined}
        width="max-w-4xl"
        footer={
          detail ? (
            <>
              <Button tone="ghost" onClick={() => void call(Ipc.galleryReveal, { path: detail.path })}>
                <span className="inline-flex items-center gap-1.5">
                  <FolderOpen className="size-4" /> 在文件夹中显示
                </span>
              </Button>
              <Button
                tone="secondary"
                onClick={() => {
                  setStudioBackground(detail)
                  try {
                    localStorage.setItem('clover.studioBackground', JSON.stringify(detail))
                  } catch {
                    // storage may be unavailable
                  }
                  if (creatorWindow) navigate('/studio')
                  else openWindow('creator', '/studio')
                }}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="size-4" /> 用作布局底图
                </span>
              </Button>
            </>
          ) : null
        }
      >
        {detailLoading && !detail ? (
          <div className="flex items-center justify-center py-20">
            <Spinner />
          </div>
        ) : detail ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1.4fr_1fr]">
            <div className="flex max-h-[52vh] items-center justify-center overflow-hidden rounded-[6px] bg-[var(--color-surface-secondary)]">
              <img src={cloverUrl(detail.path)} alt={detail.name} className="max-h-[52vh] w-full object-contain" />
            </div>
            <div className="space-y-3 text-ui">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-[4px] bg-white/[0.04] px-2.5 py-2 ">
                  <div className="text-caption text-[var(--color-text-tertiary)]">尺寸</div>
                  <div className="mt-0.5 font-medium">
                    {detail.width && detail.height ? `${detail.width} × ${detail.height}` : '未知'}
                  </div>
                </div>
                <div className="rounded-[4px] bg-white/[0.04] px-2.5 py-2 ">
                  <div className="text-caption text-[var(--color-text-tertiary)]">文件</div>
                  <div className="mt-0.5 font-medium">{bytes(detail.size)}</div>
                </div>
                <div className="rounded-[4px] bg-white/[0.04] px-2.5 py-2 ">
                  <div className="text-caption text-[var(--color-text-tertiary)]">修改时间</div>
                  <div className="mt-0.5 font-medium">{dateTime(new Date(detail.mtime).toISOString())}</div>
                </div>
                <div className="rounded-[4px] bg-white/[0.04] px-2.5 py-2 ">
                  <div className="text-caption text-[var(--color-text-tertiary)]">Seed</div>
                  <div className="mt-0.5 font-mono font-medium">{detail.seed ?? '—'}</div>
                </div>
              </div>
              <div>
                <div className="mb-1 text-caption text-[var(--color-text-tertiary)]">Prompt / 元数据</div>
                <div className="max-h-40 overflow-y-auto rounded-[4px] bg-white/[0.04] px-2.5 py-2 text-ui leading-5 text-[var(--color-text-secondary)] ">
                  {detail.prompt ?? '这张图没有可读的 prompt 元数据。'}
                </div>
              </div>
              <div>
                <div className="mb-1 text-caption text-[var(--color-text-tertiary)]">所在目录</div>
                <div className="break-all rounded-[4px] bg-white/[0.04] px-2.5 py-2 font-mono text-caption text-[var(--color-text-secondary)] ">
                  {detail.dir}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
