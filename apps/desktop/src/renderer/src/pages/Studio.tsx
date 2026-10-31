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
  CircleStop,
  Eraser,
  Play,
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
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GalleryItem, JobRecord, ManagedHost, ProjectCanvas, ProjectDocument, ProjectSummary } from '@shared/types'
import type { BackendInfo } from '@shared/backend'
import { Events, Ipc } from '@shared/channels'
import { call, onEvent } from '../lib/api'
import { electronStudioClient } from '../lib/studioClient'
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

/**
 * Board scale: one Canvas pixel maps to BOARD_UNIT board pixels, so a 512² Canvas
 * covers a quarter of the area of a 1024² one, and every Canvas can be dragged to
 * any position on the board instead of sitting in a grid cell.
 */
const BOARD_UNIT = 0.34
const BOARD_GAP = 28
const CARD_HEADER = 40
const SLOT_W = Math.round(1024 * BOARD_UNIT)
const SLOT_H = Math.round(1024 * BOARD_UNIT) + CARD_HEADER

function boardCardWidth(canvas: ProjectCanvas): number {
  return Math.round(canvas.width * BOARD_UNIT)
}
function boardCardBodyHeight(canvas: ProjectCanvas): number {
  return Math.round(canvas.height * BOARD_UNIT)
}
function boardCardHeight(canvas: ProjectCanvas): number {
  return boardCardBodyHeight(canvas) + CARD_HEADER
}
function boardCardPosition(canvas: ProjectCanvas): { x: number; y: number } {
  return { x: canvas.x, y: canvas.y }
}

const LABEL_META: Record<LayoutLabel, { name: string; color: string; icon: React.ReactNode }> = {  object: { name: '物体', color: 'accent', icon: <Box className="size-4" /> },
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

/** Board geometry in unscaled board coordinates, for the corner overview. */
interface MinimapState {
  width: number
  height: number
  cards: Array<{ id: string; x: number; y: number; width: number; height: number }>
  view: { x: number; y: number; width: number; height: number }
}

/** Result image with a readable fallback when the file on disk is gone. */
function ResultImage(props: { path: string; title: string; className?: string }): React.JSX.Element {
  const [unavailable, setUnavailable] = useState(false)
  if (unavailable) {
    return (
      <span className="flex size-full items-center justify-center px-2 text-center text-micro text-red-300">
        图片文件无法读取<br /><span className="break-all text-[var(--color-text-tertiary)]">{props.path}</span>
      </span>
    )
  }
  return (
    <img
      src={cloverUrl(props.path)}
      alt={props.title}
      className={props.className ?? 'size-full object-cover'}
      draggable={false}
      onError={() => setUnavailable(true)}
    />
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
  canvases: ProjectCanvas[]
  selectedCanvasId: string | null
}

type DragState =
  | { kind: 'move' | 'resize'; id: string; startX: number; startY: number; origin: [number, number, number, number] }
  | null

function isJobRecord(value: unknown): value is JobRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string'
    && typeof record['state'] === 'string'
    && ['queued', 'starting', 'running', 'succeeded', 'failed', 'canceled'].includes(record['state'])
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
  /** The transformed board element; its untransformed origin anchors all zoom math. */
  const boardRef = useRef<HTMLDivElement>(null)
  /** Latest board extent, readable from callbacks without re-subscribing. */
  const boardBoxRef = useRef({ width: SLOT_W + BOARD_GAP, height: SLOT_H + BOARD_GAP })
  /** Live pan/zoom mirrors so deferred callbacks never read a stale closure. */
  const panLiveRef = useRef(pan)
  const zoomLiveRef = useRef(zoom)
  panLiveRef.current = pan
  zoomLiveRef.current = zoom
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
  const [canvases, setCanvases] = useState<ProjectCanvas[]>([])
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null)
  const canvasCardRefs = useRef<Map<string, HTMLElement>>(new Map())
  /** Layout Canvas whose result is temporarily swapped back to the bbox editor. */
  const [editingCanvasId, setEditingCanvasId] = useState<string | null>(null)
  const [previewOutput, setPreviewOutput] = useState<{ canvas: ProjectCanvas; path: string } | null>(null)
  const cardDragRef = useRef<{ id: string; pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const cardDragMovedRef = useRef(false)
  /** Until this timestamp, a click that follows a drag must not re-centre the board. */
  const suppressFocusRef = useRef(0)
  const [dragCanvasId, setDragCanvasId] = useState<string | null>(null)
  const [minimap, setMinimap] = useState<MinimapState | null>(null)
  useEffect(() => {
    const grid = boardRef.current
    const viewport = viewportRef.current
    if (!grid || !viewport) {
      setMinimap(null)
      return
    }
    const rect = grid.getBoundingClientRect()
    const viewRect = viewport.getBoundingClientRect()
    const cards = [...canvasCardRefs.current.entries()].map(([id, element]) => {
      const cardRect = element.getBoundingClientRect()
      return {
        id,
        x: (cardRect.left - rect.left) / zoom,
        y: (cardRect.top - rect.top) / zoom,
        width: cardRect.width / zoom,
        height: cardRect.height / zoom,
      }
    })
    const view = {
      x: (viewRect.left - rect.left) / zoom,
      y: (viewRect.top - rect.top) / zoom,
      width: viewRect.width / zoom,
      height: viewRect.height / zoom,
    }
    const width = Math.max(grid.offsetWidth, view.x + view.width)
    const height = Math.max(grid.offsetHeight, view.y + view.height)
    if (!width || !height) {
      setMinimap(null)
      return
    }
    setMinimap({ width, height, cards, view })
  }, [pan.x, pan.y, zoom, canvases.length, selectedCanvasId])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('未命名 Project')
  const [seriesId, setSeriesId] = useState('')
  const [page, setPage] = useState(1)
  const [projectSaving, setProjectSaving] = useState(false)
  const [backend, setBackend] = useState<BackendInfo | null>(null)
  const lastSaved = useRef('')
  const skipAutosave = useRef(false)
  const jobs = useApp((state) => state.jobs)
  const cancelJob = useApp((state) => state.cancelJob)
  const selectedCanvas = canvases.find((canvas) => canvas.id === selectedCanvasId) ?? null
  // Fit the board once per opened project, as soon as its Canvases are on screen.
  const fitPendingRef = useRef(true)
  useEffect(() => { fitPendingRef.current = true }, [projectId])
  useEffect(() => {
    if (!fitPendingRef.current || canvases.length === 0) return
    fitPendingRef.current = false
    requestAnimationFrame(() => fitBoard())
  }, [canvases.length, projectId])
  const previewJob = previewOutput?.canvas.jobId
    ? jobs.find((item) => item.id === previewOutput.canvas.jobId)
    : undefined
  const currentCanvasSnapshot = useMemo<ProjectCanvas | null>(() => {
    if (!selectedCanvas || selectedCanvas.kind !== 'layout') return selectedCanvas
    return {
      ...selectedCanvas,
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
    }
  }, [selectedCanvas, draft, prompt, negative, seed, steps, cfg, modelBundleId, deviceId, background?.path])
  const persistedCanvases = useMemo(
    () => currentCanvasSnapshot
      ? canvases.map((canvas) => canvas.id === currentCanvasSnapshot.id ? currentCanvasSnapshot : canvas)
      : canvases,
    [canvases, currentCanvasSnapshot],
  )
  useEffect(() => {
    if (!jobs.length) return
    setCanvases((previous) => {
      let changed = false
      const next = previous.map((canvas) => {
        if (!canvas.jobId) return canvas
        const job = jobs.find((item) => item.id === canvas.jobId)
        if (!job) return canvas
        const outputs = job.outputs ?? canvas.outputs ?? []
        const outputChanged = outputs.length !== (canvas.outputs?.length ?? 0)
          || outputs.some((output, index) => output.path !== canvas.outputs?.[index]?.path)
        if (canvas.jobState === job.state && !outputChanged && canvas.error?.message === job.error?.message) return canvas
        changed = true
        return { ...canvas, jobState: job.state, outputs, error: job.error }
      })
      return changed ? next : previous
    })
  }, [jobs])
  const snapshot = useMemo(
    () => JSON.stringify({
      name: projectName,
      seriesId,
      page,
      canvases: persistedCanvases,
      selectedCanvasId,
    }),
    [projectName, seriesId, page, persistedCanvases, selectedCanvasId],
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
    if ((!projectId && persistedCanvases.length === 0) || snapshot === lastSaved.current || skipAutosave.current) return
    const timer = setTimeout(() => {
      void saveProjectNow(true)
    }, 1200)
    return () => clearTimeout(timer)
  }, [projectId, snapshot, persistedCanvases.length])

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

  function hydrateCanvas(canvas: ProjectCanvas): void {
    setSelectedCanvasId(canvas.id)
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
    setPrompt(canvas.prompt)
    setStudioPrompt(canvas.prompt)
    setNegative(canvas.negative)
    setSeed(canvas.seed)
    setSteps(canvas.steps)
    setCfg(canvas.cfg)
    setModelBundleId(canvas.modelBundleId ?? '')
    setDeviceId(canvas.deviceId ?? '')
    if (canvas.backgroundPath) {
      const path = canvas.backgroundPath
      setStudioBackground({
        id: `project-bg-${canvas.id}`,
        path,
        name: path.split(/[\\/]/).pop() ?? 'background',
        dir: path.slice(0, Math.max(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')))),
        root: '',
        size: 0,
        mtime: 0,
        ext: path.split('.').pop() ?? '',
      })
    } else {
      setStudioBackground(null)
    }
    setSelectedId(null)
  }

  /** First board position where a card of this pixel size does not overlap anything. */
  function nextFreeBoardSpot(width: number, height: number): { x: number; y: number } {
    const taken = canvases.map((item) => {
      const pos = boardCardPosition(item)
      return { x: pos.x, y: pos.y, w: boardCardWidth(item), h: boardCardHeight(item) }
    })
    const w = Math.round(width * BOARD_UNIT)
    const h = Math.round(height * BOARD_UNIT) + CARD_HEADER
    for (let row = 0; row < 200; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const candidate = { x: column * (SLOT_W + BOARD_GAP), y: row * (SLOT_H + BOARD_GAP) }
        const clash = taken.some((item) => candidate.x < item.x + item.w && candidate.x + w > item.x
          && candidate.y < item.y + item.h && candidate.y + h > item.y)
        if (!clash) return candidate
      }
    }
    return { x: 0, y: 0 }
  }

  function createLayoutCanvas(source?: ProjectCanvas): ProjectCanvas {
    const id = crypto.randomUUID()
    const nextDraft = source
      ? {
          width: source.width,
          height: source.height,
          summary: structuredClone(source.summary),
          items: source.layers.map((layer) => ({ ...layer, id: crypto.randomUUID(), label: layer.kind })),
        }
      : // A new Canvas inherits the size currently picked in the sampler panel.
        createDraft(draft.width, draft.height)
    const position = source
      ? { x: boardCardPosition(source).x + boardCardWidth(source) + BOARD_GAP, y: boardCardPosition(source).y }
      : nextFreeBoardSpot(nextDraft.width, nextDraft.height)
    // Number after the highest existing "Canvas N" so titles never collide.
    let highest = 0
    for (const item of canvases) {
      const match = /^Canvas (\d+)$/.exec(item.title)
      if (match) highest = Math.max(highest, Number(match[1]))
    }
    return {
      id,
      kind: 'layout',
      title: source ? `${source.title} · 复制` : `Canvas ${highest + 1}`,
      x: position.x,
      y: position.y,
      width: nextDraft.width,
      height: nextDraft.height,
      summary: nextDraft.summary,
      layers: nextDraft.items.map((item) => ({
        id: item.id,
        kind: item.label,
        caption: item.caption,
        text: item.text,
        bbox: item.bbox,
        visible: item.visible !== false,
        locked: item.locked === true,
        opacity: item.opacity ?? 1,
      })),
      prompt: source?.prompt ?? '',
      negative: source?.negative ?? negative,
      seed: source?.seed ?? seed,
      steps: source?.steps ?? steps,
      cfg: source?.cfg ?? cfg,
      modelBundleId: (source?.modelBundleId ?? modelBundleId) || undefined,
      deviceId: (source?.deviceId ?? deviceId) || undefined,
      backgroundPath: source?.backgroundPath,
    }
  }

  function addCanvas(source?: ProjectCanvas): void {
    const canvas = createLayoutCanvas(source)
    setCanvases((previous) => [...previous, canvas])
    hydrateCanvas(canvas)
    setTool('draw')
  }

  function selectCanvas(canvas: ProjectCanvas, options?: { focus?: boolean }): void {
    if (canvas.id !== selectedCanvasId) {
      setCanvases((previous) => currentCanvasSnapshot
        ? previous.map((item) => item.id === currentCanvasSnapshot.id ? currentCanvasSnapshot : item)
        : previous)
      hydrateCanvas(canvas)
    }
    if (options?.focus === false) return
    // Measure on the next frame: selecting swaps the card body for the editor, so the
    // pre-render rect no longer matches the height that is about to be centred.
    requestAnimationFrame(() => focusCanvasInViewport(canvas.id))
  }

  function beginCardDrag(event: React.PointerEvent<HTMLElement>, canvas: ProjectCanvas): void {
    if (event.button !== 0) return
    // Let the header buttons handle their own clicks.
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    event.stopPropagation()
    const position = boardCardPosition(canvas)
    cardDragRef.current = {
      id: canvas.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    }
    cardDragMovedRef.current = false
    setDragCanvasId(canvas.id)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveCardDrag(event: React.PointerEvent<HTMLElement>): void {
    const drag = cardDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    // Self-heal a missed pointerup: without a held button this is no longer a drag.
    if ((event.buttons & 1) === 0) {
      endCardDrag(event)
      return
    }
    event.stopPropagation()
    const dx = (event.clientX - drag.startX) / zoom
    const dy = (event.clientY - drag.startY) / zoom
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) cardDragMovedRef.current = true
    setCanvases((previous) => previous.map((item) => item.id === drag.id
      ? { ...item, x: Math.round(drag.originX + dx), y: Math.round(drag.originY + dy) }
      : item))
  }

  function endCardDrag(event: React.PointerEvent<HTMLElement>): void {
    const drag = cardDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    cardDragRef.current = null
    setDragCanvasId(null)
    // The browser still fires a click on the card after a drag; do not let that click
    // re-centre the board, or the card appears to fly away from where it was dropped.
    if (cardDragMovedRef.current) suppressFocusRef.current = performance.now() + 400
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  /** Focusing a Canvas centres it and lands on the 125% working zoom. */
  function focusCanvasInViewport(id: string): void {
    const card = canvasCardRefs.current.get(id)
    const viewport = viewportRef.current
    const origin = boardOrigin()
    if (!card || !viewport || !origin) {
      boardDebug('focus.skip', { id, hasCard: Boolean(card), hasViewport: Boolean(viewport), hasOrigin: Boolean(origin) })
      return
    }
    const view = viewport.getBoundingClientRect()
    const rect = card.getBoundingClientRect()
    const zoomNow = zoomLiveRef.current
    const panNow = panLiveRef.current
    const nextZoom = 1.25
    // Screen → board: subtract the origin AND the pan before dividing by zoom.
    const cx = (rect.left + rect.width / 2 - origin.x - panNow.x) / zoomNow
    const cy = (rect.top + rect.height / 2 - origin.y - panNow.y) / zoomNow
    const nextPan = {
      x: view.left + view.width / 2 - origin.x - nextZoom * cx,
      y: view.top + view.height / 2 - origin.y - nextZoom * cy,
    }
    boardDebug('focus.input', {
      id,
      card: { left: Math.round(rect.left), top: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      boardPoint: { cx: Math.round(cx), cy: Math.round(cy) },
      nextZoom,
      nextPan: { x: Math.round(nextPan.x), y: Math.round(nextPan.y) },
    })
    setZoom(nextZoom)
    setPan(nextPan)
    // Verify on a later frame: where did the card actually land?
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const element = canvasCardRefs.current.get(id)
      const viewRect = viewportRef.current?.getBoundingClientRect()
      if (!element || !viewRect) return
      const after = element.getBoundingClientRect()
      boardDebug('focus.result', {
        id,
        wantCentre: { x: Math.round(viewRect.left + viewRect.width / 2), y: Math.round(viewRect.top + viewRect.height / 2) },
        gotCentre: { x: Math.round(after.left + after.width / 2), y: Math.round(after.top + after.height / 2) },
        dx: Math.round(after.left + after.width / 2 - (viewRect.left + viewRect.width / 2)),
        dy: Math.round(after.top + after.height / 2 - (viewRect.top + viewRect.height / 2)),
        card: { left: Math.round(after.left), top: Math.round(after.top), w: Math.round(after.width), h: Math.round(after.height) },
      })
    }))
  }

  async function deleteCanvas(canvas: ProjectCanvas): Promise<void> {
    const job = canvas.jobId ? jobs.find((item) => item.id === canvas.jobId) : undefined
    const state = job?.state ?? canvas.jobState
    if (state === 'queued' || state === 'starting' || state === 'running') {
      toast.push('请先在终端取消该任务，再删除 Canvas', 'error')
      return
    }
    if (!window.confirm(`删除「${canvas.title}」？生成文件会保留在画廊中。`)) return
    const remaining = persistedCanvases.filter((item) => item.id !== canvas.id)
    setCanvases(remaining)
    if (selectedCanvasId === canvas.id) {
      const next = remaining.find((item) => item.kind === 'layout') ?? remaining[0]
      if (next) hydrateCanvas(next)
      else {
        setSelectedCanvasId(null)
        setDraft(createDraft(1024, 1024))
        setPrompt('')
        setStudioPrompt('')
        setNegative('')
        setSelectedId(null)
      }
    }
  }

  async function saveProjectNow(
    auto = false,
    boardSnapshot?: { canvases: ProjectCanvas[]; selectedCanvasId: string | null },
  ): Promise<ProjectDocument | null> {
    const canvasesToSave = boardSnapshot?.canvases ?? persistedCanvases
    const selectedIdToSave = boardSnapshot ? boardSnapshot.selectedCanvasId : selectedCanvasId
    if (projectSaving || (!projectId && canvasesToSave.length === 0)) return null
    setProjectSaving(true)
    try {
      const saved = await electronStudioClient.saveProject({
        id: projectId ?? undefined,
        name: projectName.trim() || '未命名 Project',
        canvases: canvasesToSave,
        selectedCanvasId: selectedIdToSave ?? undefined,
        seriesId: seriesId || undefined,
        page,
      })
      setProjectId(saved.id)
      setDraftTab(null)
      setProjectName(saved.name)
      setCanvases(saved.canvases)
      lastSaved.current = snapshot
      setProjects(await electronStudioClient.listProjects())
      if (!auto) toast.push('Project 已保存', 'success')
      return saved
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
      return null
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
      canvases: persistedCanvases,
      selectedCanvasId,
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
    setCanvases(draftTab.canvases)
    setSelectedCanvasId(draftTab.selectedCanvasId)
    setSelectedId(null)
    lastSaved.current = ''
    setTimeout(() => { skipAutosave.current = false }, 300)
  }

  async function openProject(id: string): Promise<void> {
    captureDraftTab()
    try {
      const project = await electronStudioClient.getProject(id)
      if (!project) return
      const nextCanvases = project.canvases ?? []
      const nextSelected = nextCanvases.find((canvas) => canvas.id === project.selectedCanvasId)
        ?? nextCanvases.find((canvas) => canvas.kind === 'layout')
        ?? nextCanvases[0]
      const nextDraft = nextSelected
        ? {
            width: nextSelected.width,
            height: nextSelected.height,
            summary: nextSelected.summary,
            items: nextSelected.layers.map((layer) => ({
              id: layer.id, label: layer.kind, caption: layer.caption, text: layer.text,
              bbox: layer.bbox, visible: layer.visible, locked: layer.locked, opacity: layer.opacity,
            })),
          }
        : createDraft(1024, 1024)
      skipAutosave.current = true
      setProjectId(project.id)
      setProjectName(project.name)
      setCanvases(nextCanvases)
      setSelectedCanvasId(nextSelected?.id ?? null)
      setSeriesId(project.seriesId ?? '')
      setPage(project.page ?? 1)
      setDraft(nextDraft)
      setStudioDraft(nextDraft)
      if (nextSelected) {
        setPrompt(nextSelected.prompt)
        setStudioPrompt(nextSelected.prompt)
        setNegative(nextSelected.negative)
        setSeed(nextSelected.seed)
        setSteps(nextSelected.steps)
        setCfg(nextSelected.cfg)
        setModelBundleId(nextSelected.modelBundleId ?? '')
        setDeviceId(nextSelected.deviceId ?? '')
        if (nextSelected.backgroundPath) {
          const path = nextSelected.backgroundPath
          setStudioBackground({ id: `project-bg-${nextSelected.id}`, path, name: path.split(/[\\/]/).pop() ?? 'background', dir: path.slice(0, Math.max(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')))), root: '', size: 0, mtime: 0, ext: path.split('.').pop() ?? '' })
        } else {
          setStudioBackground(null)
        }
      } else {
        setStudioBackground(null)
      }
      lastSaved.current = JSON.stringify({
        name: project.name,
        seriesId: project.seriesId ?? '',
        page: project.page ?? 1,
        canvases: nextCanvases,
        selectedCanvasId: nextSelected?.id ?? null,
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
    setCanvases([])
    setSelectedCanvasId(null)
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
      // A page is a project with a single layout Canvas that carries the current
      // sampler settings, prompt and layout.
      const canvas = createLayoutCanvas()
      const saved = await electronStudioClient.saveProject({
        name: `${projectName.replace(/ · 第\d+页$/, '')} · 第${page + 1}页`,
        canvases: [canvas],
        selectedCanvasId: canvas.id,
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

  async function generate(sourceOverride?: ProjectCanvas): Promise<void> {
    if (submittingRef.current) return
    const source = sourceOverride?.id === selectedCanvasId
      ? currentCanvasSnapshot ?? sourceOverride
      : sourceOverride ?? currentCanvasSnapshot
    if (!source) {
      toast.push('先点击选择一个 Canvas，再开始生成', 'error')
      return
    }
    const selectedBundle = source.modelBundleId
      ? catalog?.bundles.find((bundle) => bundle.id === source.modelBundleId)
      : modelBundle
    if (source.modelBundleId && !selectedBundle) {
      toast.push('此 Canvas 引用的模型已不可用；请复制参数到新 Canvas 并重新选择模型', 'error')
      return
    }
    const sourceBinding = selectedBundle ? { bundleId: selectedBundle.id, ...selectedBundle.components } : undefined
    if (!sourceBinding) {
      toast.push('先在模型库准备一个完整模型', 'error')
      return
    }
    if (engineHostId && !remoteModelPath.trim()) {
      toast.push('选择远端引擎后需要填写远端模型路径', 'error')
      return
    }
    if (!source.prompt.trim()) {
      toast.push('先写提示词或插入布局 Prompt', 'error')
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    let taskCanvasId: string | null = null
    let taskCanvases: ProjectCanvas[] | null = null
    try {
      const savedProject = await saveProjectNow(true)
      if (!savedProject) throw new Error('Project 尚未保存，请稍后重试')
      // A layout Canvas with no result yet renders its first run in place; re-runs
      // and already-finished Canvases spawn a result Canvas below, so history is
      // never overwritten.
      const runInPlace = source.kind === 'layout' && (source.outputs?.length ?? 0) === 0
      taskCanvasId = runInPlace ? source.id : crypto.randomUUID()
      if (runInPlace) {
        taskCanvases = persistedCanvases.map((item) => item.id === source.id
          ? { ...item, jobId: undefined, jobState: 'starting', progress: undefined, outputs: [], error: undefined }
          : item)
      } else {
        // Drop the result directly under its source Canvas and shift down while the
        // area is taken, so a board with several results never stacks them.
        const sourcePosition = boardCardPosition(source)
        const resultWidth = boardCardWidth(source)
        const resultHeight = boardCardHeight(source)
        const taken = persistedCanvases.map((item) => {
          const position = boardCardPosition(item)
          return { x: position.x, y: position.y, w: boardCardWidth(item), h: boardCardHeight(item) }
        })
        let y = sourcePosition.y + boardCardHeight(source) + BOARD_GAP
        for (let guard = 0; guard < 200; guard += 1) {
          const clash = taken.some((item) => sourcePosition.x < item.x + item.w && sourcePosition.x + resultWidth > item.x
            && y < item.y + item.h && y + resultHeight > item.y)
          if (!clash) break
          y += resultHeight + BOARD_GAP
        }
        const taskCanvas: ProjectCanvas = {
          ...source,
          id: taskCanvasId,
          kind: 'result',
          title: `生成 · ${source.title}`,
          x: sourcePosition.x,
          y,
          sourceCanvasId: source.id,
          jobId: undefined,
          jobState: 'starting',
          progress: undefined,
          outputs: [],
          error: undefined,
        }
        taskCanvases = [...persistedCanvases, taskCanvas]
      }
      setCanvases(taskCanvases)
      setSelectedCanvasId(taskCanvasId)
      const savedBoard = await saveProjectNow(true, { canvases: taskCanvases, selectedCanvasId: taskCanvasId })
      if (!savedBoard) throw new Error('任务 Canvas 保存失败，请稍后重试')
      let info = backend
      if (!info?.ready) {
        info = await electronStudioClient.backendInfo().catch(() => null)
        setBackend(info)
      }
      if (!info?.ready || !info.url || !info.token) {
        throw new Error(info?.error ?? 'Clover 后端尚未就绪；请稍后重试')
      }
      const response = await fetch(`${info.url}/api/engine-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
        body: JSON.stringify({
          projectId: savedBoard.id,
          canvasId: taskCanvasId,
          modelBinding: sourceBinding,
          modelName: selectedBundle?.name,
          deviceId: source.deviceId || undefined,
          hostId: engineHostId || undefined,
          remoteModelPath: engineHostId ? remoteModelPath.trim() : undefined,
          prompt: source.prompt,
          negativePrompt: source.negative,
          width: source.width,
          height: source.height,
          steps: source.steps,
          cfg: source.cfg,
          seed: source.seed,
          profile: source.steps <= 8 ? 'dmd8' : 'base',
          mode: 'runner',
        }),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        const raw = body && typeof body === 'object' && 'error' in body ? body.error : undefined
        const message = typeof raw === 'string'
          ? raw
          : raw && typeof raw === 'object' && 'message' in raw && typeof raw.message === 'string'
            ? raw.message
            : `后端返回 ${response.status}`
        throw new Error(message)
      }
      if (!isJobRecord(body)) throw new Error('后端返回了无效的任务记录')
      const observedJob = useApp.getState().jobs.find((job) => job.id === body.id)
      taskCanvases = taskCanvases.map((canvas) => canvas.id === taskCanvasId
        ? { ...canvas, jobId: body.id, jobState: observedJob?.state ?? body.state }
        : canvas)
      setCanvases(taskCanvases)
      setSelectedCanvasId(taskCanvasId)
      const linkedProject = await saveProjectNow(true, { canvases: taskCanvases, selectedCanvasId: taskCanvasId })
      if (linkedProject) {
        toast.push('已提交到 MossInfer，进度显示在对应 Canvas 上', 'success')
      } else {
        toast.push('任务已提交，但关联记录未能保存；可在终端查看任务', 'error')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (taskCanvasId) {
        taskCanvases = taskCanvases?.map((canvas) => canvas.id === taskCanvasId
          ? { ...canvas, jobState: 'failed', error: { code: 'E_SUBMIT', message } }
          : canvas) ?? null
        if (taskCanvases) {
          setCanvases(taskCanvases)
          await saveProjectNow(true, { canvases: taskCanvases, selectedCanvasId: taskCanvasId })
        }
      }
      toast.push(message, 'error')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const orderedProjects = [
    ...tabOrder.map((id) => projects.find((item) => item.id === id)).filter(Boolean),
    ...projects.filter((item) => !tabOrder.includes(item.id)),
  ] as ProjectSummary[]
  // Board bounds and the spot for the "新建内容" entry, both in board pixels.
  const boardBox = (() => {
    let right = SLOT_W
    let bottom = SLOT_H
    for (const canvas of persistedCanvases) {
      const position = boardCardPosition(canvas)
      right = Math.max(right, position.x + boardCardWidth(canvas))
      bottom = Math.max(bottom, position.y + boardCardHeight(canvas))
    }
    return { width: right + BOARD_GAP, height: bottom + BOARD_GAP }
  })()
  boardBoxRef.current = boardBox
  const nextBoardSpot = nextFreeBoardSpot(draft.width, draft.height)
  useEffect(() => {
    setTabOrder((previous) => [...previous.filter((id) => projects.some((item) => item.id === id)), ...projects.map((item) => item.id).filter((id) => !previous.includes(id))])
  }, [projects])
  /** Screen position of the board's untransformed origin (transform is translate → scale). */
  function boardOrigin(): { x: number; y: number } | null {
    const grid = boardRef.current
    if (!grid) return null
    const rect = grid.getBoundingClientRect()
    return { x: rect.left - panLiveRef.current.x, y: rect.top - panLiveRef.current.y }
  }

  /** TEMP diagnostics: one compact JSON line per interaction, read back from the dev log. */
  function boardDebug(tag: string, extra: Record<string, unknown> = {}): void {
    const grid = boardRef.current
    const viewport = viewportRef.current
    const content = grid?.closest('.studio-canvas-content') as HTMLElement | null
    const gridRect = grid?.getBoundingClientRect()
    const viewRect = viewport?.getBoundingClientRect()
    console.log('[board]', tag, JSON.stringify({
      zoom: Number(zoomLiveRef.current.toFixed(4)),
      pan: { x: Math.round(panLiveRef.current.x), y: Math.round(panLiveRef.current.y) },
      board: gridRect
        ? { left: Math.round(gridRect.left), top: Math.round(gridRect.top), w: Math.round(gridRect.width), h: Math.round(gridRect.height) }
        : null,
      view: viewRect
        ? { left: Math.round(viewRect.left), top: Math.round(viewRect.top), w: Math.round(viewRect.width), h: Math.round(viewRect.height) }
        : null,
      scroll: content ? { left: content.scrollLeft, top: content.scrollTop } : null,
      origin: gridRect
        ? { x: Math.round(gridRect.left - panLiveRef.current.x), y: Math.round(gridRect.top - panLiveRef.current.y) }
        : null,
      ...extra,
    }))
  }

  function zoomAt(clientX: number, clientY: number, factor: number): void {
    const origin = boardOrigin()
    if (!origin) return
    const zoomNow = zoomLiveRef.current
    const nextZoom = Math.min(2.5, Math.max(0.3, zoomNow * factor))
    if (nextZoom === zoomNow) return
    // Pin the board point under the cursor: pan' = m - (zoom' / zoom) * (m - pan),
    // where m is the cursor offset from the board origin in screen pixels.
    const ratio = nextZoom / zoomNow
    const mx = clientX - origin.x
    const my = clientY - origin.y
    const nextPan = { x: mx - (mx - panLiveRef.current.x) * ratio, y: my - (my - panLiveRef.current.y) * ratio }
    if (Math.abs(nextZoom - 1.05) < 0.06 || Math.abs(nextZoom - 1.25) < 0.06) {
      boardDebug('zoom.input', { clientX: Math.round(clientX), clientY: Math.round(clientY), ratio: Number(ratio.toFixed(3)), nextZoom, nextPan: { x: Math.round(nextPan.x), y: Math.round(nextPan.y) } })
    }
    setPan(nextPan)
    setZoom(nextZoom)
  }
  function resetView(): void {
    fitBoard()
  }

  /** Zoom/pan so the whole board fits the viewport; used on open and by 恢复视图. */
  function fitBoard(): void {
    const viewport = viewportRef.current
    const origin = boardOrigin()
    if (!viewport || !origin) return
    const view = viewport.getBoundingClientRect()
    const scale = Math.min(
      1,
      (view.width - 64) / Math.max(1, boardBoxRef.current.width),
      (view.height - 64) / Math.max(1, boardBoxRef.current.height),
    )
    const nextZoom = Math.min(2.5, Math.max(0.3, scale))
    setZoom(nextZoom)
    setPan({
      x: view.left + (view.width - boardBoxRef.current.width * nextZoom) / 2 - origin.x,
      y: view.top + (view.height - boardBoxRef.current.height * nextZoom) / 2 - origin.y,
    })
    boardDebug('fit.input', { boardBox: boardBoxRef.current, scale: Number(scale.toFixed(3)), nextZoom: Number(nextZoom.toFixed(3)) })
  }

  function pickUpPan(event: React.PointerEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement
    // Dragging the empty board with the left button pans it, the way a canvas
    // workbench behaves; a gesture that starts on a card keeps its own meaning.
    const onEmptyBoard = event.button === 0
      && !target.closest('[data-canvas-card]')
      && !target.closest('button')
    if (event.button !== 1 && !onEmptyBoard && !(tool === 'pan' && event.button === 0)) return
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
          {selectedCanvas?.kind === 'layout' ? (
            <>
              <StudioSection title="提示词">{renderSection('prompt')}</StudioSection>
              <StudioSection title="生成参数">{renderSection('sampler')}</StudioSection>
              <StudioSection title="图库">{renderSection('gallery')}</StudioSection>
            </>
          ) : selectedCanvas ? (
            <div className="space-y-3 px-4 py-5 text-caption text-[var(--color-text-secondary)]">
              <p className="font-medium text-[var(--color-text)]">本次生成参数（只读）</p>
              <p className="whitespace-pre-wrap break-words">{selectedCanvas.prompt || '（空提示词）'}</p>
              <dl className="grid grid-cols-2 gap-2 text-[var(--color-text-tertiary)]">
                <dt>尺寸</dt><dd>{selectedCanvas.width}×{selectedCanvas.height}</dd>
                <dt>步数</dt><dd>{selectedCanvas.steps}</dd>
                <dt>CFG</dt><dd>{selectedCanvas.cfg}</dd>
                <dt>Seed</dt><dd>{selectedCanvas.seed}</dd>
              </dl>
              <p>使用 Canvas 上的“重跑”按相同参数创建新结果，或复制参数创建可编辑 Canvas。</p>
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-caption leading-5 text-[var(--color-text-tertiary)]">
              请点击选择一个 Canvas，再编辑提示词和生成参数。
            </div>
          )}
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
          <Button tone="secondary" onClick={newProject}><Plus className="size-4" /> 新建 Project</Button>
          {env ? <Pill tone="blue">{env.recommendation.width}² · {env.recommendation.steps} 步</Pill> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2 py-1.5">
          <div
            inert={selectedCanvas?.kind !== 'layout'}
            aria-disabled={selectedCanvas?.kind !== 'layout'}
            className={cn('flex flex-wrap items-center gap-1.5', selectedCanvas?.kind !== 'layout' && 'pointer-events-none opacity-40')}
          >
            <Segmented label="画布工具" value={tool} onChange={(value) => setTool(value as 'select' | 'draw' | 'pan')} options={[{ value: 'select', label: '选择' }, { value: 'draw', label: '画框' }, { value: 'pan', label: '手型' }]} />
            <Segmented value={label} onChange={(value) => setLabel(value as LayoutLabel)} options={[{ value: 'object', label: '物体' }, { value: 'character', label: '人物' }, { value: 'text', label: '文字' }]} />
            <IconButton label="示例布局" onClick={() => requestLayoutReset('example')}><Sparkles className="size-4" /></IconButton>
            <IconButton label="清空画布" onClick={() => requestLayoutReset('clear')} disabled={!draft.items.length}><Eraser className="size-4" /></IconButton>
            {background ? <IconButton label="清除底图" onClick={() => setStudioBackground(null)}><X className="size-4" /></IconButton> : null}
          </div>
          <div className="ml-1 flex items-center gap-0.5 border-l border-[var(--color-border-subtle)] pl-1">
            <IconButton label="缩小画布" onClick={() => { const rect = viewportRef.current?.getBoundingClientRect(); if (rect) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 0.8) }}><Minus className="size-4" /></IconButton>
            <button type="button" onClick={resetView} className="w-11 text-center font-mono text-caption text-[var(--color-text-secondary)] hover:text-[var(--color-text)]" title="重置为 100%">{Math.round(zoom * 100)}%</button>
            <IconButton label="放大画布" onClick={() => { const rect = viewportRef.current?.getBoundingClientRect(); if (rect) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.25) }}><Plus className="size-4" /></IconButton>
            <IconButton label="恢复画布视图" onClick={resetView}><RotateCcw className="size-4" /></IconButton>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Pill tone={backend?.ready ? 'accent' : 'amber'}>{backend?.ready ? '后端就绪' : '后端启动中'}</Pill>
            <Button tone="primary" data-studio-generate disabled={submitting || projectSaving || selectedCanvas?.kind !== 'layout'} aria-busy={submitting} onClick={() => void generate()}><span className="inline-flex items-center gap-1.5">{submitting ? '正在提交…' : '开始生成'} {submitting ? <Spinner /> : <ArrowRight className="size-4" />}</span></Button>
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
          {/* Panning is done with the transform below, so no native scrolling here:
              a scrollable ancestor would shift the board origin under our zoom math. */}
          <div className="studio-canvas-content absolute inset-0 overflow-hidden p-5">
            {canvases.length === 0 ? (
              <button
                type="button"
                onClick={() => addCanvas()}
                className="flex min-h-[320px] w-full items-center justify-center rounded-lg border border-dashed border-accent-400/40 bg-white/[0.025] text-ui text-[var(--color-text-secondary)] transition hover:border-accent-300 hover:bg-accent-400/[0.06]"
              >
                <span className="flex flex-col items-center gap-2">
                  <Plus className="size-7 text-accent-300" />
                  <span className="font-medium">新建内容</span>
                  <span className="text-caption text-[var(--color-text-tertiary)]">创建第一个可编辑 Canvas</span>
                </span>
              </button>
            ) : (
              <div
                ref={boardRef}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: 'top left',
                  width: boardBox.width,
                  height: boardBox.height,
                }}
                className="relative"
              >
                {[...persistedCanvases].sort((a, b) => a.y - b.y || a.x - b.x).map((canvas) => {
                  const isActive = canvas.id === selectedCanvasId
                  const job = canvas.jobId ? jobs.find((item) => item.id === canvas.jobId) : undefined
                  const outputs = job?.outputs?.length ? job.outputs : canvas.outputs ?? []
                  const progress = job?.progress ?? canvas.progress
                  const activeTask = job && ['queued', 'starting', 'running'].includes(job.state)
                  const missingJob = Boolean(
                    canvas.jobId
                    && !job
                    && ['queued', 'starting', 'running'].includes(canvas.jobState ?? ''),
                  )
                  const queuePosition = job?.state === 'queued'
                    ? jobs
                        .filter((item) => item.engine === 'mossinfer' && item.kind === 'inference' && item.state === 'queued')
                        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
                        .findIndex((item) => item.id === job.id) + 1
                    : 0
                  const currentPercent = progress?.stage === 'denoise' && progress.total > 0
                    ? Math.min(100, Math.max(0, progress.percent))
                    : undefined
                  const hasOutputs = outputs.length > 0
                  // Result Canvases always show the picture; a layout Canvas shows its
                  // result too, until the user switches back to the bbox editor.
                  const showResultImage = hasOutputs && (canvas.kind === 'result' || editingCanvasId !== canvas.id)
                  return (
                    <article
                      key={canvas.id}
                      data-canvas-card={canvas.id}
                      ref={(element) => {
                        if (element) canvasCardRefs.current.set(canvas.id, element)
                        else canvasCardRefs.current.delete(canvas.id)
                      }}
                      role="group"
                      aria-label={`${canvas.title}${isActive ? '，已选中' : ''}`}
                      tabIndex={0}
                      aria-current={isActive ? 'true' : undefined}
                      style={{
                        position: 'absolute',
                        left: boardCardPosition(canvas).x,
                        top: boardCardPosition(canvas).y,
                        width: boardCardWidth(canvas),
                      }}
                      onClick={() => {
                        // A drag just ended here: keep the board where the user put it.
                        selectCanvas(canvas, { focus: performance.now() > suppressFocusRef.current })
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          selectCanvas(canvas)
                        }
                      }}
                      className={cn(
                        'relative overflow-hidden rounded-lg border bg-[#171a20] transition',
                        dragCanvasId === canvas.id && 'z-10 shadow-2xl',
                        activeTask && 'studio-canvas-running',
                        isActive ? 'border-accent-400 ring-1 ring-accent-400/50' : 'border-[var(--color-border)] hover:border-white/25',
                      )}
                    >
                      <header
                        onPointerDown={(event) => beginCardDrag(event, canvas)}
                        onPointerMove={moveCardDrag}
                        onPointerUp={endCardDrag}
                        onPointerCancel={endCardDrag}
                        className={cn(
                          'flex min-h-10 touch-none items-center gap-2 border-b border-[var(--color-border-subtle)] px-2.5 select-none',
                          dragCanvasId === canvas.id ? 'cursor-grabbing' : 'cursor-grab',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-caption font-medium">
                          {canvas.title}
                          <span className="ml-1.5 text-micro text-[var(--color-text-tertiary)]">
                            {canvas.kind === 'result' ? '结果' : `${canvas.width}×${canvas.height}`}
                          </span>
                        </span>
                        {hasOutputs && canvas.kind === 'layout' ? (
                          <button
                            type="button"
                            title={editingCanvasId === canvas.id ? '查看生成结果' : '回到布局编辑'}
                            aria-label={editingCanvasId === canvas.id ? `查看 ${canvas.title} 的结果` : `编辑 ${canvas.title} 的布局`}
                            onClick={(event) => {
                              event.stopPropagation()
                              selectCanvas(canvas)
                              setEditingCanvasId(editingCanvasId === canvas.id ? null : canvas.id)
                            }}
                            className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-white/10 hover:text-[var(--color-text)]"
                          >{editingCanvasId === canvas.id ? <Eye className="size-3.5" /> : <SquareDashedMousePointer className="size-3.5" />}</button>
                        ) : null}
                        {missingJob ? (
                          <Pill tone="red">任务记录不可用</Pill>
                        ) : job ? (
                          <Pill tone={job.state === 'succeeded' ? 'accent' : job.state === 'failed' ? 'red' : job.state === 'canceled' ? 'neutral' : 'amber'}>
                            {job.state === 'queued' ? `排队第 ${queuePosition} 位` : job.state === 'starting' ? '启动中' : job.state === 'running' ? '生成中' : job.state === 'succeeded' ? '完成' : job.state === 'canceled' ? '已取消' : '失败'}
                          </Pill>
                        ) : canvas.jobState ? (
                          <Pill tone={canvas.jobState === 'succeeded' ? 'accent' : canvas.jobState === 'failed' ? 'red' : 'amber'}>
                            {canvas.jobState === 'succeeded' ? '完成' : canvas.jobState === 'failed' ? '失败' : canvas.jobState === 'canceled' ? '已取消' : '等待任务'}
                          </Pill>
                        ) : null}
                        <button
                          type="button"
                          title="复制参数为新 Canvas"
                          aria-label={`复制 ${canvas.title} 参数为新 Canvas`}
                          onClick={(event) => { event.stopPropagation(); addCanvas(canvas) }}
                          className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-white/10 hover:text-[var(--color-text)]"
                        ><Copy className="size-3.5" /></button>
                        <button
                          type="button"
                          title="重跑并保留旧结果"
                          aria-label={`重跑 ${canvas.title}`}
                          onClick={(event) => { event.stopPropagation(); void generate(canvas) }}
                          disabled={submitting || projectSaving || !canvas.prompt.trim()}
                          className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-accent-400/10 hover:text-accent-200 disabled:opacity-40"
                        ><Play className="size-3.5" /></button>
                        {canvas.jobId && activeTask ? (
                          <button
                            type="button"
                            title="取消任务"
                            aria-label={`取消 ${canvas.title} 任务`}
                            onClick={(event) => {
                              event.stopPropagation()
                              void cancelJob(canvas.jobId!).catch((error) => toast.push(error instanceof Error ? error.message : String(error), 'error'))
                            }}
                            className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-amber-400/10 hover:text-amber-200"
                          ><CircleStop className="size-3.5" /></button>
                        ) : null}
                        <button
                          type="button"
                          title="删除 Canvas"
                          aria-label={`删除 ${canvas.title}`}
                          onClick={(event) => { event.stopPropagation(); void deleteCanvas(canvas) }}
                          className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-red-400/10 hover:text-red-300"
                        ><Trash2 className="size-3.5" /></button>
                      </header>

                      {showResultImage ? (
                        <button
                          type="button"
                          onClick={() => selectCanvas(canvas)}
                          onDoubleClick={(event) => {
                            event.stopPropagation()
                            const first = outputs[0]
                            if (first) setPreviewOutput({ canvas, path: first.path })
                          }}
                          title="双击查看大图与生成参数"
                          className="relative block w-full cursor-zoom-in overflow-hidden bg-black/25"
                          style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}
                        >
                          <ResultImage
                            path={outputs[0]!.path}
                            title={canvas.title}
                            className="size-full object-cover"
                          />
                          {outputs.length > 1 ? (
                            <span className="absolute right-2 top-2 rounded bg-black/65 px-1.5 py-0.5 text-micro text-white/85">
                              {outputs.length} 张 · 双击查看
                            </span>
                          ) : null}
                        </button>
                      ) : canvas.kind === 'result' ? (
                        <div
                          className="flex items-center justify-center bg-black/20 p-3"
                          style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}
                        >
                          <div className="px-4 text-center text-caption text-[var(--color-text-tertiary)]">
                            {job?.error?.message
                              ?? canvas.error?.message
                              ?? (job?.state === 'succeeded'
                                ? '任务完成，但未返回图片输出'
                                : missingJob
                                  ? '应用重启或任务记录已清理，无法恢复该任务状态'
                                : job?.state === 'canceled'
                                  ? '任务已取消'
                                  : activeTask
                                    ? '任务运行中，结果将在此显示'
                                    : '尚无生成结果')}
                          </div>
                        </div>
                      ) : isActive ? (
                        <div
                          className="relative w-full overflow-hidden bg-black/20"
                          style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}
                        >
                          <div
                            ref={canvasRef}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerCancel={handlePointerUp}
                            className={cn(
                              'absolute inset-0 select-none overflow-hidden',
                              tool === 'draw' ? 'cursor-crosshair' : 'cursor-default',
                            )}
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
                      ) : (
                        <div
                          className="relative w-full overflow-hidden bg-black/20"
                          style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}
                        >
                          {canvas.backgroundPath ? <img src={cloverUrl(canvas.backgroundPath)} alt="" className="absolute inset-0 size-full object-contain opacity-50" /> : null}
                          {canvas.layers.filter((layer) => layer.visible).map((layer) => {
                            const [x1, y1, x2, y2] = layer.bbox
                            return (
                              <div
                                key={layer.id}
                                className="absolute rounded border border-sky-300/70 bg-sky-300/10"
                                style={{
                                  left: `${x1 / canvas.width * 100}%`,
                                  top: `${y1 / canvas.height * 100}%`,
                                  width: `${(x2 - x1) / canvas.width * 100}%`,
                                  height: `${(y2 - y1) / canvas.height * 100}%`,
                                }}
                              />
                            )
                          })}
                          {canvas.layers.length === 0 ? <span className="absolute inset-0 flex items-center justify-center text-caption text-[var(--color-text-tertiary)]">空布局 · 点击选择并编辑</span> : null}
                        </div>
                      )}

                      {canvas.kind === 'result' || activeTask || canvas.error ? (
                        <div className="border-t border-[var(--color-border-subtle)] px-2.5 pb-1.5 pt-2">
                          {canvas.kind === 'result' ? <p className="truncate text-micro text-[var(--color-text-tertiary)]">{canvas.prompt}</p> : null}
                          {activeTask ? (
                            <div className="mt-1 flex justify-between gap-2 text-micro">
                              <span className="truncate">
                                {job?.state === 'queued' ? '排队等待' : ({
                                  idle: '准备引擎', ready: '引擎就绪', load: '加载模型', text: '文本编码',
                                  denoise: '去噪', decode: '图像解码', save: '保存结果',
                                }[progress?.stage ?? 'idle'] ?? '处理中')}
                                {progress?.stage === 'denoise' && progress.total > 0 ? ` · ${progress.current}/${progress.total} 步` : ''}
                              </span>
                              {currentPercent !== undefined ? <span className="shrink-0 font-mono">{Math.round(currentPercent)}%</span> : null}
                            </div>
                          ) : canvas.error?.message ? <p className="mt-1 text-micro text-red-300">{canvas.error.message}</p> : null}
                        </div>
                      ) : null}

                      {/* Progress band pinned to the Canvas edge while a job runs. */}
                      {activeTask ? (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] overflow-hidden bg-white/10">
                          <div
                            className={cn(
                              'h-full bg-accent-400 transition-[width] duration-500 ease-out',
                              currentPercent === undefined && 'w-1/3 studio-canvas-progress-slide',
                            )}
                            style={currentPercent === undefined ? undefined : { width: `${currentPercent}%` }}
                          />
                        </div>
                      ) : null}
                    </article>
                  )
                })}
                <button
                  type="button"
                  onClick={() => addCanvas()}
                  style={{
                    position: 'absolute',
                    left: nextBoardSpot.x,
                    top: nextBoardSpot.y,
                    width: Math.round(draft.width * BOARD_UNIT),
                    height: Math.round(draft.height * BOARD_UNIT) + CARD_HEADER,
                  }}
                  className="flex items-center justify-center rounded-lg border border-dashed border-white/15 bg-white/[0.015] text-caption text-[var(--color-text-tertiary)] transition hover:border-accent-400/50 hover:bg-accent-400/[0.04] hover:text-[var(--color-text-secondary)]"
                >
                  <span className="flex flex-col items-center gap-2"><Plus className="size-6" /><span>新建内容</span></span>
                </button>
              </div>
            )}
          </div>
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-1 text-micro text-white/55">
            {Math.round(zoom * 100)}% · 滚轮缩放 · 拖空白处或中键平移
          </div>

          {minimap ? (
            <div
              className="pointer-events-none absolute bottom-3 right-3 overflow-hidden rounded-md border border-white/15 bg-black/55 shadow-lg backdrop-blur-sm"
              style={{ width: 168, height: 112 }}
              aria-hidden="true"
            >
              <div
                className="absolute inset-0"
                style={{
                  transform: `scale(${Math.min(160 / minimap.width, 104 / minimap.height)})`,
                  transformOrigin: 'top left',
                  width: minimap.width,
                  height: minimap.height,
                }}
              >
                {minimap.cards.map((card) => (
                  <div
                    key={card.id}
                    className={cn(
                      'absolute rounded-[2px] border',
                      card.id === selectedCanvasId
                        ? 'border-accent-300/80 bg-accent-400/45'
                        : 'border-white/25 bg-white/15',
                    )}
                    style={{ left: card.x, top: card.y, width: card.width, height: card.height }}
                  />
                ))}
                <div
                  className="absolute rounded-[2px] border border-accent-200/90 bg-accent-200/[0.06]"
                  style={{
                    left: minimap.view.x,
                    top: minimap.view.y,
                    width: minimap.view.width,
                    height: minimap.view.height,
                  }}
                />
              </div>
            </div>
          ) : null}

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
                disabled={!selectedCanvas || selectedCanvas.kind !== 'layout'}
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
        {selectedCanvas?.kind === 'layout' ? (
          <>
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
          </>
        ) : (
          <div className="px-5 py-10 text-center text-caption leading-5 text-[var(--color-text-tertiary)]">
            {selectedCanvas
              ? '这是生成结果 Canvas。可在左侧调整参数后重跑，或复制参数创建可编辑 Canvas。'
              : '请点击选择一个 Canvas，创作工具将在此启用。'}
          </div>
        )}
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
        open={previewOutput !== null}
        onClose={() => setPreviewOutput(null)}
        title={previewOutput ? `生成结果 · ${previewOutput.canvas.title}` : '生成结果'}
        description={previewOutput?.path}
        width="max-w-5xl"
        footer={previewOutput ? (
          <>
            <Button
              tone="ghost"
              onClick={() => {
                void call(Ipc.galleryReveal, { path: previewOutput.path }).catch((error) => toast.push(error instanceof Error ? error.message : String(error), 'error'))
              }}
            >在文件夹中打开</Button>
            <Button
              tone="secondary"
              onClick={() => {
                void call(Ipc.openPath, { path: previewOutput.path }).catch((error) => toast.push(error instanceof Error ? error.message : String(error), 'error'))
              }}
            >用默认程序打开</Button>
            <Button tone="primary" onClick={() => setPreviewOutput(null)}>关闭</Button>
          </>
        ) : null}
      >
        {previewOutput ? (
          <div className="space-y-3">
            <div className="flex justify-center overflow-hidden rounded bg-black/40 p-2">
              <img
                src={cloverUrl(previewOutput.path)}
                alt={previewOutput.canvas.title}
                className="max-h-[56vh] w-auto object-contain"
              />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-caption sm:grid-cols-3">
              <div><dt className="text-[var(--color-text-tertiary)]">尺寸</dt><dd>{previewOutput.canvas.width}×{previewOutput.canvas.height}</dd></div>
              <div><dt className="text-[var(--color-text-tertiary)]">步数</dt><dd>{previewOutput.canvas.steps}</dd></div>
              <div><dt className="text-[var(--color-text-tertiary)]">CFG</dt><dd>{previewOutput.canvas.cfg}</dd></div>
              <div><dt className="text-[var(--color-text-tertiary)]">Seed</dt><dd>{previewOutput.canvas.seed}</dd></div>
              <div>
                <dt className="text-[var(--color-text-tertiary)]">模型</dt>
                <dd>{catalog?.bundles?.find((bundle) => bundle.id === previewOutput.canvas.modelBundleId)?.name ?? previewOutput.canvas.modelBundleId ?? '—'}</dd>
              </div>
              <div><dt className="text-[var(--color-text-tertiary)]">设备</dt><dd>{previewOutput.canvas.deviceId ?? '—'}</dd></div>
              {previewJob ? (
                <>
                  <div><dt className="text-[var(--color-text-tertiary)]">任务</dt><dd className="font-mono text-micro">{previewJob.id}</dd></div>
                  <div><dt className="text-[var(--color-text-tertiary)]">状态</dt><dd>{previewJob.state}</dd></div>
                  <div>
                    <dt className="text-[var(--color-text-tertiary)]">耗时</dt>
                    <dd>
                      {previewJob.startedAt && previewJob.endedAt
                        ? `${Math.max(1, Math.round((new Date(previewJob.endedAt).getTime() - new Date(previewJob.startedAt).getTime()) / 1000))} 秒`
                        : '—'}
                    </dd>
                  </div>
                </>
              ) : null}
            </dl>
            <div>
              <div className="text-caption text-[var(--color-text-tertiary)]">提示词</div>
              <p className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-caption leading-5 text-[var(--color-text-secondary)]">
                {previewOutput.canvas.prompt || '—'}
              </p>
            </div>
            <div>
              <div className="text-caption text-[var(--color-text-tertiary)]">负面提示词</div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-caption leading-5 text-[var(--color-text-secondary)]">
                {previewOutput.canvas.negative || '—'}
              </p>
            </div>
          </div>
        ) : null}
      </Modal>

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
