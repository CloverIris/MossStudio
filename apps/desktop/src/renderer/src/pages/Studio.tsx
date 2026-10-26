import {
  ArrowRight,
  Box,
  GitBranch,
  Minus,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  RotateCcw,
  Copy,
  Eraser,
  Sparkles,
  ScanSearch,
  SquareDashedMousePointer,
  Type,
  UserRound,
  X,
  Eye,
  EyeOff,
  Lock,
  Unlock,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GalleryItem, JobRecord, ManagedHost, ProjectDocument, ProjectSummary } from '@shared/types'
import type { BackendInfo } from '@shared/backend'
import { Events, Ipc } from '@shared/channels'
import { call, onEvent } from '../lib/api'
import { electronStudioClient } from '../lib/studioClient'
import { openWindow } from '../lib/windows'
import { cloverUrl } from '../lib/clover'
import {
  clampBox,
  compileLayout,
  createDraft,
  exampleDraft,
  type CompileResult,
  type LayoutDraft,
  type LayoutLabel,
} from '../lib/layout'
import { useApp } from '../store'
import { Button, ConfirmDialog, IconButton, Input, Modal, Pill, Segmented, Select, Spinner, Textarea, cn, useCopyText, useToast } from '../components/ui'
import { PromptSegmentsModal } from '../components/PromptSegmentsModal'
import { GbcImportModal } from '../components/GbcImportModal'
import { AgentSidebar } from '../components/AgentSidebar'
import { StudioSection } from '../components/studio/StudioSection'
import { StudioSidebar } from '../components/studio/StudioSidebar'
import type { GbcImageResult, GbcRunResult } from '@shared/gbc'

const SIZE_PRESETS: Array<[string, number, number]> = [
  ['512²', 512, 512],
  ['768²', 768, 768],
  ['1024²', 1024, 1024],
  ['1024×768', 1024, 768],
  ['768×1024', 768, 1024],
]

const LABEL_META: Record<LayoutLabel, { name: string; color: string; icon: React.ReactNode }> = {
  object: { name: '物体', color: 'accent', icon: <Box className="size-4" /> },
  character: { name: '人物', color: 'sky', icon: <UserRound className="size-4" /> },
  text: { name: '文字', color: 'amber', icon: <Type className="size-4" /> },
}

type SectionId = 'prompt' | 'sampler' | 'summary' | 'layers' | 'gallery'
const TOOL_TABS = [
  { id: 'layout', label: '图层与布局' },
  { id: 'agent', label: 'Agent' },
  { id: 'analysis', label: '图像解析' },
] as const
type ToolId = typeof TOOL_TABS[number]['id']

function MiniGallery(): React.JSX.Element {
  const setStudioBackground = useApp((state) => state.setStudioBackground)
  const [items, setItems] = useState<GalleryItem[]>([])
  useEffect(() => {
    const reload = (): void => {
      void call<{ items: GalleryItem[] }>(Ipc.galleryList, { limit: 8 }).then((page) => setItems(page.items ?? [])).catch(() => undefined)
    }
    reload()
    // refresh thumbnails when a generation job succeeds
    return onEvent<JobRecord>(Events.job, (job) => {
      if (job.state === 'succeeded' && (job.outputs?.length ?? 0) > 0) reload()
    })
  }, [])
  return (
    <div className="p-2">
      <div className="grid grid-cols-4 gap-1">
        {items.map((item) => (
          <button
            key={item.path}
            type="button"
            title={item.name}
            onClick={() => setStudioBackground(item)}
            className="aspect-square overflow-hidden rounded border border-white/10 bg-black/20 hover:border-accent-400"
          >
            <img src={cloverUrl(item.path)} alt={item.name} className="size-full object-cover" loading="lazy" />
          </button>
        ))}
        {items.length === 0 ? <span className="col-span-4 py-4 text-center text-caption text-[var(--color-text-tertiary)]">画廊为空</span> : null}
      </div>
    </div>
  )
}

interface DraftTabSnapshot {
  name: string
  draft: LayoutDraft
  prompt: string
  negative: string
  seed: number
  steps: number
  cfg: number
  modelBundleId: string
  deviceId: string
  seriesId: string
  page: number
  background: GalleryItem | null
}

type DragState =
  | { kind: 'move' | 'resize'; id: string; startX: number; startY: number; origin: [number, number, number, number] }
  | null

function draftFromProject(project: ProjectDocument): LayoutDraft {
  return {
    width: project.width,
    height: project.height,
    summary: project.summary,
    items: project.layers.map((layer) => ({
      id: layer.id,
      label: layer.kind,
      caption: layer.caption,
      text: layer.text,
      bbox: layer.bbox,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
    })),
  }
}

function projectSnapshot(input: {
  name: string
  draft: LayoutDraft
  prompt: string
  negative: string
  seed: number
  steps: number
  cfg: number
  modelBundleId: string
  deviceId: string
  backgroundPath?: string
  seriesId: string
  page: number
}): string {
  return JSON.stringify(input)
}

export function StudioPage(): React.JSX.Element {
  const copyText = useCopyText()
  const toast = useToast()
  const storedPrompt = useApp((state) => state.studioPrompt)
  const storedDraft = useApp((state) => state.studioDraft)
  const background = useApp((state) => state.studioBackground)
  const setStudioPrompt = useApp((state) => state.setStudioPrompt)
  const setStudioDraft = useApp((state) => state.setStudioDraft)
  const setStudioBackground = useApp((state) => state.setStudioBackground)

  useEffect(() => {
    if (background) return
    try {
      const raw = localStorage.getItem('clover.studioBackground')
      if (!raw) return
      const item = JSON.parse(raw) as GalleryItem
      setStudioBackground(item)
      localStorage.removeItem('clover.studioBackground')
    } catch {
      // ignore
    }
  }, [background, setStudioBackground])
  const catalog = useApp((state) => state.catalog)
  const devices = useApp((state) => state.devices)
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [engineHostId, setEngineHostId] = useState('')
  const [remoteModelPath, setRemoteModelPath] = useState('')
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const list = await call<ManagedHost[]>(Ipc.hostsList)
      if (cancelled) return
      const ssh = list.filter((host) => host.kind === 'ssh')
      setHosts(ssh)
      // Hosts with no persisted probe result are tested in the background; no device-page detour.
      for (const host of ssh.filter((item) => item.status !== 'ok')) {
        void call(Ipc.hostsTest, { id: host.id }).then(() => { if (!cancelled) void call<ManagedHost[]>(Ipc.hostsList).then((next) => { if (!cancelled) setHosts(next.filter((item) => item.kind === 'ssh')) }) }).catch(() => undefined)
      }
    }
    void load().catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  const env = useApp((state) => state.env)
  useEffect(() => onEvent<{ id: string }>(Events.hostsChanged, () => { void call<ManagedHost[]>(Ipc.hostsList).then((list) => setHosts(list.filter((host) => host.kind === 'ssh'))).catch(() => undefined) }), [])

  const [prompt, setPrompt] = useState(storedPrompt)
  const [negative, setNegative] = useState('nsfw, worst quality, bad anatomy, watermark, jpeg artifact')
  const [draft, setDraft] = useState<LayoutDraft>(storedDraft ?? exampleDraft())
  const [tool, setTool] = useState<'select' | 'draw' | 'pan'>('draw')
  const [label, setLabel] = useState<LayoutLabel>('object')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawing, setDrawing] = useState<{ start: [number, number]; current: [number, number] } | null>(null)
  const [drag, setDrag] = useState<DragState>(null)
  const [compiled, setCompiled] = useState<CompileResult | null>(null)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [segmentsOpen, setSegmentsOpen] = useState(false)
  const [gbcOpen, setGbcOpen] = useState(false)
  const [gbcTab, setGbcTab] = useState<'run' | 'manage'>('run')
  const [gbcPending, setGbcPending] = useState<{ result: GbcRunResult; image?: GbcImageResult } | null>(null)
  const [layoutReset, setLayoutReset] = useState<'clear' | 'example' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [activeTool, setActiveTool] = useState<ToolId>('layout')
  const [leftWidth, setLeftWidth] = useState(320)
  const [rightWidth, setRightWidth] = useState(340)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [tabOrder, setTabOrder] = useState<string[]>([])
  const [draftTab, setDraftTab] = useState<DraftTabSnapshot | null>(null)
  const [dragTab, setDragTab] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const panRef = useRef<{ pointerId: number; buttons: number; x: number; y: number; ox: number; oy: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    window.addEventListener('blur', endPan)
    return () => window.removeEventListener('blur', endPan)
  }, [])
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (panRef.current) return
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0012))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoom, pan])
  const [steps, setSteps] = useState(env?.recommendation.steps ?? 8)
  const [cfg, setCfg] = useState(env?.recommendation.profile === 'dmd8' ? 1 : 3)
  const [seed, setSeed] = useState(42)
  const [modelBundleId, setModelBundleId] = useState(() => localStorage.getItem('mossstudio.modelBundleId') ?? '')
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('mossstudio.deviceId') ?? '')
  const modelBundle = catalog?.bundles.find((bundle) => bundle.id === modelBundleId) ?? null
  const modelBinding = modelBundle ? { bundleId: modelBundle.id, ...modelBundle.components } : undefined
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('未命名 Project')
  const [seriesId, setSeriesId] = useState('')
  const [page, setPage] = useState(1)
  const [projectSaving, setProjectSaving] = useState(false)
  const [backend, setBackend] = useState<BackendInfo | null>(null)
  const lastSaved = useRef('')
  const skipAutosave = useRef(false)
  const snapshot = useMemo(
    () => projectSnapshot({ name: projectName, draft, prompt, negative, seed, steps, cfg, modelBundleId, deviceId, backgroundPath: background?.path, seriesId, page }),
    [projectName, draft, prompt, negative, seed, steps, cfg, modelBundleId, deviceId, background?.path, seriesId, page],
  )
  const canvasRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (storedPrompt) setPrompt(storedPrompt)
  }, [storedPrompt])

  useEffect(() => {
    if (modelBundleId || !catalog?.bundles.length) return
    const next = catalog.bundles.find((bundle) => bundle.recommended) ?? catalog.bundles[0]
    setModelBundleId(next.id)
    localStorage.setItem('mossstudio.modelBundleId', next.id)
  }, [catalog, modelBundleId])
  useEffect(() => {
    if (!engineHostId) return
    const host = hosts.find((item) => item.id === engineHostId)
    if (host?.modelPath) setRemoteModelPath(host.modelPath)
  }, [engineHostId, hosts])
  useEffect(() => {
    if (deviceId || !devices.length) return
    const next = devices.find((device) => device.kind === 'cuda') ?? devices[0]
    setDeviceId(next.id)
    localStorage.setItem('mossstudio.deviceId', next.id)
  }, [devices, deviceId])

  useEffect(() => {
    if (storedDraft) setDraft(storedDraft)
  }, [storedDraft])

  useEffect(() => {
    void electronStudioClient.listProjects().then(setProjects).catch(() => undefined)
    void electronStudioClient.backendInfo().then(setBackend).catch(() => setBackend(null))
  }, [])

  useEffect(() => {
    if (!projectId || snapshot === lastSaved.current || skipAutosave.current) return
    const timer = setTimeout(() => {
      void saveProjectNow(true)
    }, 1200)
    return () => clearTimeout(timer)
  }, [projectId, snapshot])

  const selected = draft.items.find((item) => item.id === selectedId) ?? null
  const layerRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const focusLayerRef = useRef(false)
  useEffect(() => {
    if (!selectedId) return
    setActiveTool('layout')
    const element = layerRefs.current[selectedId]
    if (!element) return
    element.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    if (focusLayerRef.current) {
      focusLayerRef.current = false
      requestAnimationFrame(() => element.querySelector('textarea')?.focus())
    }
  }, [selectedId, draft.items.length])
  const seriesProjects = seriesId
    ? projects.filter((item) => item.seriesId === seriesId).sort((a, b) => (a.page ?? 1) - (b.page ?? 1))
    : []
  const nextSeriesPage = seriesProjects.find((item) => (item.page ?? 1) === page + 1)
  const previousSeriesPage = seriesProjects.find((item) => (item.page ?? 1) === page - 1)

  function toDraftPoint(event: React.PointerEvent): [number, number] {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return [0, 0]
    return [
      Math.round(((event.clientX - rect.left) / rect.width) * draft.width),
      Math.round(((event.clientY - rect.top) / rect.height) * draft.height),
    ]
  }

  function handlePointerDown(event: React.PointerEvent): void {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('textarea, input, select, button')) return
    const resizeId = target.dataset.resizeId
    const boxId = target.closest<HTMLElement>('[data-box-id]')?.dataset.boxId
    canvasRef.current?.setPointerCapture(event.pointerId)
    const [x, y] = toDraftPoint(event)

    if (resizeId) {
      const item = draft.items.find((entry) => entry.id === resizeId)
      if (item) {
        setSelectedId(item.id)
        if (item.locked) return
        setDrag({ kind: 'resize', id: item.id, startX: x, startY: y, origin: [...item.bbox] })
      }
      return
    }
    if (boxId) {
      const item = draft.items.find((entry) => entry.id === boxId)
      if (item) {
        setSelectedId(item.id)
        if (item.locked) return
        setDrag({ kind: 'move', id: item.id, startX: x, startY: y, origin: [...item.bbox] })
      }
      return
    }
    setSelectedId(null)
    if (tool === 'draw') {
      const point: [number, number] = [x, y]
      setDrawing({ start: point, current: point })
    }
  }

  function updateItem(id: string, bbox: [number, number, number, number]): void {
    setDraft((previous) => ({
      ...previous,
      items: previous.items.map((item) => (item.id === id ? { ...item, bbox } : item)),
    }))
  }

  function handlePointerMove(event: React.PointerEvent): void {
    if (!drawing && !drag) return
    const [x, y] = toDraftPoint(event)
    if (drawing) {
      setDrawing({ start: drawing.start, current: [x, y] })
      return
    }
    if (drag) {
      const dx = x - drag.startX
      const dy = y - drag.startY
      const [x1, y1, x2, y2] = drag.origin
      if (drag.kind === 'move') {
        const width = x2 - x1
        const height = y2 - y1
        const left = Math.max(0, Math.min(draft.width - width, x1 + dx))
        const top = Math.max(0, Math.min(draft.height - height, y1 + dy))
        updateItem(drag.id, [left, top, left + width, top + height])
      } else {
        updateItem(drag.id, [
          x1,
          y1,
          Math.max(x1 + 8, Math.min(draft.width, x2 + dx)),
          Math.max(y1 + 8, Math.min(draft.height, y2 + dy)),
        ])
      }
    }
  }

  function handlePointerUp(): void {
    if (drawing) {
      const [x1, y1] = drawing.start
      const [x2, y2] = drawing.current
      const box = clampBox([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)], draft.width, draft.height)
      if (box[2] - box[0] >= 12 && box[3] - box[1] >= 12) {
        const item = {
          id: crypto.randomUUID(),
          label,
          caption: '',
          text: label === 'text' ? '' : undefined,
          bbox: box,
        }
        setDraft((previous) => ({ ...previous, items: [...previous.items, item] }))
        setSelectedId(item.id)
        setTool('select')
      }
      setDrawing(null)
    }
    setDrag(null)
  }

  function changeSize(width: number, height: number): void {
    setDraft((previous) => ({
      ...previous,
      width,
      height,
      items: previous.items.map((item) => ({ ...item, bbox: clampBox(item.bbox, width, height) })),
    }))
  }

  function setItem(id: string, patch: Partial<LayoutDraft['items'][number]>): void {
    setDraft((previous) => ({
      ...previous,
      items: previous.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }))
  }

  function removeItem(id: string): void {
    setDraft((previous) => ({ ...previous, items: previous.items.filter((item) => item.id !== id) }))
    if (selectedId === id) setSelectedId(null)
  }

  function compile(): void {
    const result = compileLayout(draft)
    if (!result.ok) {
      toast.push(result.errors[0] ?? '布局不完整', 'error')
      return
    }
    setCompiled(result)
    setJsonOpen(true)
  }

  function insertPrompt(): void {
    if (!compiled || !compiled.ok) return
    const next = prompt.trim() ? `${prompt.trim()}\n\n${compiled.prompt}` : compiled.prompt
    setPrompt(next)
    setStudioPrompt(next)
    setJsonOpen(false)
    toast.push('布局 Prompt 已插入', 'success')
  }

  function resetLayout(action: 'clear' | 'example'): void {
    setDraft(action === 'example' ? exampleDraft() : createDraft(draft.width, draft.height))
    setSelectedId(null)
    setLayoutReset(null)
  }

  function requestLayoutReset(action: 'clear' | 'example'): void {
    if (draft.items.length) setLayoutReset(action)
    else resetLayout(action)
  }

  async function saveProjectNow(auto = false): Promise<void> {
    if (projectSaving) return
    setProjectSaving(true)
    try {
      const saved = await electronStudioClient.saveProject({
        id: projectId ?? undefined,
        name: projectName.trim() || '未命名 Project',
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
        modelBundleId: modelBundleId || undefined,
        deviceId: deviceId || undefined,
        backgroundPath: background?.path,
        seriesId: seriesId || undefined,
        page,
      })
      setProjectId(saved.id)
      setDraftTab(null)
      setProjectName(saved.name)
      lastSaved.current = projectSnapshot({
        name: saved.name, draft, prompt, negative, seed, steps, cfg, modelBundleId, deviceId,
        backgroundPath: background?.path, seriesId, page,
      })
      setProjects(await electronStudioClient.listProjects())
      if (!auto) toast.push('Project 已保存', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setProjectSaving(false)
    }
  }

  function captureDraftTab(): void {
    if (projectId) return
    setDraftTab({
      name: projectName.trim() || '未命名画布',
      draft,
      prompt,
      negative,
      seed,
      steps,
      cfg,
      modelBundleId,
      deviceId,
      seriesId,
      page,
      background,
    })
  }

  function restoreDraftTab(): void {
    if (!draftTab) return
    skipAutosave.current = true
    setProjectId(null)
    setProjectName(draftTab.name)
    setSeriesId(draftTab.seriesId)
    setPage(draftTab.page)
    setPrompt(draftTab.prompt)
    setStudioPrompt(draftTab.prompt)
    setNegative(draftTab.negative)
    setDraft(draftTab.draft)
    setStudioDraft(draftTab.draft)
    setSeed(draftTab.seed)
    setSteps(draftTab.steps)
    setCfg(draftTab.cfg)
    setModelBundleId(draftTab.modelBundleId)
    setDeviceId(draftTab.deviceId)
    setStudioBackground(draftTab.background)
    setSelectedId(null)
    lastSaved.current = ''
    setTimeout(() => { skipAutosave.current = false }, 300)
  }

  async function openProject(id: string): Promise<void> {
    captureDraftTab()
    try {
      const project = await electronStudioClient.getProject(id)
      if (!project) return
      const nextDraft = draftFromProject(project)
      skipAutosave.current = true
      setProjectId(project.id)
      setProjectName(project.name)
      setSeriesId(project.seriesId ?? '')
      setPage(project.page ?? 1)
      setPrompt(project.prompt)
      setStudioPrompt(project.prompt)
      setNegative(project.negative)
      setDraft(nextDraft)
      setStudioDraft(nextDraft)
      setSeed(project.seed)
      setSteps(project.steps)
      setCfg(project.cfg)
      if (project.modelBundleId) setModelBundleId(project.modelBundleId)
      if (project.deviceId) setDeviceId(project.deviceId)
      if (project.backgroundPath) {
        const path = project.backgroundPath
        setStudioBackground({ id: `project-bg-${project.id}`, path, name: path.split('/').pop() ?? 'background', dir: path.slice(0, Math.max(0, path.lastIndexOf('/'))), root: '', size: 0, mtime: 0, ext: path.split('.').pop() ?? '' })
      } else {
        setStudioBackground(null)
      }
      lastSaved.current = projectSnapshot({
        name: project.name, draft: nextDraft, prompt: project.prompt, negative: project.negative,
        seed: project.seed, steps: project.steps, cfg: project.cfg, modelBundleId: project.modelBundleId ?? modelBundleId, deviceId: project.deviceId ?? deviceId,
        backgroundPath: project.backgroundPath, seriesId: project.seriesId ?? '', page: project.page ?? 1,
      })
      setTimeout(() => { skipAutosave.current = false }, 600)
      toast.push('Project 已打开', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  function newProject(): void {
    setDraftTab(null)
    setProjectId(null)
    setProjectName('未命名 Project')
    setSeriesId('')
    setPage(1)
    setPrompt('')
    setStudioPrompt('')
    const draft = createDraft(1024, 1024)
    setDraft(draft)
    setStudioDraft(draft)
    setSelectedId(null)
    lastSaved.current = ''
  }

  async function newPage(): Promise<void> {
    const nextSeries = seriesId || `series-${crypto.randomUUID().slice(0, 8)}`
    setProjectSaving(true)
    try {
      const saved = await electronStudioClient.saveProject({
        name: `${projectName.replace(/ · 第\d+页$/, '')} · 第${page + 1}页`,
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
        prompt, negative, seed, steps, cfg,
        modelBundleId: modelBundleId || undefined,
        deviceId: deviceId || undefined,
        backgroundPath: background?.path,
        seriesId: nextSeries,
        page: page + 1,
      })
      setProjects(await electronStudioClient.listProjects())
      await openProject(saved.id)
      toast.push(`已创建系列第 ${saved.page ?? page + 1} 页`, 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setProjectSaving(false)
    }
  }

  function applyGbcImport(result: GbcRunResult, image: GbcImageResult | undefined, mode: 'append' | 'overwrite'): void {
    const items = result.vertices.flatMap((vertex) => {
      if (!vertex.bbox) return []
      const caption = vertex.descs?.find((desc) => desc.text)?.text?.trim() ?? ''
      const label: LayoutLabel = /\b(girl|boy|woman|man|person|character)\b/i.test(caption) ? 'character' : 'object'
      const bbox = clampBox([
        Math.round(vertex.bbox.left * draft.width),
        Math.round(vertex.bbox.top * draft.height),
        Math.round(vertex.bbox.right * draft.width),
        Math.round(vertex.bbox.bottom * draft.height),
      ], draft.width, draft.height)
      return [{
        id: crypto.randomUUID(),
        label,
        caption: caption || 'GBC 区域',
        bbox,
        visible: true,
        locked: false,
        opacity: 1,
      }]
    })
    setDraft((previous) => ({
      ...previous,
      summary: { ...previous.summary, caption: previous.summary.caption || result.summary },
      items: mode === 'overwrite' ? items : [...previous.items, ...items],
    }))
    if (mode === 'overwrite') setSelectedId(null)
    toast.push(`已写入 ${items.length} 个 GBC 区域${image ? `（${image.name}）` : ''}`, 'success')
  }

  function requestGbcImport(result: GbcRunResult, image?: GbcImageResult): void {
    if (draft.items.length > 0) {
      setGbcPending({ result, image })
      return
    }
    applyGbcImport(result, image, 'append')
  }

  async function generate(): Promise<void> {
    if (submittingRef.current) return
    if (!modelBinding) {
      toast.push('先在模型库准备一个完整模型', 'error')
      return
    }
    if (engineHostId && !remoteModelPath.trim()) {
      toast.push('选择远端引擎后需要填写远端模型路径', 'error')
      return
    }
    if (!prompt.trim()) {
      toast.push('先写提示词或插入布局 Prompt', 'error')
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    try {
      let info = backend
      if (!info?.ready) {
        info = await electronStudioClient.backendInfo().catch(() => null)
        setBackend(info)
      }
      if (!info?.ready || !info.url || !info.token) {
        toast.push(info?.error ?? 'Clover 后端尚未就绪；请稍后重试', 'error')
        return
      }
      const response = await fetch(`${info.url}/api/engine-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
        body: JSON.stringify({
          modelBinding,
          modelName: modelBundle?.name,
          deviceId: deviceId || undefined,
          hostId: engineHostId || undefined,
          remoteModelPath: engineHostId ? remoteModelPath.trim() : undefined,
          prompt,
          negativePrompt: negative,
          width: draft.width,
          height: draft.height,
          steps,
          cfg,
          seed,
          profile: steps <= 8 ? 'dmd8' : 'base',
          mode: 'runner',
        }),
      })
      const body = (await response.json()) as JobRecord | { error?: string }
      if (!response.ok || 'error' in body) {
        const raw = 'error' in body ? body.error : undefined
        const message = typeof raw === 'string' ? raw : raw?.message ?? `后端返回 ${response.status}`
        throw new Error(message)
      }
      toast.push('已提交到 MossInfer，正在终端运行', 'success')
      openWindow('terminal')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const orderedProjects = [
    ...tabOrder.map((id) => projects.find((item) => item.id === id)).filter(Boolean),
    ...projects.filter((item) => !tabOrder.includes(item.id)),
  ] as ProjectSummary[]
  useEffect(() => {
    setTabOrder((previous) => [...previous.filter((id) => projects.some((item) => item.id === id)), ...projects.map((item) => item.id).filter((id) => !previous.includes(id))])
  }, [projects])
  function zoomAt(clientX: number, clientY: number, factor: number): void {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) return
    const nextZoom = Math.min(2.5, Math.max(0.3, zoom * factor))
    if (nextZoom === zoom) return
    const dx = clientX - rect.left - rect.width / 2
    const dy = clientY - rect.top - rect.height / 2
    const ratio = nextZoom / zoom
    setPan({ x: dx - (dx - pan.x) * ratio, y: dy - (dy - pan.y) * ratio })
    setZoom(nextZoom)
  }
  function resetView(): void {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  function pickUpPan(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 1 && !(tool === 'pan' && event.button === 0)) return
    if (panRef.current || drawing || drag) return
    // Capture before canvas layers and their text fields can handle this gesture.
    event.preventDefault()
    event.stopPropagation()
    panRef.current = { pointerId: event.pointerId, buttons: event.button === 1 ? 4 : 1, x: event.clientX, y: event.clientY, ox: pan.x, oy: pan.y }
    setIsPanning(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function movePan(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = panRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (!(event.buttons & gesture.buttons)) {
      endPan()
      return
    }
    setPan({ x: gesture.ox + event.clientX - gesture.x, y: gesture.oy + event.clientY - gesture.y })
  }
  function finishPan(event: React.PointerEvent<HTMLDivElement>): void {
    if (panRef.current?.pointerId !== event.pointerId) return
    event.stopPropagation()
    endPan()
  }
  function endPan(): void {
    const gesture = panRef.current
    if (!gesture) return
    panRef.current = null
    setIsPanning(false)
    const viewport = viewportRef.current
    if (viewport?.hasPointerCapture(gesture.pointerId)) viewport.releasePointerCapture(gesture.pointerId)
  }
  function renderSection(id: SectionId): React.JSX.Element {
    if (id === 'prompt') return (
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between">
          <span className="text-caption text-[var(--color-text-tertiary)]">{prompt.length} 字符</span>
          <button type="button" onClick={() => setSegmentsOpen(true)} className="text-caption text-accent-300 hover:underline">分段 / 确认</button>
        </div>
        <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述画面、文字、风格与布局。" className="h-36 w-full resize-none leading-5" />
        <label className="block text-caption text-[var(--color-text-tertiary)]">负面提示词</label>
        <Input value={negative} onChange={(event) => setNegative(event.target.value)} className="w-full" />
      </div>
    )
    if (id === 'sampler') return (
      <div className="space-y-2.5 p-3">
        <div className="flex flex-wrap gap-1">
          {SIZE_PRESETS.map(([name, width, height]) => (
            <button key={name} type="button" onClick={() => changeSize(width, height)} className={cn('rounded-full border px-2 py-0.5 text-caption', draft.width === width && draft.height === height ? 'border-accent-500/40 bg-accent-500/12 text-accent-200' : 'border-[var(--color-border)] text-[var(--color-text-secondary)]')}>{name}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">宽度</span><Input type="number" min={256} max={2048} step={16} value={draft.width} onChange={(event) => changeSize(Number(event.target.value) || draft.width, draft.height)} /></label>
          <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">高度</span><Input type="number" min={256} max={2048} step={16} value={draft.height} onChange={(event) => changeSize(draft.width, Number(event.target.value) || draft.height)} /></label>
        </div>
        <div className="flex items-center justify-between"><span className="text-caption">步数</span><Segmented label="采样步数" value={String(steps)} onChange={(value) => setSteps(Number(value))} options={[{ value: '8', label: '8 DMD' }, { value: '20', label: '20' }, { value: '50', label: '50' }]} /></div>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">CFG</span><Input type="number" min={0} max={20} step={0.5} value={cfg} onChange={(event) => setCfg(Number(event.target.value))} /></label>
          <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">Seed</span><Input type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label>
        </div>
        <label className="block space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">模型</span><Select value={modelBundleId} onChange={(event) => { setModelBundleId(event.target.value); localStorage.setItem('mossstudio.modelBundleId', event.target.value) }} className="w-full">{catalog?.bundles.map((bundle) => <option key={bundle.id} value={bundle.id}>{bundle.name}</option>)}</Select></label>
        <label className="block space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">设备</span><Select value={deviceId} onChange={(event) => { setDeviceId(event.target.value); localStorage.setItem('mossstudio.deviceId', event.target.value) }} className="w-full">{devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.kind.toUpperCase()}</option>)}</Select></label>
        <label className="block space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">引擎</span><Select value={engineHostId} onChange={(event) => setEngineHostId(event.target.value)} className="w-full"><option value="">本机 MossInfer</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name} · 远端</option>)}</Select></label>
        {engineHostId ? <label className="block space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">远端模型路径</span><Input value={remoteModelPath} onChange={(event) => setRemoteModelPath(event.target.value)} placeholder="~/.mossstudio/models/..." className="w-full" /></label> : null}
      </div>
    )
    if (id === 'summary') return (
      <div className="space-y-2 p-3">
        <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">整体描述</span><Textarea value={draft.summary.caption} onChange={(event) => setDraft((previous) => ({ ...previous, summary: { ...previous.summary, caption: event.target.value } }))} placeholder="一句话描述整张图。" className="h-16 w-full resize-none" /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">meta</span><Input value={draft.summary.meta.join(', ')} onChange={(event) => setDraft((previous) => ({ ...previous, summary: { ...previous.summary, meta: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) } }))} className="w-full" /></label>
          <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">canvas</span><Select value={draft.summary.canvas} onChange={(event) => setDraft((previous) => ({ ...previous, summary: { ...previous.summary, canvas: event.target.value as LayoutDraft['summary']['canvas'] } }))} className="w-full"><option value="single">single</option><option value="multi_panel">multi_panel</option><option value="collage">collage</option></Select></label>
        </div>
        <Button tone="secondary" className="w-full" onClick={compile}><SquareDashedMousePointer className="size-4" /> 编译布局 Prompt</Button>
      </div>
    )
    if (id === 'gallery') return <MiniGallery />
    return (
      <div className="flex flex-col">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] px-2 py-1.5">
          <span className="text-caption text-[var(--color-text-tertiary)]">{draft.items.length} 个图层</span>
          <Button tone="ghost" onClick={() => { setTool('draw'); setSelectedId(null) }}><Plus className="size-4" /> 画新框</Button>
        </div>
        <div className="divide-y divide-[var(--color-border-subtle)]">
          {draft.items.map((item, index) => {
            const isSelected = item.id === selectedId
            const meta = LABEL_META[item.label]
            return (
              <div
                key={item.id}
                ref={(element) => { layerRefs.current[item.id] = element }}
                data-layer-id={item.id}
                tabIndex={-1}
                onClick={() => { focusLayerRef.current = true; setSelectedId(item.id) }}
                className={cn(
                  'overflow-hidden transition-colors',
                  isSelected ? 'bg-accent-500/[0.07]' : 'hover:bg-white/[0.025]',
                )}
              >
                <div className="flex items-start gap-1.5 px-2 py-1.5">
                  <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-accent-500/12 font-mono text-micro text-accent-200">{index + 1}</span>
                  <span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ backgroundColor: item.label === 'text' ? '#f0b45a' : item.label === 'character' ? '#7fb6ff' : '#8bd1c7' }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-caption font-medium">{meta.name}</span>
                      {item.visible === false ? <EyeOff className="size-2.5 text-[var(--color-text-tertiary)]" /> : null}
                      {item.locked ? <Lock className="size-2.5 text-[var(--color-text-tertiary)]" /> : null}
                    </div>
                    <p className="mt-0.5 truncate text-caption text-[var(--color-text-tertiary)]">{item.caption || '未填写提示词'}</p>
                  </div>
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); setItem(item.id, { visible: item.visible === false }) }}
                    className="mt-0.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]"
                    title={item.visible === false ? '显示图层' : '隐藏图层'}
                  >
                    {item.visible === false ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {isSelected ? (
                  <div className="space-y-2 border-t border-accent-500/20 p-2" onClick={(event) => event.stopPropagation()}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Select value={item.label} onChange={(event) => setItem(item.id, { label: event.target.value as LayoutLabel })} className="w-[90px]">
                        <option value="object">物体</option><option value="character">人物</option><option value="text">文字</option>
                      </Select>
                      <button type="button" onClick={() => setItem(item.id, { locked: !item.locked })} title={item.locked ? '解锁' : '锁定'}>{item.locked ? <Lock className="size-4" /> : <Unlock className="size-4" />}</button>
                      <span className="font-mono text-micro text-[var(--color-text-tertiary)]">{item.bbox.map((value) => Math.round(value)).join(',')}</span>
                      <button type="button" onClick={() => removeItem(item.id)} className="ml-auto text-[var(--color-text-tertiary)] hover:text-red-400"><X className="size-4" /></button>
                    </div>
                    <Textarea value={item.caption} onChange={(event) => setItem(item.id, { caption: event.target.value })} placeholder="区域提示词" className="h-20 w-full resize-none" />
                    {item.label === 'text' ? <Input value={item.text ?? ''} onChange={(event) => setItem(item.id, { text: event.target.value })} placeholder="图中文字" className="w-full border-amber-500/30" /> : null}
                    <label className="flex items-center gap-2 text-caption text-[var(--color-text-tertiary)]">不透明度<input type="range" min={0.1} max={1} step={0.05} value={item.opacity ?? 1} onChange={(event) => setItem(item.id, { opacity: Number(event.target.value) })} className="flex-1 accent-[var(--color-accent)]" /></label>
                  </div>
                ) : null}
              </div>
            )
          })}
          {draft.items.length === 0 ? <div className="rounded border border-dashed border-[var(--color-border)] px-2 py-6 text-center text-caption text-[var(--color-text-tertiary)]">用“画新框”在画布上拖出第一个区域</div> : null}
        </div>
      </div>
    )

  }

  return (
    <div className="studio-workbench flex h-full min-h-0 overflow-hidden">
      <StudioSidebar side="left" label="生成设置" width={leftWidth} collapsed={leftCollapsed} onExpand={() => setLeftCollapsed(false)} onWidthChange={setLeftWidth}>
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] pl-3 pr-1">
          <span className="text-ui text-[var(--color-text-secondary)]">生成设置</span>
          <IconButton label="收起左栏" data-sidebar-collapse aria-expanded={true} onClick={() => setLeftCollapsed(true)}><PanelLeftClose className="size-4" /></IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <StudioSection title="提示词">{renderSection('prompt')}</StudioSection>
          <StudioSection title="生成参数">{renderSection('sampler')}</StudioSection>
          <StudioSection title="图库">{renderSection('gallery')}</StudioSection>
        </div>
      </StudioSidebar>

      <section aria-label="画布" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {draftTab ? (
              <button
                type="button"
                onClick={restoreDraftTab}
                className={cn(
                  'flex h-8 max-w-[210px] shrink-0 items-center gap-1.5 rounded-t-[5px] border-b-2 px-2.5 text-ui transition',
                  !projectId ? 'border-accent-400 bg-white/[0.07] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-secondary)] hover:bg-white/[0.04]',
                )}
              >
                <span className="truncate">{draftTab.name}</span>
                <span className="shrink-0 text-micro text-amber-300">未保存</span>
              </button>
            ) : null}
            {orderedProjects.map((item) => {
              const current = item.id === projectId
              const status = current && projectSaving ? '保存中' : current ? '已保存' : '已保存'
              return (
                <button
                  key={item.id}
                  type="button"
                  draggable
                  onDragStart={() => setDragTab(item.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (!dragTab || dragTab === item.id) return
                    setTabOrder((previous) => {
                      const next = previous.filter((id) => id !== dragTab)
                      const at = next.indexOf(item.id)
                      next.splice(at < 0 ? next.length : at, 0, dragTab)
                      return next
                    })
                    setDragTab(null)
                  }}
                  onClick={() => { if (!current) void openProject(item.id) }}
                  className={cn(
                    'flex h-8 max-w-[210px] shrink-0 items-center gap-1.5 rounded-t-[5px] border-b-2 px-2.5 text-ui transition',
                    current ? 'border-accent-400 bg-white/[0.07] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-secondary)] hover:bg-white/[0.04]',
                  )}
                  title={item.name}
                >
                  <span className="truncate">{item.name || '未命名画布'}</span>
                  <span className={cn('shrink-0 text-micro', status === '保存中' ? 'text-amber-300' : 'text-[var(--color-text-tertiary)]')}>{status}</span>
                </button>
              )
            })}
            {!projectId && !draftTab ? (
              <div className="flex h-8 shrink-0 items-center gap-1.5 rounded-t-[5px] border-b-2 border-accent-400 bg-white/[0.07] px-2.5 text-ui">
                <span className="max-w-[180px] truncate">{projectName.trim() || '未命名画布'}</span>
                <span className="text-micro text-amber-300">未保存</span>
              </div>
            ) : null}
            {orderedProjects.length === 0 && projectId ? <span className="px-2 text-caption text-[var(--color-text-tertiary)]">还没有画布</span> : null}
          </div>
          <Button tone="secondary" onClick={newProject}><Plus className="size-4" /> 新建画布</Button>
          {env ? <Pill tone="blue">{env.recommendation.width}² · {env.recommendation.steps} 步</Pill> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2 py-1.5">
          <Segmented label="画布工具" value={tool} onChange={(value) => setTool(value as 'select' | 'draw' | 'pan')} options={[{ value: 'select', label: '选择' }, { value: 'draw', label: '画框' }, { value: 'pan', label: '手型' }]} />
          <Segmented value={label} onChange={(value) => setLabel(value as LayoutLabel)} options={[{ value: 'object', label: '物体' }, { value: 'character', label: '人物' }, { value: 'text', label: '文字' }]} />
          <IconButton label="示例布局" onClick={() => requestLayoutReset('example')}><Sparkles className="size-4" /></IconButton>
          <IconButton label="清空画布" onClick={() => requestLayoutReset('clear')} disabled={!draft.items.length}><Eraser className="size-4" /></IconButton>
          {background ? <IconButton label="清除底图" onClick={() => setStudioBackground(null)}><X className="size-4" /></IconButton> : null}
          <div className="ml-1 flex items-center gap-0.5 border-l border-[var(--color-border-subtle)] pl-1">
            <IconButton label="缩小画布" onClick={() => { const rect = viewportRef.current?.getBoundingClientRect(); if (rect) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 0.8) }}><Minus className="size-4" /></IconButton>
            <button type="button" onClick={resetView} className="w-11 text-center font-mono text-caption text-[var(--color-text-secondary)] hover:text-[var(--color-text)]" title="重置为 100%">{Math.round(zoom * 100)}%</button>
            <IconButton label="放大画布" onClick={() => { const rect = viewportRef.current?.getBoundingClientRect(); if (rect) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.25) }}><Plus className="size-4" /></IconButton>
            <IconButton label="恢复画布视图" onClick={resetView}><RotateCcw className="size-4" /></IconButton>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Pill tone={backend?.ready ? 'accent' : 'amber'}>{backend?.ready ? '后端就绪' : '后端启动中'}</Pill>
            <Button tone="primary" data-studio-generate disabled={submitting} aria-busy={submitting} onClick={() => void generate()}><span className="inline-flex items-center gap-1.5">{submitting ? '正在提交…' : '开始生成'} {submitting ? <Spinner /> : <ArrowRight className="size-4" />}</span></Button>
          </div>
        </div>

        <div
          ref={viewportRef}
          data-pan-tool={tool === 'pan'}
          data-panning={isPanning}
          className="studio-viewport relative min-h-0 flex-1 overflow-hidden bg-[#121419] [container-type:size]"
          onPointerDownCapture={pickUpPan}
          onPointerMoveCapture={movePan}
          onPointerUpCapture={finishPan}
          onPointerCancelCapture={finishPan}
          onLostPointerCapture={finishPan}
          onAuxClickCapture={(event) => { if (event.button === 1) event.preventDefault() }}
        >
          <div className="studio-canvas-content absolute inset-0 flex items-center justify-center p-4">
            <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} className="relative w-full max-w-[820px]">
                            <div
              ref={canvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              className={cn(
                'relative mx-auto select-none overflow-hidden rounded-[5px] border border-[var(--color-border)]',
                tool === 'draw' ? 'cursor-crosshair' : 'cursor-default',
              )}
              style={{
                aspectRatio: `${draft.width} / ${draft.height}`,
                width: `min(100%, calc((100cqh - 32px) * ${draft.width / draft.height}))`,
              }}
            >
              {background ? (
                <img
                  src={cloverUrl(background.path)}
                  alt={background.name}
                  className="absolute inset-0 size-full object-contain"
                  draggable={false}
                />
              ) : (
                <div className="absolute inset-0 bg-[linear-gradient(45deg,rgba(148,163,184,0.10)_25%,transparent_25%,transparent_75%,rgba(148,163,184,0.10)_75%),linear-gradient(45deg,rgba(148,163,184,0.10)_25%,transparent_25%,transparent_75%,rgba(148,163,184,0.10)_75%)] bg-[length:24px_24px] bg-[position:0_0,12px_12px]" />
              )}
              <div className="absolute inset-0 bg-gradient-to-br from-accent-500/[0.03] to-transparent" />

              {draft.items.filter((item) => item.visible !== false).map((item, index) => {
                const [x1, y1, x2, y2] = item.bbox
                const isSelected = item.id === selectedId
                const meta = LABEL_META[item.label]
                return (
                  <div
                    key={item.id}
                    data-box-id={item.id}
                    className={cn(
                      'absolute cursor-move rounded-[4px] border-2 transition-colors',
                      isSelected
                        ? 'border-accent-400 bg-accent-400/15'
                        : 'border-sky-400/80 bg-sky-400/10 hover:border-accent-400',
                    )}
                    style={{
                      left: `${(x1 / draft.width) * 100}%`,
                      top: `${(y1 / draft.height) * 100}%`,
                      width: `${((x2 - x1) / draft.width) * 100}%`,
                      height: `${((y2 - y1) / draft.height) * 100}%`,
                      opacity: item.opacity ?? 1,
                    }}
                  >
                    <span data-box-id={item.id} className="absolute -top-5 left-0 inline-flex max-w-full cursor-move items-center gap-1 truncate rounded bg-accent-600 px-1.5 py-0.5 text-caption font-medium text-white">
                      {index + 1} · {meta.name}
                    </span>
                    <div className="absolute inset-0 flex flex-col gap-1 p-1.5 pt-2">
                      <textarea
                        value={item.caption}
                        onPointerDown={(event) => { event.stopPropagation(); setSelectedId(item.id) }}
                        onChange={(event) => setItem(item.id, { caption: event.target.value })}
                        placeholder="在框内写区域提示词…"
                        className="min-h-0 flex-1 resize-none rounded border-0 bg-transparent p-0 text-caption leading-[15px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-tertiary)]/60"
                        style={{ cursor: 'text' }}
                      />
                      {item.label === 'text' ? (
                        <input
                          value={item.text ?? ''}
                          onPointerDown={(event) => { event.stopPropagation(); setSelectedId(item.id) }}
                          onChange={(event) => setItem(item.id, { text: event.target.value })}
                          placeholder="图中文字"
                          className="shrink-0 rounded border-0 bg-amber-500/15 px-1 py-0.5 text-caption text-amber-200 outline-none placeholder:text-amber-200/50"
                        />
                      ) : null}
                    </div>
                    {isSelected ? (
                      <span
                        data-resize-id={item.id}
                        className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-full border-2 border-white bg-accent-500 shadow"
                      />
                    ) : null}
                  </div>
                )
              })}

              {drawing ? (
                <div
                  className="pointer-events-none absolute rounded-[4px] border-2 border-dashed border-accent-400 bg-accent-400/15"
                  style={{
                    left: `${(Math.min(drawing.start[0], drawing.current[0]) / draft.width) * 100}%`,
                    top: `${(Math.min(drawing.start[1], drawing.current[1]) / draft.height) * 100}%`,
                    width: `${(Math.abs(drawing.current[0] - drawing.start[0]) / draft.width) * 100}%`,
                    height: `${(Math.abs(drawing.current[1] - drawing.start[1]) / draft.height) * 100}%`,
                  }}
                />
              ) : null}
            </div>
            </div>
          </div>
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-1 text-micro text-white/55">
            {Math.round(zoom * 100)}% · 滚轮缩放 · 手型/中键拖动
          </div>

        </div>
      </section>

      <StudioSidebar side="right" label="创作工具" width={rightWidth} collapsed={rightCollapsed} onExpand={() => setRightCollapsed(false)} onWidthChange={setRightWidth}>
        <header className="flex h-11 shrink-0 items-center border-b border-[var(--color-border-subtle)] pr-1">
          <div role="tablist" aria-label="创作工具" className="flex min-w-0 flex-1 self-stretch overflow-x-auto">
            {TOOL_TABS.map((tab, index) => (
              <button
                key={tab.id}
                id={`studio-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={activeTool === tab.id}
                aria-controls={`studio-tool-${tab.id}`}
                tabIndex={activeTool === tab.id ? 0 : -1}
                onClick={() => setActiveTool(tab.id)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? TOOL_TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TOOL_TABS.length) % TOOL_TABS.length
                  setActiveTool(TOOL_TABS[next].id)
                  document.getElementById(`studio-tab-${TOOL_TABS[next].id}`)?.focus()
                }}
                className={cn('studio-tool-tab shrink-0 border-b-2 px-3 text-ui transition-colors', activeTool === tab.id ? 'border-accent-400 text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]')}
              >{tab.label}</button>
            ))}
          </div>
          <IconButton label="收起右栏" data-sidebar-collapse aria-expanded={true} onClick={() => setRightCollapsed(true)}><PanelRightClose className="size-4" /></IconButton>
        </header>
        <div id="studio-tool-layout" role="tabpanel" aria-labelledby="studio-tab-layout" hidden={activeTool !== 'layout'} className="min-h-0 flex-1 overflow-y-auto">
          <StudioSection title="图层">{renderSection('layers')}</StudioSection>
          <StudioSection title="布局描述">{renderSection('summary')}</StudioSection>
        </div>
        <div id="studio-tool-agent" role="tabpanel" aria-labelledby="studio-tab-agent" hidden={activeTool !== 'agent'} className="min-h-0 flex-1 overflow-hidden">
          <AgentSidebar embedded />
        </div>
        <div id="studio-tool-analysis" role="tabpanel" aria-labelledby="studio-tab-analysis" hidden={activeTool !== 'analysis'} className="min-h-0 flex-1 overflow-y-auto">
          <StudioSection title="图像结构解析">
            <div className="space-y-3 p-3">
              <p className="text-caption leading-5 text-[var(--color-text-secondary)]">从参考图提取区域、文字和层级描述，导入当前画布继续编辑。</p>
              <Button tone="primary" className="w-full" onClick={() => { setGbcTab('run'); setGbcOpen(true) }}><ScanSearch className="size-4" />选择图片并解析</Button>
              <Button tone="ghost" className="w-full" onClick={() => { setGbcTab('manage'); setGbcOpen(true) }}><GitBranch className="size-4" />管理解析工具</Button>
              <p className="text-caption leading-5 text-[var(--color-text-tertiary)]">GBC 是可选工具，可随时在这里配置或打开。</p>
            </div>
          </StudioSection>
        </div>
      </StudioSidebar>
      <ConfirmDialog
        open={layoutReset !== null}
        onClose={() => setLayoutReset(null)}
        title={layoutReset === 'example' ? '替换为示例布局？' : '清空画布区域？'}
        description={`当前 ${draft.items.length} 个区域及区域内文字将被${layoutReset === 'example' ? '示例布局替换' : '清除'}。提示词和底图会保留。`}
        confirmLabel={layoutReset === 'example' ? '替换布局' : '清空区域'}
        onConfirm={() => { if (layoutReset) resetLayout(layoutReset) }}
      />

      <Modal
        open={jsonOpen}
        onClose={() => setJsonOpen(false)}
        title="编译后的布局 Prompt"
        description="模型需要的 abs_centralized + yxyx 格式，可直接粘贴到 Prompt 输入框。"
        width="max-w-3xl"
        footer={
          <>
            <Button tone="ghost" onClick={() => setJsonOpen(false)}>
              取消
            </Button>
            <Button
              tone="secondary"
              onClick={() => {
                if (!compiled) return
                void copyText(compiled.prompt, '布局 Prompt 已复制')
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <Copy className="size-4" /> 复制
              </span>
            </Button>
            <Button tone="primary" onClick={insertPrompt}>
              插入到 Prompt
            </Button>
          </>
        }
      >
        <pre className="max-h-[46vh] overflow-auto rounded-[6px] bg-white/55 p-3 font-mono text-ui leading-5 dark:bg-black/30">
          {compiled?.preview ?? ''}
        </pre>
        {compiled?.errors.length ? (
          <div className="mt-2 text-ui text-red-500">{compiled.errors.join('；')}</div>
        ) : null}
      </Modal>

      <GbcImportModal
        open={gbcOpen}
        initialTab={gbcTab}
        onClose={() => setGbcOpen(false)}
        onImport={requestGbcImport}
      />

      <Modal
        open={Boolean(gbcPending)}
        onClose={() => setGbcPending(null)}
        title="画布已有内容"
        description="GBC 写入区域前，请选择如何处理当前画布。"
        width="max-w-md"
        footer={
          <>
            <Button tone="ghost" onClick={() => setGbcPending(null)}>取消</Button>
            <Button tone="secondary" onClick={() => { if (gbcPending) { applyGbcImport(gbcPending.result, gbcPending.image, 'append'); setGbcPending(null) } }}>追加到现有图层</Button>
            <Button tone="danger" onClick={() => { if (gbcPending) { applyGbcImport(gbcPending.result, gbcPending.image, 'overwrite'); setGbcPending(null) } }}>覆盖当前图层</Button>
          </>
        }
      >
        <div className="p-4 text-ui leading-5 text-[var(--color-text-secondary)]">
          当前画布有 {draft.items.length} 个区域。追加会保留现有内容；覆盖会清空现有区域后写入本张 GBC 结果。
        </div>
      </Modal>

      <PromptSegmentsModal
        open={segmentsOpen}
        value={prompt}
        onClose={() => setSegmentsOpen(false)}
        onApply={(next) => {
          setPrompt(next)
          setStudioPrompt(next)
        }}
      />
    </div>
  )
}
