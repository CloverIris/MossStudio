import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JobRecord, ProjectCanvas, ProjectDocument, ProjectSummary } from '@shared/types'
import { electronStudioClient, type StudioClient } from '../../lib/studioClient'
import { applyJobs, copyAsLayout, createLayoutCanvas, migrateCanvases, removeCanvasFrom, settingsFrom } from './canvases'
import { UNTITLED_PROJECT, nextProjectName } from './defaults'
import { useLiveState } from './useLiveState'

const AUTOSAVE_DELAY_MS = 1200

/** What decides whether the project on disk is up to date. */
function snapshotOf(name: string, canvases: readonly ProjectCanvas[], selectedCanvasId: string | null): string {
  return JSON.stringify({ name, canvases, selectedCanvasId })
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface StudioProject {
  loaded: boolean
  /** Changes whenever another project is opened or a new one is started. */
  sessionKey: number
  projects: ProjectSummary[]
  projectId: string | null
  projectName: string
  canvases: ProjectCanvas[]
  canvasesRef: { readonly current: ProjectCanvas[] }
  selectedCanvasId: string | null
  selectedRef: { readonly current: string | null }
  selectedCanvas: ProjectCanvas | null
  saveStatus: SaveStatus
  saveError: string | null
  setCanvases: (next: ProjectCanvas[] | ((previous: ProjectCanvas[]) => ProjectCanvas[])) => void
  updateCanvas: (id: string, patch: Partial<ProjectCanvas> | ((canvas: ProjectCanvas) => ProjectCanvas)) => void
  select: (id: string | null) => void
  addCanvas: (source?: ProjectCanvas) => ProjectCanvas
  /** Removes the canvas and every link that pointed at it; returns how many links went. */
  removeCanvas: (id: string) => number
  saveNow: (override?: { canvases: ProjectCanvas[]; selectedCanvasId: string | null }) => Promise<ProjectDocument | null>
  openProject: (id: string) => Promise<void>
  newProject: () => Promise<void>
  rename: (name: string) => void
  deleteProject: (id: string) => Promise<void>
}

/**
 * The open project: its canvases, the selection, and persistence. Edits are
 * saved automatically shortly after they happen; Ctrl+S saves right away.
 * Saves run one after another, so a save started by a generation never races
 * the autosave timer.
 */
export function useStudioProject(options: {
  jobs: readonly JobRecord[]
  onError: (message: string) => void
  /** False while the Studio page is hidden; keyboard shortcuts are ignored then. */
  active?: boolean
  client?: StudioClient
}): StudioProject {
  const client = options.client ?? electronStudioClient
  const onErrorRef = useRef(options.onError)
  onErrorRef.current = options.onError

  const [loaded, setLoaded] = useState(false)
  const [sessionKey, setSessionKey] = useState(0)
  const activeRef = useRef(options.active !== false)
  activeRef.current = options.active !== false
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId, projectIdRef] = useLiveState<string | null>(null)
  const [projectName, setProjectName, projectNameRef] = useLiveState(UNTITLED_PROJECT)
  const [canvases, setCanvases, canvasesRef] = useLiveState<ProjectCanvas[]>([])
  const [selectedCanvasId, setSelected, selectedRef] = useLiveState<string | null>(null)
  const [saving, setSaving] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Series fields of projects made by older versions; kept as-is when saving. */
  const meta = useRef<{ seriesId?: string; page?: number }>({})
  const lastSaved = useRef('')
  /** Bumped on every project switch so a late save never writes into another project. */
  const token = useRef(0)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Counts edits made in this window (typing, drawing, selecting, adding…);
   * job progress copied onto canvases does not count. `savedEdits` is the
   * count the last successful save included. Only edits beyond it are worth
   * writing when the Studio unmounts or the window closes.
   */
  const edits = useRef(0)
  const savedEdits = useRef(0)
  /** `updatedAt` of the file as this window last read or wrote it. */
  const knownUpdatedAt = useRef<string | null>(null)
  const loadedRef = useRef(false)
  loadedRef.current = loaded

  const snapshot = useMemo(() => snapshotOf(projectName, canvases, selectedCanvasId), [projectName, canvases, selectedCanvasId])
  const liveSnapshot = (): string => snapshotOf(projectNameRef.current, canvasesRef.current, selectedRef.current)
  const isDirty = (): boolean => liveSnapshot() !== lastSaved.current && (projectIdRef.current !== null || canvasesRef.current.length > 0)

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await client.listProjects())
    } catch {
      // The switcher keeps the previous list.
    }
  }, [client])

  const saveNow = useCallback(
    (override?: { canvases: ProjectCanvas[]; selectedCanvasId: string | null }) => {
      const queuedIn = token.current
      const run = async (): Promise<ProjectDocument | null> => {
        // Queued for a project that has since been closed or deleted.
        if (token.current !== queuedIn) return null
        const startedIn = token.current
        const id = projectIdRef.current
        const list = override?.canvases ?? canvasesRef.current
        const selected = override ? override.selectedCanvasId : selectedRef.current
        if (!id && list.length === 0) return null
        const name = projectNameRef.current.trim() || UNTITLED_PROJECT
        const sent = snapshotOf(projectNameRef.current, list, selected)
        const editsIncluded = edits.current
        setSaving((count) => count + 1)
        try {
          const saved = await client.saveProject({
            id: id ?? undefined,
            name,
            canvases: list,
            selectedCanvasId: selected ?? undefined,
            seriesId: meta.current.seriesId,
            page: meta.current.page,
          })
          if (token.current === startedIn) {
            setProjectId(saved.id)
            setSaveError(null)
            lastSaved.current = sent
            savedEdits.current = Math.max(savedEdits.current, editsIncluded)
            knownUpdatedAt.current = saved.updatedAt ?? null
            // The main process copies underlay images into the project folder;
            // adopt those paths without discarding edits made during the save.
            const savedPaths = new Map((saved.canvases ?? []).map((canvas) => [canvas.id, canvas.backgroundPath]))
            const sentPaths = new Map(list.map((canvas) => [canvas.id, canvas.backgroundPath]))
            setCanvases((previous) => {
              let changed = false
              const next = previous.map((canvas) => {
                const persisted = savedPaths.get(canvas.id)
                if (persisted === undefined || persisted === canvas.backgroundPath) return canvas
                if (sentPaths.get(canvas.id) !== canvas.backgroundPath) return canvas
                changed = true
                return { ...canvas, backgroundPath: persisted }
              })
              return changed ? next : previous
            })
          }
          void refreshProjects()
          return saved
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (token.current === startedIn) setSaveError(message)
          onErrorRef.current(`项目没有保存成功：${message}`)
          return null
        } finally {
          setSaving((count) => count - 1)
        }
      }
      const result = chain.current.then(run, run)
      chain.current = result.catch(() => undefined)
      return result
    },
    [client, refreshProjects, setCanvases, setProjectId, canvasesRef, projectIdRef, projectNameRef, selectedRef],
  )

  /** Apply a loaded document (or a fresh one) as the open project. */
  const adopt = useCallback(
    (
      doc: {
        id: string | null
        name: string
        canvases: ProjectCanvas[]
        selectedCanvasId?: string
        seriesId?: string
        page?: number
        updatedAt?: string
      },
      savedState: boolean,
    ) => {
      token.current += 1
      setSessionKey(token.current)
      const list = doc.canvases
      const selected =
        list.find((canvas) => canvas.id === doc.selectedCanvasId) ?? list.find((canvas) => canvas.kind === 'layout') ?? list[0]
      meta.current = { seriesId: doc.seriesId, page: doc.page }
      knownUpdatedAt.current = doc.updatedAt ?? null
      // Loading is not an edit; a document that still needs writing (an empty
      // project given its first canvas) counts as one.
      savedEdits.current = savedState || !doc.id ? edits.current : edits.current - 1
      setProjectId(doc.id)
      setProjectName(doc.name)
      setCanvases(list)
      setSelected(selected?.id ?? null)
      setSaveError(null)
      // A fresh project counts as saved until the user changes something.
      lastSaved.current = savedState || !doc.id ? snapshotOf(doc.name, list, selected?.id ?? null) : ''
    },
    [setCanvases, setProjectId, setProjectName, setSelected],
  )

  const blankProject = useCallback(
    (names: readonly string[]) => {
      const current = canvasesRef.current.find((canvas) => canvas.id === selectedRef.current)
      const first = createLayoutCanvas([], settingsFrom(current))
      adopt({ id: null, name: nextProjectName(names), canvases: [first], selectedCanvasId: first.id }, true)
    },
    [adopt, canvasesRef, selectedRef],
  )

  const load = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const doc = await client.getProject(id)
        if (!doc) {
          onErrorRef.current('这个项目已经不存在了')
          return false
        }
        const list = Array.isArray(doc.canvases) ? migrateCanvases(doc.canvases) : []
        if (list.length === 0) {
          const first = createLayoutCanvas([], settingsFrom(null))
          adopt({ ...doc, canvases: [first], selectedCanvasId: first.id }, false)
        } else {
          adopt({ ...doc, canvases: list }, true)
        }
        return true
      } catch (error) {
        onErrorRef.current(error instanceof Error ? error.message : String(error))
        return false
      }
    },
    [adopt, client],
  )

  // Open the most recent project on first show, or start a new one.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const list = await client.listProjects().catch(() => [] as ProjectSummary[])
      setProjects(list)
      if (!(list[0] && (await load(list[0].id)))) blankProject(list.map((item) => item.name))
      setLoaded(true)
    })()
  }, [blankProject, client, load])

  // Autosave a moment after the last change.
  useEffect(() => {
    if (!loaded || snapshot === lastSaved.current) return
    if (!projectId && canvases.length === 0) return
    const timer = setTimeout(() => {
      autosaveTimer.current = null
      void saveNow()
    }, AUTOSAVE_DELAY_MS)
    autosaveTimer.current = timer
    return () => {
      clearTimeout(timer)
      if (autosaveTimer.current === timer) autosaveTimer.current = null
    }
  }, [loaded, snapshot, projectId, canvases.length, saveNow])

  // Leaving the Studio (the shell unmounts it for first-run setup) or closing
  // the window must not drop an edit that is still waiting for the timer. Only
  // edits made here count, and never over a file someone else changed since
  // (another window, the LAN web UI, a test): an older copy must not win.
  const flushRef = useRef<() => void>(() => undefined)
  flushRef.current = () => {
    if (!loadedRef.current || edits.current <= savedEdits.current || !isDirty()) return
    const id = projectIdRef.current
    const queuedIn = token.current
    void (async () => {
      await chain.current
      if (token.current !== queuedIn || edits.current <= savedEdits.current) return
      if (id) {
        const disk = await client.getProject(id).catch(() => undefined)
        if (disk && knownUpdatedAt.current && disk.updatedAt !== knownUpdatedAt.current) return
      }
      await saveNow()
    })()
  }
  useEffect(() => {
    const onUnload = (): void => flushRef.current()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      flushRef.current()
    }
  }, [])

  // Ctrl/Cmd+S saves now instead of waiting for the timer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!activeRef.current || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (isDirty()) void saveNow()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Job progress lands on the canvases that track those jobs.
  useEffect(() => {
    if (options.jobs.length) setCanvases((previous) => applyJobs(previous, options.jobs))
  }, [options.jobs, setCanvases])

  /** setCanvases / select for callers: these are local edits. */
  const editCanvases = useCallback(
    (next: ProjectCanvas[] | ((previous: ProjectCanvas[]) => ProjectCanvas[])) => {
      edits.current += 1
      setCanvases(next)
    },
    [setCanvases],
  )
  const select = useCallback(
    (id: string | null) => {
      edits.current += 1
      setSelected(id)
    },
    [setSelected],
  )

  const updateCanvas = useCallback(
    (id: string, patch: Partial<ProjectCanvas> | ((canvas: ProjectCanvas) => ProjectCanvas)) => {
      editCanvases((previous) =>
        previous.map((canvas) => {
          if (canvas.id !== id) return canvas
          return typeof patch === 'function' ? patch(canvas) : { ...canvas, ...patch }
        }),
      )
    },
    [editCanvases],
  )

  const addCanvas = useCallback(
    (source?: ProjectCanvas) => {
      const list = canvasesRef.current
      const selectedCanvas = list.find((canvas) => canvas.id === selectedRef.current)
      // A picture card has no generation settings; carry over the latest canvas's instead.
      const current = selectedCanvas?.kind === 'image' ? [...list].reverse().find((canvas) => canvas.kind !== 'image') : selectedCanvas
      const canvas = source ? copyAsLayout(source, list) : createLayoutCanvas(list, settingsFrom(current))
      editCanvases([...list, canvas])
      select(canvas.id)
      return canvas
    },
    [canvasesRef, selectedRef, editCanvases, select],
  )

  const removeCanvas = useCallback(
    (id: string) => {
      const { canvases: remaining, removedLinks } = removeCanvasFrom(canvasesRef.current, id)
      editCanvases(remaining)
      if (selectedRef.current === id) {
        select((remaining.find((canvas) => canvas.kind === 'layout') ?? remaining[0])?.id ?? null)
      }
      return removedLinks
    },
    [canvasesRef, selectedRef, editCanvases, select],
  )

  /**
   * Before leaving the open project, write its pending edits. False when that
   * save failed: the switch is abandoned so the edits stay on screen.
   */
  const saveBeforeLeaving = useCallback(async (): Promise<boolean> => {
    if (!isDirty()) return true
    if (await saveNow()) return true
    onErrorRef.current('当前项目的改动还没保存，已留在这个项目；请稍后再试')
    return false
  }, [saveNow])

  const openProject = useCallback(
    async (id: string) => {
      if (id === projectIdRef.current) return
      if (!(await saveBeforeLeaving())) return
      await load(id)
    },
    [load, saveBeforeLeaving],
  )

  const newProject = useCallback(async () => {
    if (!(await saveBeforeLeaving())) return
    const list = await client.listProjects().catch(() => projects)
    setProjects(list)
    blankProject(list.map((item) => item.name))
  }, [blankProject, client, projects, saveBeforeLeaving])

  const rename = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      edits.current += 1
      setProjectName(trimmed)
    },
    [setProjectName],
  )

  const deleteProject = useCallback(
    async (id: string) => {
      const isOpen = id === projectIdRef.current
      const previousSaved = lastSaved.current
      const previousSavedEdits = savedEdits.current
      if (isOpen) {
        // Before anything is awaited: no pending or queued save may write the
        // deleted project back (main would recreate it under a new id).
        token.current += 1
        if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
        autosaveTimer.current = null
        lastSaved.current = liveSnapshot()
        savedEdits.current = edits.current
        // A save already on its way finishes before the delete, so the delete wins.
        await chain.current
      }
      try {
        await client.deleteProject(id)
      } catch (error) {
        onErrorRef.current(error instanceof Error ? error.message : String(error))
        if (isOpen) {
          // The project is still open: put back what was pending.
          lastSaved.current = previousSaved
          savedEdits.current = previousSavedEdits
          if (isDirty()) void saveNow()
        }
        return
      }
      const list = await client.listProjects().catch(() => projects.filter((item) => item.id !== id))
      setProjects(list)
      if (!isOpen) return
      if (!(list[0] && (await load(list[0].id)))) blankProject(list.map((item) => item.name))
    },
    [blankProject, client, load, projects, saveNow],
  )

  const selectedCanvas = canvases.find((canvas) => canvas.id === selectedCanvasId) ?? null
  const dirty = snapshot !== lastSaved.current && (projectId !== null || canvases.length > 0)
  const saveStatus: SaveStatus = saveError ? 'error' : saving > 0 || dirty ? 'saving' : projectId ? 'saved' : 'idle'

  return {
    loaded,
    sessionKey,
    projects,
    projectId,
    projectName,
    canvases,
    canvasesRef,
    selectedCanvasId,
    selectedRef,
    selectedCanvas,
    saveStatus,
    saveError,
    setCanvases: editCanvases,
    updateCanvas,
    select,
    addCanvas,
    removeCanvas,
    saveNow,
    openProject,
    newProject,
    rename,
    deleteProject,
  }
}
