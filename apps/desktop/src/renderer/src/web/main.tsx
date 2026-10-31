import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Catalog, GalleryItem, GalleryPage, InstanceInfo, JobRecord, ProjectDocument, ProjectSummary } from '@shared/types'
import { clampBox, createDraft, exampleDraft, type LayoutDraft } from '../lib/layout'
import { LayoutEditor } from './LayoutEditor'
import '../styles.css'

const TOKEN_KEY = 'mossstudio.web.token'

function readToken(): string {
  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get('token')
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl)
    url.searchParams.delete('token')
    window.history.replaceState({}, '', url.pathname + url.search + url.hash)
    return fromUrl
  }
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

interface Bootstrap {
  projects: ProjectSummary[]
  instances: InstanceInfo[]
  models: Catalog
  gallery: GalleryPage
}

const SIZES: Array<[string, number, number]> = [
  ['512²', 512, 512],
  ['768²', 768, 768],
  ['1024²', 1024, 1024],
  ['1024×768', 1024, 768],
  ['768×1024', 768, 1024],
]

function App(): React.JSX.Element {
  const [token, setToken] = useState(readToken)
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [error, setError] = useState('')
  const [instanceId, setInstanceId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [draft, setDraft] = useState<LayoutDraft>(() => exampleDraft())
  const [steps, setSteps] = useState(8)
  const [cfg, setCfg] = useState(1)
  const [seed, setSeed] = useState(42)
  const [job, setJob] = useState<JobRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [projectName, setProjectName] = useState('MossStudio Project')
  const [projectId, setProjectId] = useState('')
  const [seriesId, setSeriesId] = useState('')
  const [page, setPage] = useState(1)
  const [gallery, setGallery] = useState<GalleryItem[]>([])

  const loaded = useMemo(() => Boolean(bootstrap), [bootstrap])

  async function load(nextToken = token): Promise<void> {
    if (!nextToken) return
    try {
      setError('')
      const data = await api<Bootstrap>(nextToken, '/api/studio/bootstrap')
      const assigned = new URL(window.location.href).searchParams.get('instance')
      setBootstrap(data)
      setGallery(data.gallery?.items ?? [])
      setInstanceId((current) => assigned || current || data.instances[0]?.id || '')
    } catch (cause) {
      setBootstrap(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    void load()
  }, [token])

  async function refreshGallery(): Promise<void> {
    try {
      const page = await api<GalleryPage>(token, '/api/gallery?limit=12')
      setGallery(page.items)
    } catch {
      // keep previous
    }
  }

  async function openProject(id: string): Promise<void> {
    if (!id) {
      setProjectId('')
      return
    }
    try {
      const project = await api<ProjectDocument | null>(token, `/api/projects/${encodeURIComponent(id)}`)
      if (!project) return
      setProjectId(project.id)
      setProjectName(project.name)
      setSeriesId(project.seriesId ?? '')
      setPage(project.page ?? 1)
      const canvas = project.canvases.find((item) => item.kind === 'layout') ?? project.canvases[0]
      if (!canvas) return
      setPrompt(canvas.prompt)
      setNegative(canvas.negative)
      setSeed(canvas.seed)
      setSteps(canvas.steps)
      setCfg(canvas.cfg)
      setDraft({
        width: canvas.width,
        height: canvas.height,
        summary: canvas.summary,
        items: canvas.layers.map((layer) => ({
          id: layer.id,
          label: layer.kind,
          caption: layer.caption,
          text: layer.text,
          bbox: layer.bbox,
          visible: layer.visible,
          locked: layer.locked,
          opacity: layer.opacity,
        })),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    if (!job || !token) return
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'canceled') {
      if (job.state === 'succeeded') void refreshGallery()
      return
    }
    const timer = setInterval(() => {
      void api<JobRecord>(token, `/api/jobs/${encodeURIComponent(job.id)}`).then(setJob).catch(() => undefined)
    }, 1800)
    return () => clearInterval(timer)
  }, [job, token])

  async function generate(): Promise<void> {
    if (!instanceId || !prompt.trim()) {
      setError('先选择实例并写提示词')
      return
    }
    setBusy(true)
    setError('')
    try {
      const next = await api<JobRecord>(token, '/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          instanceId,
          prompt,
          negativePrompt: negative,
          width: draft.width,
          height: draft.height,
          steps,
          cfg,
          seed,
          profile: steps <= 8 ? 'dmd8' : 'base',
          workspace: 'clover',
          mode: 'runner',
        }),
      })
      setJob(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function saveProject(): Promise<void> {
    try {
      const saved = await api<ProjectDocument>(token, '/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          id: projectId || undefined,
          name: projectName,
          width: draft.width,
          height: draft.height,
          summary: draft.summary,
          layers: draft.items.map((item) => ({
            id: item.id,
            kind: item.label,
            caption: item.caption,
            text: item.text,
            bbox: item.bbox,
            visible: item.visible !== false,
            locked: item.locked === true,
            opacity: item.opacity ?? 1,
          })),
          prompt,
          negative,
          seed,
          steps,
          cfg,
          instanceId: instanceId || undefined,
          seriesId: seriesId || undefined,
          page,
        }),
      })
      setProjectId(saved.id)
      setError('')
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (!token || !loaded) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 bg-[#191b1f] px-5 text-[var(--color-text)]">
        <div>
          <div className="text-caption font-semibold uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">MossStudio · LAN</div>
          <h1 className="mt-2 text-[24px] font-semibold">连接到桌面主机</h1>
          <p className="mt-1 text-ui leading-5 text-[var(--color-text-secondary)]">
            {error || '输入桌面端「设置 → 局域网 WebUI」里显示的访问令牌。'}
          </p>
        </div>
        <input
          value={token}
          onChange={(event) => setToken(event.target.value.trim())}
          placeholder="访问令牌"
          className="app-input w-full"
        />
        <button type="button" onClick={() => { void load() }} className="app-button-primary">
          连接
        </button>
      </main>
    )
  }

  const active = job && ['starting', 'running'].includes(job.state)

  return (
    <main className="mx-auto min-h-dvh w-full max-w-[760px] bg-[#191b1f] px-4 pb-10 pt-5 text-[var(--color-text)]">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="text-caption font-semibold uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">MossStudio · LAN</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight">MossStudio</h1>
        </div>
        <span className="rounded-full border border-accent-500/30 bg-accent-500/10 px-2 py-1 text-caption text-accent-300">已连接桌面主机</span>
      </header>

      {error ? <div className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-ui leading-5 text-red-300">{error}</div> : null}

      <section className="mt-4 flex items-end gap-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3">
        <label className="min-w-0 flex-1 space-y-1">
          <span className="text-caption text-[var(--color-text-tertiary)]">Project</span>
          <select
            value={projectId}
            onChange={(event) => { setProjectId(event.target.value); void openProject(event.target.value) }}
            className="app-input w-full"
          >
            <option value="">新草稿</option>
            {bootstrap?.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}{project.page ? ` · 第${project.page}页` : ''} · {project.layerCount} 层</option>
            ))}
          </select>
        </label>
        <label className="w-[110px] space-y-1">
          <span className="text-caption text-[var(--color-text-tertiary)]">系列</span>
          <input value={seriesId} onChange={(event) => setSeriesId(event.target.value)} placeholder="可选" className="app-input w-full" />
        </label>
        <span className="pb-2 text-caption text-[var(--color-text-tertiary)]">第 {page} 页</span>
        <button
          type="button"
          onClick={() => { setProjectId(''); setProjectName('MossStudio Project'); setSeriesId(''); setPage(1); setPrompt(''); setNegative(''); setDraft(exampleDraft()) }}
          className="rounded border border-[var(--color-border-subtle)] px-2.5 py-2 text-caption text-[var(--color-text-secondary)]"
        >
          新建
        </button>
        <button type="button" onClick={() => void saveProject()} className="app-button-primary px-3">保存</button>
      </section>

      <section className="mt-4 space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3.5">
        <label className="block space-y-1">
          <span className="text-caption text-[var(--color-text-tertiary)]">实例</span>
          <select value={instanceId} onChange={(event) => setInstanceId(event.target.value)} className="app-input w-full">
            {bootstrap?.instances.length ? bootstrap.instances.map((instance) => (
              <option key={instance.id} value={instance.id}>{instance.name} · {instance.commit.slice(0, 7)}</option>
            )) : <option value="">桌面端还没有实例</option>}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-caption text-[var(--color-text-tertiary)]">提示词</span>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} className="app-input w-full resize-y" placeholder="写下一个画面……" />
        </label>

        <label className="block space-y-1">
          <span className="text-caption text-[var(--color-text-tertiary)]">负向提示词</span>
          <input value={negative} onChange={(event) => setNegative(event.target.value)} className="app-input w-full" placeholder="可选" />
        </label>

        <LayoutEditor
          draft={draft}
          onChange={setDraft}
          onInsertPrompt={(layout) => setPrompt((previous) => previous.trim() ? `${previous.trim()}\n\n${layout}` : layout)}
          onSaveProject={() => void saveProject()}
        />

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">尺寸</span>
            <select
              value={`${draft.width}x${draft.height}`}
              onChange={(event) => {
                const [w, h] = event.target.value.split('x').map(Number)
                setDraft((previous) => ({
                  ...previous,
                  width: w,
                  height: h,
                  items: previous.items.map((item) => ({ ...item, bbox: clampBox(item.bbox, w, h) })),
                }))
              }}
              className="app-input w-full"
            >
              {SIZES.map(([label, w, h]) => <option key={label} value={`${w}x${h}`}>{label}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">Seed</span>
            <input value={seed} onChange={(event) => setSeed(Number(event.target.value) || 0)} inputMode="numeric" className="app-input w-full" />
          </label>
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">Steps</span>
            <input value={steps} onChange={(event) => setSteps(Number(event.target.value) || 1)} inputMode="numeric" className="app-input w-full" />
          </label>
          <label className="space-y-1">
            <span className="text-caption text-[var(--color-text-tertiary)]">CFG</span>
            <input value={cfg} onChange={(event) => setCfg(Number(event.target.value) || 0)} inputMode="decimal" className="app-input w-full" />
          </label>
        </div>

        <button type="button" onClick={() => void generate()} disabled={busy || Boolean(active)} className="app-button-primary w-full disabled:opacity-50">
          {busy || active ? '生成中…' : '开始生成'}
        </button>
        <p className="text-caption leading-4 text-[var(--color-text-tertiary)]">
          画布/布局 JSON 已可在手机端编辑；Project 全量同步与画廊仍在桌面版。
        </p>
      </section>

      {job ? (
        <section className="mt-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-ui font-medium">生成任务</span>
            <span className="text-caption text-[var(--color-text-tertiary)]">{job.state}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-accent-500 transition-[width]" style={{ width: `${Math.max(0, Math.min(100, job.progress?.percent ?? 0))}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-caption text-[var(--color-text-tertiary)]">
            <span>{job.stage} · {job.progress?.current ?? 0}/{job.progress?.total ?? steps}</span>
            <span>{job.error?.message ?? ''}</span>
          </div>
        </section>
      ) : null}

      <section className="mt-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3.5">
        <div className="flex items-center justify-between">
          <span className="text-ui font-medium">最近结果</span>
          <button type="button" onClick={() => void refreshGallery()} className="text-caption text-accent-300">刷新</button>
        </div>
        {gallery.length === 0 ? (
          <p className="mt-2 text-caption text-[var(--color-text-tertiary)]">还没有输出；真实生成后会出现在这里。</p>
        ) : (
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {gallery.map((item) => {
              const src = `/api/gallery/file?path=${encodeURIComponent(item.path)}&token=${encodeURIComponent(token)}`
              return (
                <a key={item.id} href={src} target="_blank" rel="noreferrer" className="group relative overflow-hidden rounded-md border border-[var(--color-border-subtle)] bg-black/20" style={{ aspectRatio: '1 / 1' }}>
                  <img src={src} alt={item.name} loading="lazy" className="size-full object-cover transition group-hover:scale-[1.02]" />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-micro text-white/80">{item.name}</span>
                </a>
              )
            })}
          </div>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-ui font-medium">保存到 Project</span>
          <button type="button" onClick={() => void saveProject()} className="text-caption text-accent-300">保存</button>
        </div>
        <input value={projectName} onChange={(event) => setProjectName(event.target.value)} className="app-input mt-2 w-full" />
        <div className="mt-2 text-caption text-[var(--color-text-tertiary)]">
          {bootstrap?.projects.length ?? 0} 个桌面 Project；手机端保存为单画布草稿。
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
