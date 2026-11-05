import { Images, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ipc, Events } from '@shared/channels'
import type { GalleryItem, JobRecord, ProjectSummary } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { cloverUrl } from '../../lib/clover'
import { Button, EmptyState, IconButton, Input, Select, Spinner, cn } from '../../components/ui'
import { DetailPanel } from './DetailPanel'
import {
  EMPTY_FILTERS,
  TIME_FILTERS,
  afterRemoval,
  countLabel,
  groupByDay,
  hasFilters,
  stepIndex,
  type LibraryFilters,
  type TimeFilter,
} from './logic'
import { useGallery } from './useGallery'

function useProjects(): ProjectSummary[] {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const load = useCallback(() => {
    call<ProjectSummary[]>(Ipc.projectsList).then(setProjects).catch(() => undefined)
  }, [])
  useEffect(() => {
    load()
    // A new project usually appears together with its first finished job.
    return onEvent<JobRecord>(Events.job, (job) => {
      if (job.state === 'succeeded') load()
    })
  }, [load])
  return projects
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** 作品: every generated image, grouped by day, with a detail panel on the right. */
export function LibraryPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS)
  const gallery = useGallery(filters)
  const projects = useProjects()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setFilters((current) => ({ ...current, query: search })), 260)
    return () => window.clearTimeout(timer)
  }, [search])

  const { items, total, cursor, loading, error, loaded, loadMore, reload, remove } = gallery
  const groups = useMemo(() => groupByDay(items), [items])
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects])
  const selectedIndex = selectedPath ? items.findIndex((item) => item.path === selectedPath) : -1
  const selected: GalleryItem | null = selectedIndex >= 0 ? items[selectedIndex]! : null

  // Close the panel when its image leaves the listing (filters changed, deleted elsewhere).
  useEffect(() => {
    if (selectedPath && loaded && !loading && selectedIndex < 0) setSelectedPath(null)
  }, [loaded, loading, selectedIndex, selectedPath])

  useEffect(() => {
    const element = sentinel.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      { root: scroller.current, rootMargin: '600px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [loadMore, cursor])

  const select = useCallback((path: string) => {
    setSelectedPath(path)
    document.querySelector(`[data-library-item="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [])

  // "Next" on the last loaded image waits for the next page, then moves on.
  const pendingNext = useRef<string | null>(null)
  useEffect(() => {
    const from = pendingNext.current
    if (!from || loading) return
    pendingNext.current = null
    const index = stepIndex(items, from, 1)
    if (index >= 0 && items[index]!.path !== from && selectedPath === from) select(items[index]!.path)
  }, [items, loading, select, selectedPath])

  const step = useCallback(
    (delta: -1 | 1) => {
      if (!selectedPath) return
      const index = stepIndex(items, selectedPath, delta)
      if (index < 0) return
      if (delta > 0 && index >= items.length - 3) void loadMore()
      if (items[index]!.path === selectedPath) {
        if (delta > 0 && cursor) pendingNext.current = selectedPath
        return
      }
      select(items[index]!.path)
    },
    [cursor, items, loadMore, select, selectedPath],
  )

  useEffect(() => {
    if (!selectedPath) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTyping(event.target) || document.querySelector('dialog[open]')) return
      // Pages stay mounted while hidden; only react while the Library is on screen.
      if (!root.current || root.current.offsetParent === null) return
      if (event.key === 'ArrowLeft') step(-1)
      else if (event.key === 'ArrowRight') step(1)
      else if (event.key === 'Escape') setSelectedPath(null)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedPath, step])

  const itemsRef = useRef(items)
  itemsRef.current = items
  const onDeleted = useCallback(
    (path: string) => {
      const next = afterRemoval(itemsRef.current, path)
      remove(path)
      // The user may have stepped to another image while the delete was running.
      setSelectedPath((current) => (current === path ? (next?.path ?? null) : current))
    },
    [remove],
  )

  const filtered = hasFilters(filters)
  const clearFilters = (): void => {
    setSearch('')
    setFilters(EMPTY_FILTERS)
  }

  return (
    <div ref={root} className="flex h-full bg-surface">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 px-8 pb-4 pt-6">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="text-title font-semibold text-ink">作品</h1>
            {loaded && !error ? <span className="tabular text-ui text-ink-2">{countLabel(total)}</span> : null}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="relative block">
              <span className="sr-only">搜索作品</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-2" strokeWidth={1.6} aria-hidden="true" />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索提示词或文件名"
                className="w-60 pl-8"
              />
            </label>
            <Select
              aria-label="按项目筛选"
              value={filters.projectId}
              onValueChange={(projectId) => setFilters((current) => ({ ...current, projectId }))}
              className="w-40"
              options={[{ value: '', label: '全部项目' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
            />
            <Select
              aria-label="按时间筛选"
              value={filters.time}
              onValueChange={(time) => setFilters((current) => ({ ...current, time: time as TimeFilter }))}
              className="w-32"
              options={TIME_FILTERS}
            />
            <IconButton label="刷新" disabled={loading} onClick={reload}>
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} strokeWidth={1.6} />
            </IconButton>
          </div>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
          {error && items.length === 0 ? (
            <EmptyState
              icon={<Images className="size-8" strokeWidth={1.6} />}
              title="作品读取失败"
              description={`${error}。检查图片文件夹是否还在，然后重试。`}
              action={
                <div className="flex gap-2">
                  <Button tone="primary" onClick={reload}>重试</Button>
                  <Button tone="secondary" onClick={() => navigate('/settings/storage')}>查看图片文件夹</Button>
                </div>
              }
            />
          ) : !loaded ? (
            <div className="flex justify-center py-20">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            filtered ? (
              <EmptyState
                icon={<Search className="size-8" strokeWidth={1.6} />}
                title="没有符合条件的作品"
                description="换个关键词，或者放宽项目和时间筛选。"
                action={<Button tone="secondary" onClick={clearFilters}><X className="size-4" strokeWidth={1.6} /> 清除筛选</Button>}
              />
            ) : (
              <EmptyState
                icon={<Images className="size-8" strokeWidth={1.6} />}
                title="还没有作品"
                description="在创作中生成的图片会出现在这里。也可以添加电脑上已有的图片文件夹。"
                action={
                  <div className="flex gap-2">
                    <Button tone="primary" onClick={() => navigate('/studio')}>去创作</Button>
                    <Button tone="secondary" onClick={() => navigate('/settings/storage')}>添加图片文件夹</Button>
                  </div>
                }
              />
            )
          ) : (
            <div className="flex flex-col gap-6">
              {groups.map((group) => (
                <section key={group.key} aria-label={group.label} className="flex flex-col gap-2.5">
                  <h2 className="text-ui font-semibold text-ink-2">{group.label}</h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2">
                    {group.items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        data-library-item={item.path}
                        aria-label={item.prompt ? `${item.name}：${item.prompt.slice(0, 60)}` : item.name}
                        aria-pressed={item.path === selectedPath}
                        onClick={() => setSelectedPath(item.path === selectedPath ? null : item.path)}
                        className={cn(
                          'group relative aspect-square overflow-hidden rounded-lg bg-panel outline-offset-2 transition-opacity',
                          item.path === selectedPath ? 'outline-2 outline-accent' : 'hover:opacity-90',
                        )}
                        style={{ contentVisibility: 'auto', containIntrinsicSize: '160px' }}
                      >
                        <img src={cloverUrl(item.path)} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          <div ref={sentinel} className="flex h-14 items-center justify-center">
            {items.length > 0 && loading ? <Spinner className="text-ink-2" /> : null}
            {items.length > 0 && !loading && error ? (
              <Button tone="ghost" onClick={() => void loadMore()}>没能加载更多，重试</Button>
            ) : null}
          </div>

          {/* The empty states already say where pictures come from. */}
          {items.length > 0 ? (
            <p className="text-center text-caption text-ink-2">
              图片来自输出目录和你添加的文件夹。
              <button type="button" className="text-ink underline-offset-2 hover:underline" onClick={() => navigate('/settings/storage')}>
                在 设置 › 存储 中管理
              </button>
            </p>
          ) : null}
        </div>
      </div>

      {selected ? (
        <DetailPanel
          item={selected}
          position={selectedIndex + 1}
          total={total}
          canPrevious={selectedIndex > 0}
          canNext={selectedIndex < items.length - 1 || Boolean(cursor)}
          projectNames={projectNames}
          onStep={step}
          onClose={() => setSelectedPath(null)}
          onDeleted={onDeleted}
        />
      ) : null}
    </div>
  )
}
