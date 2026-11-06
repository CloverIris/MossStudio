import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Catalog, GalleryItem, GalleryPage, InstanceInfo, JobRecord, ProjectDocument, ProjectSummary } from '@shared/types'
import { clampBox, exampleDraft, type LayoutDraft } from '../lib/layout'
import { Button, Card, EmptyState, Field, Input, Pill, ProgressBar, Select, Spinner, Textarea } from '../components/ui'
import { LayoutEditor } from './LayoutEditor'
import '../styles.css'

const dark = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = (): void => { document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light' }
applyTheme()
dark.addEventListener('change', applyTheme)

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
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 bg-surface px-4 text-ink">
        <div>
          <h1 className="text-title font-semibold">连接到电脑</h1>
          <p className="mt-2 text-ui text-ink-2">
            {error || '请输入电脑端「设置 › 功能 › 局域网访问」里显示的访问码。'}
          </p>
        </div>
        <Input
          value={token}
          onChange={(event) => setToken(event.target.value.trim())}
          placeholder="访问码"
          aria-label="访问码"
          className="h-11"
        />
        <Button tone="primary" size="lg" block onClick={() => { void load() }}>
          连接
        </Button>
      </main>
    )
  }

  const active = job && ['starting', 'running'].includes(job.state)
  const stateText: Record<string, string> = {
    queued: '排队中',
    starting: '准备中',
    running: '生成中',
    succeeded: '已完成',
    failed: '失败',
    canceled: '已取消',
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col gap-4 bg-surface px-4 pb-10 pt-5 text-ink">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title font-semibold">MossStudio</h1>
        <Pill tone="ok">已连接电脑</Pill>
      </header>

      {error ? <div className="rounded-lg bg-danger-soft px-3 py-2 text-ui text-danger">{error}</div> : null}

      <Card tone="panel" className="flex flex-col gap-3 p-4">
        <Field label="项目">
          <Select
            value={projectId}
            onChange={(event) => { setProjectId(event.target.value); void openProject(event.target.value) }}
            className="h-11"
          >
            <option value="">新草稿</option>
            {bootstrap?.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}{project.page ? ` · 第${project.page}页` : ''} · {project.layerCount} 层</option>
            ))}
          </Select>
        </Field>
        <Field label="系列（可选）" hint={`第 ${page} 页`}>
          <Input value={seriesId} onChange={(event) => setSeriesId(event.target.value)} placeholder="例如：我的绘本" className="h-11" />
        </Field>
        <div className="flex gap-2">
          <Button
            size="md"
            className="h-11 flex-1"
            onClick={() => { setProjectId(''); setProjectName('MossStudio Project'); setSeriesId(''); setPage(1); setPrompt(''); setNegative(''); setDraft(exampleDraft()) }}
          >
            新建
          </Button>
          <Button size="md" className="h-11 flex-1" onClick={() => void saveProject()}>保存</Button>
        </div>
      </Card>

      <Card tone="panel" className="flex flex-col gap-3 p-4">
        <Field label="使用哪台引擎">
          <Select value={instanceId} onChange={(event) => setInstanceId(event.target.value)} className="h-11">
            {bootstrap?.instances.length ? bootstrap.instances.map((instance) => (
              <option key={instance.id} value={instance.id}>{instance.name} · {instance.commit.slice(0, 7)}</option>
            )) : <option value="">电脑上还没有可用的引擎</option>}
          </Select>
        </Field>

        <Field label="想画什么">
          <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} placeholder="写下一个画面……" />
        </Field>

        <Field label="不想出现的内容">
          <Input value={negative} onChange={(event) => setNegative(event.target.value)} className="h-11" placeholder="可选" />
        </Field>

        <LayoutEditor
          draft={draft}
          onChange={setDraft}
          onInsertPrompt={(layout) => setPrompt((previous) => previous.trim() ? `${previous.trim()}\n\n${layout}` : layout)}
          onSaveProject={() => void saveProject()}
        />

        <div className="grid grid-cols-2 gap-3">
          <Field label="尺寸">
            <Select
              value={`${draft.width}x${draft.height}`}
              onChange={(event) => {
                const [w, h] = event.target.value.split('x').map(Number)
                setDraft((previous) => ({
                  ...previous,
                  width: w!,
                  height: h!,
                  items: previous.items.map((item) => ({ ...item, bbox: clampBox(item.bbox, w!, h!) })),
                }))
              }}
              className="h-11"
            >
              {SIZES.map(([label, w, h]) => <option key={label} value={`${w}x${h}`}>{label}</option>)}
            </Select>
          </Field>
          <Field label="随机种子">
            <Input value={seed} onChange={(event) => setSeed(Number(event.target.value) || 0)} inputMode="numeric" className="tabular h-11" />
          </Field>
          <Field label="步数">
            <Input value={steps} onChange={(event) => setSteps(Number(event.target.value) || 1)} inputMode="numeric" className="tabular h-11" />
          </Field>
          <Field label="贴合度">
            <Input value={cfg} onChange={(event) => setCfg(Number(event.target.value) || 0)} inputMode="decimal" className="tabular h-11" />
          </Field>
        </div>

        <Button tone="primary" size="lg" block onClick={() => void generate()} disabled={busy || Boolean(active)}>
          {busy || active ? <><Spinner /> 生成中…</> : '开始生成'}
        </Button>
      </Card>

      {job ? (
        <Card tone="panel" className="flex flex-col gap-2 p-4">
          <div className="flex items-center justify-between">
            <span className="text-control font-medium">生成进度</span>
            <Pill tone={job.state === 'failed' ? 'danger' : job.state === 'succeeded' ? 'ok' : 'neutral'}>{stateText[job.state] ?? job.state}</Pill>
          </div>
          <ProgressBar label="生成进度" value={job.progress?.percent ?? 0} />
          <div className="tabular flex justify-between gap-2 text-caption text-ink-2">
            <span>{job.stage} · {job.progress?.current ?? 0}/{job.progress?.total ?? steps}</span>
            <span className="text-danger">{job.error?.message ?? ''}</span>
          </div>
        </Card>
      ) : null}

      <Card tone="panel" className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <span className="text-control font-medium">最近作品</span>
          <Button tone="ghost" onClick={() => void refreshGallery()}>刷新</Button>
        </div>
        {gallery.length === 0 ? (
          <EmptyState title="还没有作品" description="生成成功后会出现在这里。" className="py-8" />
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {gallery.map((item) => {
              const src = `/api/gallery/file?path=${encodeURIComponent(item.path)}&token=${encodeURIComponent(token)}`
              return (
                <a key={item.id} href={src} target="_blank" rel="noreferrer" aria-label={item.name} className="block overflow-hidden rounded-lg bg-well" style={{ aspectRatio: '1 / 1' }}>
                  <img src={src} alt={item.name} loading="lazy" className="size-full object-cover" />
                </a>
              )
            })}
          </div>
        )}
      </Card>

      <Card tone="panel" className="flex flex-col gap-3 p-4">
        <Field label="项目名称" hint={`电脑上共有 ${bootstrap?.projects.length ?? 0} 个项目；手机上保存为单画布草稿。`}>
          <Input value={projectName} onChange={(event) => setProjectName(event.target.value)} className="h-11" />
        </Field>
        <Button size="md" className="h-11" onClick={() => void saveProject()}>保存项目</Button>
      </Card>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
