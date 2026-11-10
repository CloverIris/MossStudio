import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Events, Ipc } from '@shared/channels'
import type { GbcParseProgress, GbcParseResult } from '@shared/gbc'
import type { ProjectCanvas } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { useGbcState } from '../../lib/gbc'
import { useApp } from '../../store'
import { useToast } from '../../components/ui'
import { sectionPath } from '../settings/sections'
import { removeCanvasFrom, type CanvasSettings } from './canvases'
import type { ParseView } from './CardStatus'
import { regionsCanvasFrom, untouched, withParsedRegions } from './pictureRegions'

interface ProjectAccess {
  canvases: readonly ProjectCanvas[]
  canvasesRef: { readonly current: ProjectCanvas[] }
  setCanvases: (next: ProjectCanvas[] | ((previous: ProjectCanvas[]) => ProjectCanvas[])) => void
  updateCanvas: (id: string, update: (canvas: ProjectCanvas) => ProjectCanvas) => void
  select: (id: string | null) => void
}

/**
 * 拆成区域 on the board: a new 画面 beside the picture that fills with the
 * regions GBC finds. 停止, a failure, or the 画面 going away ends the run; an
 * untouched 画面 is taken away again.
 */
export function usePictureRegions(
  project: ProjectAccess,
  options: { latestSettings: () => CanvasSettings; reveal: (canvasId: string) => void },
): {
  /** undefined while the feature is off; null when it can run; else why not. */
  blocker: string | null | undefined
  parsing: Readonly<Record<string, ParseView>>
  parse: (sourceId: string) => void
  stop: (canvasId: string) => void
} {
  const settings = useApp((state) => state.settings)
  const enabled = Boolean(settings?.gbcEnabled)
  const gbc = useGbcState(enabled, settings?.gbcVersionId ?? null)
  const navigate = useNavigate()
  const toast = useToast()
  const [parsing, setParsing] = useState<Record<string, ParseView>>({})
  const parsingRef = useRef(parsing)
  parsingRef.current = parsing

  useEffect(
    () =>
      onEvent<GbcParseProgress>(Events.gbcParse, (progress) =>
        setParsing((previous) => {
          const entry = Object.entries(previous).find(([, view]) => view.runId === progress.runId)
          if (!entry) return previous
          const [canvasId, view] = entry
          return { ...previous, [canvasId]: { ...view, phase: progress.phase, percent: progress.percent } }
        }),
      ),
    [],
  )

  // A 画面 deleted, or a project switched, while its picture is read: the run has nowhere to go.
  useEffect(() => {
    for (const [canvasId, view] of Object.entries(parsingRef.current)) {
      if (!project.canvases.some((canvas) => canvas.id === canvasId)) void call(Ipc.gbcCancel, { runId: view.runId }).catch(() => undefined)
    }
  }, [project.canvases])

  const finish = (canvasId: string): void =>
    setParsing((previous) => {
      const { [canvasId]: _done, ...rest } = previous
      return rest
    })

  const dropIfUntouched = (canvasId: string): void =>
    project.setCanvases((previous) => {
      const canvas = previous.find((item) => item.id === canvasId)
      return canvas && untouched(canvas) ? removeCanvasFrom(previous, canvasId).canvases : previous
    })

  const parse = (sourceId: string): void => {
    if (gbc.blocker) {
      void navigate(sectionPath('features'))
      return
    }
    const made = regionsCanvasFrom(project.canvasesRef.current, sourceId, { fallback: options.latestSettings() })
    if (!made) return
    const canvasId = made.created.id
    const runId = crypto.randomUUID()
    project.setCanvases(made.canvases)
    project.select(canvasId)
    requestAnimationFrame(() => options.reveal(canvasId))
    setParsing((previous) => ({
      ...previous,
      [canvasId]: { runId, picture: made.path, phase: 'reading', startedAt: new Date().toISOString() },
    }))
    void call<GbcParseResult | null>(Ipc.gbcParse, { runId, path: made.path })
      // The run is over before its 画面 may go, so taking it away does not stop the run a second time.
      .then((result) => {
        finish(canvasId)
        if (!result) {
          dropIfUntouched(canvasId)
          return
        }
        project.updateCanvas(canvasId, (canvas) => withParsedRegions(canvas, result))
        toast.push(`已拆出 ${result.regions.length} 个区域`, 'success')
      })
      .catch((error: unknown) => {
        finish(canvasId)
        dropIfUntouched(canvasId)
        toast.push(`没拆成：${error instanceof Error ? error.message : String(error)}`, 'error')
      })
  }

  const stop = (canvasId: string): void => {
    const view = parsingRef.current[canvasId]
    if (view) void call(Ipc.gbcCancel, { runId: view.runId }).catch(() => undefined)
  }

  return { blocker: enabled ? gbc.blocker : undefined, parsing, parse, stop }
}
