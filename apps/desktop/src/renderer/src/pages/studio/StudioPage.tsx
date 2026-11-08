import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GalleryItem, GpuInventorySnapshot, ManagedHost, ProjectCanvas, ProjectLayer } from '@shared/types'
import { ADAPTER_STRENGTH_DEFAULT, normalizeCanvasAdapters } from '@shared/adapters'
import { activeCanvasBranchIds } from '@shared/canvasJobBranch'
import { Events, Ipc } from '@shared/channels'
import { Sparkles } from 'lucide-react'
import { Button, ConfirmDialog, useToast } from '../../components/ui'
import { TitlebarPortal } from '../../components/shell/Titlebar'
import { AdapterPicker } from '../../components/studio/AdapterPicker'
import { StudioSidebar } from '../../components/studio/StudioSidebar'
import { installStudioToolBridge, registerStudioTools, type StudioToolApi } from '../../lib/agentTools'
import { call, onEvent } from '../../lib/api'
import { clampBox } from '../../lib/layout'
import { useShell } from '../../lib/shell'
import { useApp } from '../../store'
import { Assistant } from './assistant/Assistant'
import { Board, type BoardHandle } from './Board'
import { canvasFromPicture, canvasFromReuse, newRegion, removedWith, resizeCanvas, settingsFrom } from './canvases'
import { clampDimension, isSeedLocked, nearestQuality, qualityPreset, SEED_MAX } from './defaults'
import { InspectorPanel } from './InspectorPanel'
import type { InputsWiring } from './InputsSection'
import { ACTIVE_JOB_STATES } from './jobStatus'
import { OutputViewer } from './OutputViewer'
import { ParamsPanel } from './ParamsPanel'
import { ProjectSwitcher } from './ProjectSwitcher'
import { canvasDescription, withDescription } from './prompt'
import type { BoardTool } from './RegionLayer'
import { deriveReadiness, resolveBundle } from './readiness'
import { useBoardAssets } from './useBoardAssets'
import { useEngineFeatures } from './useEngineFeatures'
import { useControlAdapters } from '../../lib/useControlAdapters'
import { GalleryPicker } from './GalleryPicker'
import { removeLink, roleLabel, setControlAdapter, setLink, type CanvasLinkEntry, type LinkRole, type PickTarget } from './links'
import type { Recipe } from './recipes'
import { BOARD_GAP, cardWidth } from './boardLayout'
import {
  createStyleCanvas,
  generationCanvas,
  nodeBlockers,
  seriesFromStyle,
  STYLE_CARD,
  styleLoraNote,
  upscaleFromPicture,
  upscaleProblem,
  withUpscaleSize,
} from './nodes'
import { dropRun, givesPicture, isActiveRun, keepCardsShown, pictureLink, pinRun, runsOf, unpinRun, withRunSettings } from './runs'
import { resolveJobInputs } from './jobInputs'
import { useGenerate } from './useGenerate'
import { useInputImport } from './useInputImport'
import { useStudioProject } from './useStudioProject'

const BUNDLE_KEY = 'mossstudio.modelBundleId'
const HOST_KEY = 'mossstudio.studioHostId'
const WIDTH_KEY = 'mossstudio.studioPanelWidths'
const UNDERLAY_HANDOFF_KEY = 'clover.studioBackground'

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Remembered choices are conveniences only.
  }
}

function initialWidths(): { left: number; right: number } {
  try {
    const parsed = JSON.parse(readStorage(WIDTH_KEY) ?? '') as { left?: unknown; right?: unknown }
    return {
      left: typeof parsed.left === 'number' ? parsed.left : 320,
      right: typeof parsed.right === 'number' ? parsed.right : 300,
    }
  } catch {
    return { left: 320, right: 300 }
  }
}

/** True while the element is laid out (pages stay mounted but hidden). */
function useIsShown(ref: React.RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(() => setShown(element.getClientRects().length > 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return shown
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

export function StudioPage(): React.JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const openActivity = useShell((state) => state.openActivity)
  const jobs = useApp((state) => state.jobs)
  const catalog = useApp((state) => state.catalog)
  const settings = useApp((state) => state.settings)
  const engineReadiness = useApp((state) => state.engineReadiness)
  const update = useApp((state) => state.update)
  const importAdapters = useApp((state) => state.importAdapters)
  const cancelJob = useApp((state) => state.cancelJob)
  const studioBackground = useApp((state) => state.studioBackground)
  const setStudioBackground = useApp((state) => state.setStudioBackground)
  const reuseRequest = useApp((state) => state.studioReuseRequest)

  const root = useRef<HTMLDivElement>(null)
  const board = useRef<BoardHandle>(null)
  const shown = useIsShown(root)
  const notifyError = useCallback((message: string) => toast.push(message, 'error'), [toast])
  const project = useStudioProject({ jobs, onError: notifyError, active: shown })
  const selected = project.selectedCanvas

  const [preferredBundleId, setPreferredBundleId] = useState<string | null>(() => readStorage(BUNDLE_KEY))
  const [gpuInventory, setGpuInventory] = useState<GpuInventorySnapshot | null>(null)
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [remoteHostId, setRemoteHostId] = useState(() => readStorage(HOST_KEY) ?? '')
  const [tool, setTool] = useState<BoardTool>('select')
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)
  /** 助手 opens beside the board from the title bar; closed, the board takes the room. */
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [widths, setWidths] = useState(initialWidths)
  const [viewer, setViewer] = useState<{ canvasId: string; index: number } | null>(null)
  const [deleting, setDeleting] = useState<ProjectCanvas | null>(null)
  const [adapterPickerOpen, setAdapterPickerOpen] = useState(false)
  // 从作品选择: the input a picture from 作品 goes into.
  // 从作品选择: the input a picture from 作品 goes into, or (right-click on the board) where it goes on the board.
  const [galleryTarget, setGalleryTarget] = useState<PickTarget | { at: { x: number; y: number } } | null>(null)

  const remoteEnabled = settings?.remoteHostsEnabled === true
  const remoteHost = remoteEnabled ? (hosts.find((host) => host.id === remoteHostId) ?? null) : null
  const bundle = resolveBundle(catalog, selected?.modelBundleId, preferredBundleId)
  // Board: wires, imported pictures and masks.
  const boardFeatures = useEngineFeatures(
    selected ? { deviceUuid: selected.deviceUuid, hostId: remoteHost?.id } : { hostId: remoteHost?.id },
  )
  const { adapters: controlAdapters, loaded: controlAdaptersLoaded } = useControlAdapters()
  const boardAssets = useBoardAssets({ project, notify: toast.push })
  // Inspector: what the selected canvas's pictures and sampling resolve to.
  // What the selected 画面 generates with: its 风格 applied, a 放大 sized from its 原图.
  const generating = useMemo(
    () => (selected?.kind === 'layout' ? generationCanvas(selected, project.canvases) : null),
    [selected, project.canvases],
  )
  const inputBlockers = useMemo(
    () =>
      generating
        ? [
            ...nodeBlockers(generating, project.canvases),
            ...resolveJobInputs(generating, { canvases: project.canvases, features: boardFeatures, controlAdapters, controlAdaptersLoaded })
              .blockers,
          ]
        : [],
    [generating, project.canvases, boardFeatures, controlAdapters, controlAdaptersLoaded],
  )
  const derived = deriveReadiness({
    canvas: generating,
    catalog,
    bundle,
    engine: engineReadiness,
    // While first-run preparation is still going ('active'), its page is where progress shows.
    setupDone: settings ? settings.onboardingState === 'completed' || settings.onboardingState === 'dismissed' : true,
    remote: remoteHost ? { name: remoteHost.name, modelPath: remoteHost.modelPath } : null,
    inputBlockers,
    update,
    features: boardFeatures,
  })
  // A LoRA blocker says when some of the LoRA come from a 风格 (the 画面's own list does not show them).
  const loraNote = selected?.kind === 'layout' ? styleLoraNote(selected, project.canvases) : ''
  const readiness = loraNote
    ? {
        ...derived,
        blockers: derived.blockers.map((blocker) =>
          ['adapters', 'remote-adapters', 'lora-unsupported'].includes(blocker.id)
            ? { ...blocker, message: `${blocker.message}${loraNote}` }
            : blocker,
        ),
      }
    : derived
  const busyIds = useMemo(() => activeCanvasBranchIds(project.canvases, jobs), [project.canvases, jobs])
  const selectedBusy = selected ? busyIds.has(selected.id) : false
  const { submitting, generate } = useGenerate({
    project,
    catalog,
    preferredBundleId,
    remoteHost,
    controlAdapters,
    controlAdaptersLoaded,
    notify: toast.push,
  })
  const inputImport = useInputImport({ project, notify: toast.push })

  useEffect(() => {
    writeStorage(WIDTH_KEY, JSON.stringify(widths))
  }, [widths])

  // A different canvas has its own regions.
  useEffect(() => setSelectedRegionId(null), [project.selectedCanvasId])
  // Leaving the mask tool's canvas ends painting.
  useEffect(() => {
    setTool((current) => (current === 'mask' ? 'select' : current))
  }, [project.selectedCanvasId])

  useEffect(() => {
    void call<GpuInventorySnapshot>(Ipc.gpuInventory)
      .then(setGpuInventory)
      .catch(() => undefined)
    return onEvent<GpuInventorySnapshot>(Events.gpuInventory, setGpuInventory)
  }, [])

  // SSH machines only matter when the 远程主机 feature is on.
  useEffect(() => {
    if (!remoteEnabled) return
    let alive = true
    const load = (): void => {
      void call<ManagedHost[]>(Ipc.hostsList)
        .then((list) => {
          if (alive) setHosts(list.filter((host) => host.kind === 'ssh'))
        })
        .catch(() => undefined)
    }
    load()
    const stop = onEvent(Events.hostsChanged, load)
    return () => {
      alive = false
      stop()
    }
  }, [remoteEnabled])

  // `project` is a new object every render; its refs and actions are stable.
  // Effects depend on those, so a job progress tick does not re-run them.
  const { loaded, canvasesRef, selectedRef, updateCanvas, addCanvas, setCanvases, select } = project

  const applyUnderlay = useCallback(
    (path: string | undefined) => {
      const current = canvasesRef.current.find((canvas) => canvas.id === selectedRef.current)
      if (current?.kind === 'layout') updateCanvas(current.id, { backgroundPath: path })
      else if (path) {
        const created = addCanvas()
        updateCanvas(created.id, { backgroundPath: path })
      }
    },
    [canvasesRef, selectedRef, updateCanvas, addCanvas],
  )

  // A picture chosen as underlay from 作品 arrives through the store (same window)
  // or through localStorage (another window).
  useEffect(() => {
    if (!loaded) return
    if (studioBackground) {
      applyUnderlay(studioBackground.path)
      setStudioBackground(null)
      writeStorage(UNDERLAY_HANDOFF_KEY, null)
      return
    }
    const consume = (): void => {
      const raw = readStorage(UNDERLAY_HANDOFF_KEY)
      if (!raw) return
      writeStorage(UNDERLAY_HANDOFF_KEY, null)
      try {
        const item = JSON.parse(raw) as GalleryItem
        if (typeof item?.path === 'string') applyUnderlay(item.path)
      } catch {
        // A malformed hand-off is dropped.
      }
    }
    consume()
    window.addEventListener('focus', consume)
    return () => window.removeEventListener('focus', consume)
  }, [loaded, studioBackground, setStudioBackground, applyUnderlay])

  // 作品 › 在创作中复用: a new canvas with that image's parameters.
  useEffect(() => {
    if (!loaded || !reuseRequest) return
    const request = useApp.getState().takeStudioReuseRequest()
    if (!request) return
    const list = canvasesRef.current
    const current = list.find((canvas) => canvas.id === selectedRef.current)
    const { canvas, missingAdapters } = canvasFromReuse(request, list, settingsFrom(current), catalog?.adapters ?? [])
    setCanvases([...list, canvas])
    select(canvas.id)
    requestAnimationFrame(() => board.current?.reveal(canvas.id))
    // 用作起始图: the picture comes onto the board beside the new canvas and feeds it.
    if (request.useAs === 'start') {
      void inputImport.importPaths([request.sourcePath], canvas).then(([image]) => {
        if (image) updateCanvas(canvas.id, (item) => setLink(item, 'init', { canvasId: image.id }))
      })
    }
    const choice = resolveBundle(catalog, canvas.modelBundleId, preferredBundleId)
    if (request.modelBundleId && (choice.unavailable || !choice.installed)) {
      toast.push(`这张图用的模型「${request.modelName ?? request.modelBundleId}」还没有下载，生成前请先下载或换一个模型`, 'info')
    }
    if (missingAdapters.length) toast.push(`模型库里没有这些 LoRA：${missingAdapters.join('、')}`, 'info')
  }, [loaded, reuseRequest, canvasesRef, selectedRef, setCanvases, select, catalog, preferredBundleId, toast, inputImport, updateCanvas])

  const changeSelected = (update: (canvas: ProjectCanvas) => ProjectCanvas): void => {
    if (selected) project.updateCanvas(selected.id, update)
  }
  const changeLayers = (canvasId: string, update: (layers: ProjectLayer[]) => ProjectLayer[]): void => {
    project.updateCanvas(canvasId, (canvas) => ({ ...canvas, layers: update(canvas.layers) }))
  }

  /**
   * Link a picture into a canvas. A 画面 gives the picture on its face (a
   * filmstrip run), and a run used this way is pinned as a card of its own.
   */
  const linkInto = (targetId: string, role: LinkRole, link: CanvasLinkEntry['link'], kind?: string): void => {
    project.setCanvases((previous) => {
      const source = previous.find((canvas) => canvas.id === link.canvasId)
      const target = previous.find((canvas) => canvas.id === targetId)
      // A 画面 whose face has no picture yet (a run just started) has nothing to give.
      if (!source || !target || (source.kind === 'layout' && !givesPicture(source, previous))) return previous
      const resolved = pictureLink(previous, link)
      const linked = setLink(target, role, resolved, kind)
      if (linked === target) return previous
      const next = pinRun(previous, resolved.canvasId)
      // A 放大 takes its size from its 原图.
      return next.map((canvas) => (canvas.id === targetId ? withUpscaleSize(linked, next) : canvas))
    })
  }

  /** 用作起始图 (or a wire dropped on the empty board): a new 画面 fed by a card's picture. */
  const newCanvasFromPicture = (sourceId: string, role: 'init' | 'reference' = 'init', at?: { x: number; y: number }): void => {
    const list = project.canvasesRef.current
    // A picture card has no generation settings; the new 画面 takes the latest canvas's.
    const made = canvasFromPicture(list, sourceId, { role, at, fallback: latestSettings() })
    if (!made) return
    project.setCanvases(made.canvases)
    project.select(made.created.id)
    requestAnimationFrame(() => board.current?.reveal(made.created.id))
  }

  const latestSettings = (): ReturnType<typeof settingsFrom> =>
    settingsFrom([...project.canvasesRef.current].reverse().find((canvas) => canvas.kind === 'layout' || canvas.kind === 'result'))

  /** 放大: a 放大 node fed by a card's picture, to its right (or where a wire was dropped). */
  const upscaleFrom = (sourceId: string, at?: { x: number; y: number }): void => {
    const list = project.canvasesRef.current
    const problem = upscaleProblem(list, pictureLink(list, { canvasId: sourceId }))
    if (problem) {
      toast.push(problem, 'info')
      return
    }
    const made = upscaleFromPicture(list, sourceId, { fallback: latestSettings(), at })
    if (!made) return
    project.setCanvases(made.canvases)
    project.select(made.created.id)
    requestAnimationFrame(() => board.current?.reveal(made.created.id))
  }

  /** A new 风格, wired into `canvasId` when given; selected so its description can be written. */
  const addStyle = (canvasId?: string, styleId?: string, at?: { x: number; y: number }): void => {
    if (canvasId && styleId) {
      linkInto(canvasId, 'style', { canvasId: styleId })
      return
    }
    const list = project.canvasesRef.current
    const near = canvasId ? list.find((canvas) => canvas.id === canvasId) : undefined
    const style = createStyleCanvas(
      list,
      at ? { at } : near ? { at: { x: near.x - cardWidth(STYLE_CARD) - BOARD_GAP * 2, y: near.y } } : {},
    )
    project.setCanvases((previous) => {
      const next = [...previous, style]
      return canvasId ? next.map((canvas) => (canvas.id === canvasId ? setLink(canvas, 'style', { canvasId: style.id }) : canvas)) : next
    })
    project.select(style.id)
    requestAnimationFrame(() => (at ? board.current?.keepInView(style.id) : board.current?.reveal(style.id)))
  }

  /** Pick one picture file and bring it onto the board as a picture card. */
  const pickPicture = async (): Promise<ProjectCanvas | null> => {
    let paths: string[]
    try {
      paths = await call<string[]>(Ipc.pickImages, { title: '选择要放大的图' })
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
      return null
    }
    if (!paths?.length) return null
    const [image] = await inputImport.importPaths(paths.slice(0, 1))
    return image ?? null
  }

  /** Pictures brought onto the board with their first card's corner at `at` (the right-click point). */
  const importAt = async (paths: readonly string[], at: { x: number; y: number }): Promise<void> => {
    const created = await inputImport.importPaths(paths)
    if (!created.length) return
    const first = created[0]!
    const ids = new Set(created.map((card) => card.id))
    project.setCanvases((previous) =>
      previous.map((canvas) => (ids.has(canvas.id) ? { ...canvas, x: canvas.x - first.x + at.x, y: canvas.y - first.y + at.y } : canvas)),
    )
    project.select(first.id)
    requestAnimationFrame(() => board.current?.keepInView(first.id))
  }

  const importPicturesAt = async (at: { x: number; y: number }): Promise<void> => {
    let paths: string[]
    try {
      paths = await call<string[]>(Ipc.pickImages, { title: '选择图片' })
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
      return
    }
    if (paths?.length) await importAt(paths, at)
  }

  /** A new 画面, at a board point when given. */
  const addCanvasAt = (at?: { x: number; y: number }): ProjectCanvas => {
    const created = project.addCanvas()
    // Placed where the user right-clicked, moved back inside the view where it would stick out.
    if (at) {
      project.setCanvases((previous) => previous.map((canvas) => (canvas.id === created.id ? { ...canvas, x: at.x, y: at.y } : canvas)))
      requestAnimationFrame(() => board.current?.keepInView(created.id))
    } else requestAnimationFrame(() => board.current?.reveal(created.id))
    return created
  }

  /** A recipe: nodes laid out and wired, most starting from a picture chosen from a file. */
  const startRecipe = async (recipe: Recipe, at?: { x: number; y: number }): Promise<void> => {
    if (recipe.id === 'series') {
      const series = seriesFromStyle(project.canvasesRef.current, latestSettings())
      project.setCanvases(series.canvases)
      project.select(series.style.id)
      requestAnimationFrame(() => board.current?.fit())
      return
    }
    if (recipe.id === 'upscale') {
      const image = await pickPicture()
      if (image) upscaleFrom(image.id)
      return
    }
    if (!recipe.role) return
    const created = addCanvasAt(at)
    if (recipe.role === 'control') {
      const adapter = controlAdapters.find((item) => item.controlKinds.length)
      if (!adapter) return
      project.updateCanvas(created.id, (canvas) => setControlAdapter(canvas, adapter.id))
      await inputImport.addFromFile(created.id, 'control', adapter.controlKinds[0])
    } else {
      await inputImport.addFromFile(created.id, recipe.role)
    }
    // 局部重绘 goes straight to painting the part to redo.
    const made = project.canvasesRef.current.find((canvas) => canvas.id === created.id)
    if (recipe.id === 'inpaint' && made?.inputs?.init) setTool('mask')
  }

  const inputsWiring: InputsWiring = {
    canvases: project.canvases,
    features: boardFeatures,
    controlAdapters,
    onLinkPicture: (role, kind, sourceId) => {
      if (selected) linkInto(selected.id, role, { canvasId: sourceId }, kind)
    },
    onAddFromFile: (role, kind) => {
      if (selected) void inputImport.addFromFile(selected.id, role, kind)
    },
    onAddFromGallery: (role, kind) => {
      if (selected) setGalleryTarget({ canvasId: selected.id, role, ...(kind ? { kind } : {}) })
    },
    maskTool: tool === 'mask',
    onToggleMask: () => setTool((current) => (current === 'mask' ? 'select' : 'mask')),
    onNavigate: (to) => {
      void navigate(to)
    },
  }

  const run = async (canvasId: string, seed?: 'new' | 'same'): Promise<void> => {
    const result = await generate(canvasId, seed)
    if (result.canvasId && result.canvasId !== canvasId) board.current?.reveal(result.canvasId)
  }

  const runPrimary = (): void => {
    if (!selected || selected.kind !== 'layout' || submitting || selectedBusy || readiness.blockers.length) return
    void run(selected.id)
  }

  // The assistant drives the canvas through these; every call reads live state.
  const live = useRef({ project, generate })
  live.current = { project, generate }
  useEffect(() => installStudioToolBridge(), [])
  useEffect(() => {
    const current = (): ProjectCanvas | null => {
      const { project: p } = live.current
      return p.canvasesRef.current.find((canvas) => canvas.id === p.selectedRef.current) ?? null
    }
    const editable = (): ProjectCanvas => {
      const canvas = current()
      if (!canvas) throw new Error('先在画布上选中一个画面')
      if (canvas.kind === 'style') throw new Error('选中的是风格，只能改它的描述')
      if (canvas.kind !== 'layout') throw new Error('选中的是生成结果，不能修改；请先复制成新画面')
      return canvas
    }
    const api: StudioToolApi = {
      readContext: () => {
        const { project: p } = live.current
        const canvas = current()
        return {
          project: { id: p.projectId, name: p.projectName },
          canvases: p.canvasesRef.current.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            width: item.width,
            height: item.height,
            jobState: item.jobState ?? 'idle',
            outputs: item.outputs?.length ?? 0,
          })),
          selected: canvas
            ? {
                id: canvas.id,
                kind: canvas.kind,
                title: canvas.title,
                width: canvas.width,
                height: canvas.height,
                steps: canvas.steps,
                cfg: canvas.cfg,
                seed: isSeedLocked(canvas) ? canvas.seed : 'random',
                prompt: canvasDescription(canvas),
                negative: canvas.negative,
                layers: canvas.layers.map((layer, index) => ({
                  index: index + 1,
                  label: layer.kind,
                  caption: layer.caption,
                  text: layer.text,
                  bbox: layer.bbox.map((value) => Math.round(value)),
                  visible: layer.visible !== false,
                })),
              }
            : null,
          notes:
            'prompt is the overall description; the final prompt is compiled from it plus the visible regions. bbox is [x1,y1,x2,y2] in canvas pixels; studio_add_layer takes normalised 0-1 x/y/w/h. steps snap to 8 (fast), 20 (standard) or 50 (fine).',
        }
      },
      snapshot: () => {
        const canvas = current()
        if (!canvas) return null
        return {
          title: canvas.title,
          description: canvasDescription(canvas),
          width: canvas.width,
          height: canvas.height,
          regions: canvas.layers.map((layer) => ({
            kind: layer.kind,
            caption: layer.caption,
            text: layer.text,
            visible: layer.visible !== false,
          })),
        }
      },
      setPrompt: (value) => {
        // A 风格's description is written the same way.
        const selectedStyle = current()
        const canvas = selectedStyle?.kind === 'style' ? selectedStyle : editable()
        live.current.project.updateCanvas(canvas.id, (item) => withDescription(item, value))
        return { written: value.length }
      },
      setSampler: (patch) => {
        const canvas = editable()
        if (canvas.upscale && (patch.width !== undefined || patch.height !== undefined))
          throw new Error('放大的尺寸跟着原图走，只能改放大倍数')
        let next = canvas
        if (patch.width !== undefined || patch.height !== undefined) {
          next = resizeCanvas(
            next,
            clampDimension(patch.width ?? next.width, next.width),
            clampDimension(patch.height ?? next.height, next.height),
          )
        }
        if (patch.steps !== undefined) {
          const preset = qualityPreset(nearestQuality(patch.steps))
          next = { ...next, steps: preset.steps, cfg: patch.cfg === undefined ? preset.cfg : next.cfg }
        }
        if (patch.cfg !== undefined) next = { ...next, cfg: Math.min(20, Math.max(0, patch.cfg)) }
        if (patch.seed !== undefined) next = { ...next, seed: Math.min(SEED_MAX, Math.max(0, Math.round(patch.seed))), seedLocked: true }
        live.current.project.updateCanvas(canvas.id, () => next)
        return { width: next.width, height: next.height, steps: next.steps, cfg: next.cfg, seed: isSeedLocked(next) ? next.seed : 'random' }
      },
      addLayer: ({ label, caption, bbox }) => {
        const canvas = editable()
        if (canvas.upscale) throw new Error('放大按原图重画，没有区域')
        const box = clampBox(
          bbox
            ? [bbox.x * canvas.width, bbox.y * canvas.height, (bbox.x + bbox.w) * canvas.width, (bbox.y + bbox.h) * canvas.height]
            : [canvas.width * 0.2, canvas.height * 0.2, canvas.width * 0.8, canvas.height * 0.8],
          canvas.width,
          canvas.height,
        )
        const region = { ...newRegion(label, box), caption }
        live.current.project.updateCanvas(canvas.id, (item) => ({ ...item, layers: [...item.layers, region] }))
        return { added: region.id, bbox: region.bbox, index: canvas.layers.length + 1 }
      },
      generate: async (value) => {
        const canvas = editable()
        if (value?.trim()) live.current.project.updateCanvas(canvas.id, (item) => withDescription(item, value))
        const result = await live.current.generate(canvas.id)
        if (!result.queued) throw new Error(result.error ?? '没有开始生成')
        return result
      },
    }
    registerStudioTools(api)
    return () => registerStudioTools(null)
  }, [])

  // Keyboard: Ctrl+Enter generates; V / H / M pick tools; Delete removes a region.
  useEffect(() => {
    if (!shown) return
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        if (document.querySelector('dialog[open]')) return
        event.preventDefault()
        runPrimary()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) || document.querySelector('dialog[open]')) return
      const key = event.key.toLowerCase()
      if (key === 'v') setTool('select')
      else if (key === 'h') setTool('pan')
      else if (key === 'm') setTool((current) => (current === 'mask' ? 'select' : 'mask'))
      else if (key === 'escape') setSelectedRegionId(null)
      else if ((key === 'delete' || key === 'backspace') && selected?.kind === 'layout' && selectedRegionId) {
        const region = selected.layers.find((layer) => layer.id === selectedRegionId)
        if (!region || region.locked) return
        event.preventDefault()
        changeLayers(selected.id, (layers) => layers.filter((layer) => layer.id !== region.id))
        setSelectedRegionId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const deletingRuns = deleting ? removedWith(project.canvases, deleting.id).length - 1 : 0
  const viewerCanvas = viewer ? (project.canvases.find((canvas) => canvas.id === viewer.canvasId) ?? null) : null
  const viewerJob = viewerCanvas?.jobId ? jobs.find((job) => job.id === viewerCanvas.jobId) : undefined

  return (
    <div ref={root} className="studio-workbench flex h-full min-h-0 bg-board">
      {shown && project.loaded ? (
        <TitlebarPortal>
          <ProjectSwitcher project={project} />
          <Button
            tone={assistantOpen ? 'secondary' : 'ghost'}
            size="xs"
            aria-pressed={assistantOpen}
            data-assistant-toggle
            onClick={() => setAssistantOpen((open) => !open)}
            className="no-drag ml-1"
          >
            <Sparkles className="size-3.5" aria-hidden="true" strokeWidth={1.6} />
            助手
          </Button>
        </TitlebarPortal>
      ) : null}

      <StudioSidebar side="left" label="生成设置" width={widths.left} onWidthChange={(left) => setWidths((value) => ({ ...value, left }))}>
        <ParamsPanel
          canvas={selected}
          regionCount={selected?.layers.length ?? 0}
          catalog={catalog}
          bundle={bundle}
          settings={settings}
          gpuInventory={gpuInventory}
          hosts={hosts}
          remoteHostId={remoteHostId}
          onRemoteHostChange={(id) => {
            setRemoteHostId(id)
            writeStorage(HOST_KEY, id || null)
          }}
          blockers={readiness.blockers}
          prompt={selected ? (readiness.prompt ?? null) : null}
          busy={selectedBusy}
          submitting={submitting}
          onChange={changeSelected}
          onPickBundle={(id) => {
            changeSelected((canvas) => ({ ...canvas, modelBundleId: id || undefined }))
            setPreferredBundleId(id)
            writeStorage(BUNDLE_KEY, id || null)
          }}
          onOpenAdapters={() => setAdapterPickerOpen(true)}
          onGenerate={runPrimary}
          onCopyAsLayout={() => {
            if (selected) project.addCanvas(selected)
          }}
          onAddCanvas={() => project.addCanvas()}
          onNavigate={(to) => navigate(to)}
          inputs={inputsWiring}
          onUseAsStart={(id) => newCanvasFromPicture(id)}
          regions={
            <InspectorPanel
              canvas={selected}
              selectedRegionId={selectedRegionId}
              onSelectRegion={setSelectedRegionId}
              onChangeLayers={(update) => {
                if (selected) changeLayers(selected.id, update)
              }}
            />
          }
        />
      </StudioSidebar>

      <main aria-label="画布" className="min-w-120 flex-1">
        <Board
          ref={board}
          projectKey={String(project.sessionKey)}
          canvases={project.canvases}
          selectedCanvasId={project.selectedCanvasId}
          jobs={jobs}
          busyIds={busyIds}
          submitting={submitting}
          update={update}
          blockers={readiness.blockers}
          tool={tool}
          onTool={setTool}
          selectedRegionId={selectedRegionId}
          onSelectRegion={setSelectedRegionId}
          onSelectCanvas={(id) => project.select(id)}
          onMoveCanvas={(id, x, y) => project.updateCanvas(id, { x, y })}
          onChangeLayers={changeLayers}
          onUnderlay={(item) => applyUnderlay(item?.path)}
          onAddCanvas={(at) => void addCanvasAt(at)}
          onImportPictures={(at) => void importPicturesAt(at)}
          onPicturesFromGallery={(at) => setGalleryTarget({ at })}
          onOpenViewer={(canvasId, index) => setViewer({ canvasId, index })}
          onRerun={(canvasId, seed) => void run(canvasId, seed)}
          onCancel={(jobId) => {
            void cancelJob(jobId).catch((error: unknown) => toast.push(error instanceof Error ? error.message : String(error), 'error'))
          }}
          onShowActivity={(jobId) => openActivity('jobs', jobId ?? null)}
          onCopy={(canvas) => {
            const created = project.addCanvas(canvas)
            requestAnimationFrame(() => board.current?.reveal(created.id))
          }}
          onDelete={(canvas) => {
            const job = canvas.jobId ? jobs.find((item) => item.id === canvas.jobId) : undefined
            // A 画面 is busy while any run in its filmstrip is.
            const running = canvas.kind === 'layout' && runsOf(canvas, project.canvasesRef.current).some((run) => isActiveRun(run, jobs))
            if (ACTIVE_JOB_STATES.has(job?.state ?? '') || running) {
              toast.push('这个画面还在生成，先取消再删除', 'info')
              return
            }
            setDeleting(canvas)
          }}
          engineFeatures={boardFeatures}
          controlAdapters={controlAdapters}
          onLink={linkInto}
          onRemoveLink={(canvasId, role, at) =>
            project.setCanvases((previous) =>
              keepCardsShown(
                previous,
                previous.map((canvas) => (canvas.id === canvasId ? removeLink(canvas, role, at) : canvas)),
              ),
            )
          }
          onImportImages={(files, at) => {
            void boardAssets.importImages(files, at)
          }}
          onSaveMask={(canvasId, png) => {
            void boardAssets.saveMask(canvasId, png)
          }}
          portActions={{
            onLinkPicture: (canvasId, role, kind, sourceId) => linkInto(canvasId, role, { canvasId: sourceId }, kind),
            onAddFromFile: (canvasId, role, kind) => void inputImport.addFromFile(canvasId, role, kind),
            onAddFromGallery: (canvasId, role, kind) => setGalleryTarget({ canvasId, role, ...(kind ? { kind } : {}) }),
            onSetControlAdapter: (canvasId, adapterId) => project.updateCanvas(canvasId, (canvas) => setControlAdapter(canvas, adapterId)),
            onNavigate: (to) => void navigate(to),
            onAddStyle: addStyle,
          }}
          describeModel={(canvas) => {
            if (!catalog) return null
            const choice = resolveBundle(catalog, canvas.modelBundleId, preferredBundleId)
            if (!choice.bundle) return { label: choice.unavailable ? '找不到选的模型' : '没有模型', ready: false }
            // A remote host's models are checked when the job starts there.
            const ready = choice.installed || Boolean(remoteHost)
            return { label: ready ? choice.bundle.name : `${choice.bundle.name} · 未下载`, ready }
          }}
          onChangeDescription={(canvasId, text) => project.updateCanvas(canvasId, (canvas) => withDescription(canvas, text))}
          onShowOutput={(layoutId, link) => project.updateCanvas(layoutId, { shownOutput: link })}
          onPinRun={(runId, at) => project.setCanvases((previous) => pinRun(previous, runId, at))}
          onUnpinRun={(runId) => {
            const run = project.canvasesRef.current.find((canvas) => canvas.id === runId)
            project.setCanvases((previous) => unpinRun(previous, runId))
            // The card is gone from the board: its 画面 is selected instead.
            if (run?.sourceCanvasId && project.selectedRef.current === runId) project.select(run.sourceCanvasId)
          }}
          onNewFromPicture={newCanvasFromPicture}
          onUseRunSettings={(layoutId, runId) => {
            const run = project.canvasesRef.current.find((canvas) => canvas.id === runId)
            if (!run) return
            project.updateCanvas(layoutId, (canvas) => withRunSettings(canvas, run))
            toast.push('已换成这次生成用的设置', 'info')
          }}
          onDropRun={(runId) => {
            project.setCanvases((previous) => dropRun(previous, runId))
            toast.push('已删除这次生成，图片仍保留在作品里', 'info')
          }}
          onRecipe={(recipe, at) => void startRecipe(recipe, at)}
          onUpscale={upscaleFrom}
          onAddStyle={(at) => addStyle(undefined, undefined, at)}
        />
      </main>

      {/* Stays mounted while closed, so a running conversation survives. */}
      <div hidden={!assistantOpen} className="contents">
        <StudioSidebar
          side="right"
          label="助手"
          width={widths.right}
          onWidthChange={(right) => setWidths((value) => ({ ...value, right }))}
        >
          <div className="flex h-full min-h-0 flex-col p-4">
            <Assistant />
          </div>
        </StudioSidebar>
      </div>

      <GalleryPicker
        open={galleryTarget !== null}
        title={galleryTarget && 'role' in galleryTarget ? `选择${roleLabel(galleryTarget.role)}` : '选择图片'}
        onClose={() => setGalleryTarget(null)}
        onPick={(path) => {
          const target = galleryTarget
          setGalleryTarget(null)
          if (target && 'role' in target) void inputImport.addPaths(target.canvasId, target.role, target.kind, [path])
          else if (target) void importAt([path], target.at)
        }}
      />

      <OutputViewer
        canvas={viewerCanvas}
        job={viewerJob}
        catalog={catalog}
        index={viewer?.index ?? 0}
        onIndex={(index) => setViewer((value) => (value ? { ...value, index } : value))}
        onClose={() => setViewer(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `删除「${deleting.title}」？` : '删除画面？'}
        description={
          deleting?.kind === 'style'
            ? '风格会从项目里删除，接着它的画面不再用它的描述和 LoRA。'
            : deletingRuns
              ? `画面、它的区域和 ${deletingRuns} 次生成会从项目里删除。已经生成的图片仍保留在作品里。`
              : '画面和它的区域会从项目里删除。已经生成的图片仍保留在作品里。'
        }
        confirmLabel={deleting?.kind === 'style' ? '删除风格' : '删除画面'}
        onConfirm={() => {
          if (deleting) {
            const removedLinks = project.removeCanvas(deleting.id)
            if (removedLinks) toast.push(`已删除「${deleting.title}」，并移除了 ${removedLinks} 条连到它的连线`, 'info')
          }
          setDeleting(null)
        }}
      />

      <AdapterPicker
        open={adapterPickerOpen}
        selected={normalizeCanvasAdapters(selected?.adapters)}
        catalog={catalog?.adapters}
        onClose={() => setAdapterPickerOpen(false)}
        onToggle={(id) =>
          changeSelected((canvas) => {
            const current = normalizeCanvasAdapters(canvas.adapters)
            return {
              ...canvas,
              adapters: current.some((item) => item.id === id)
                ? current.filter((item) => item.id !== id)
                : normalizeCanvasAdapters([...current, { id, strength: ADAPTER_STRENGTH_DEFAULT }]),
            }
          })
        }
        onImport={async () => {
          const imported = await importAdapters().catch((error: unknown) => {
            toast.push(error instanceof Error ? error.message : String(error), 'error')
            return []
          })
          if (!imported.length) return
          // The user opened the picker to use what they import; select it.
          changeSelected((canvas) => ({
            ...canvas,
            adapters: normalizeCanvasAdapters([
              ...normalizeCanvasAdapters(canvas.adapters),
              ...imported.map((entry) => ({ id: entry.id, strength: ADAPTER_STRENGTH_DEFAULT })),
            ]),
          }))
          toast.push(`已导入 ${imported.length} 个 LoRA`, 'success')
        }}
      />
    </div>
  )
}
