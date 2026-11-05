import { useCallback, useRef } from 'react'
import { Ipc } from '@shared/channels'
import type { ProjectCanvas } from '@shared/types'
import { call } from '../../lib/api'
import { createImageCanvas } from './canvases'
import { dropPositions } from './imageNodes'
import type { StudioProject } from './useStudioProject'

interface ImportedPicture { path: string; width: number; height: number }

/** The path of a file the user dropped or pasted, when it lives on disk (empty for a pasted screenshot). */
function pathOf(file: File): string {
  try {
    return window.clover.pathForFile?.(file) ?? ''
  } catch {
    return ''
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Files the board brings into the project: pictures dropped or pasted onto it
 * (copied into the project's assets, then shown as image cards) and painted
 * masks. Both need the project to exist on disk, so an unsaved one is saved first.
 */
export function useBoardAssets(options: {
  project: Pick<StudioProject, 'projectId' | 'saveNow' | 'canvasesRef' | 'setCanvases' | 'select' | 'updateCanvas'>
  notify: (text: string, tone?: 'error' | 'info' | 'success') => void
}): {
  importImages: (files: File[], at: { x: number; y: number }) => Promise<ProjectCanvas[]>
  saveMask: (canvasId: string, png: Uint8Array | null) => Promise<void>
} {
  const live = useRef(options)
  live.current = options

  const projectId = useCallback(async (): Promise<string | null> => {
    const { project } = live.current
    if (project.projectId) return project.projectId
    const saved = await project.saveNow()
    return saved?.id ?? null
  }, [])

  const importImages = useCallback(async (files: File[], at: { x: number; y: number }): Promise<ProjectCanvas[]> => {
    const id = await projectId()
    if (!id) {
      live.current.notify('项目还没保存好，图片暂时放不进来', 'error')
      return []
    }
    const pictures: ImportedPicture[] = []
    const failed: string[] = []
    for (const file of files) {
      try {
        const path = pathOf(file)
        const payload = path
          ? { projectId: id, path }
          : { projectId: id, bytes: new Uint8Array(await file.arrayBuffer()), name: file.name || 'pasted.png' }
        pictures.push(await call<ImportedPicture>(Ipc.studioImportImage, payload))
      } catch (error) {
        failed.push(`${file.name || '粘贴的图片'}：${message(error)}`)
      }
    }
    if (failed.length) live.current.notify(`有 ${failed.length} 张图片没有放进来。${failed[0]}`, 'error')
    if (!pictures.length) return []
    const { project } = live.current
    const positions = dropPositions(pictures, at)
    const created: ProjectCanvas[] = []
    for (const [index, picture] of pictures.entries()) {
      const canvas = createImageCanvas([...project.canvasesRef.current, ...created], picture)
      created.push({ ...canvas, ...positions[index] })
    }
    project.setCanvases((previous) => [...previous, ...created])
    project.select(created[created.length - 1]!.id)
    return created
  }, [projectId])

  const saveMask = useCallback(async (canvasId: string, png: Uint8Array | null): Promise<void> => {
    const { project } = live.current
    const clear = (): void => project.updateCanvas(canvasId, (canvas) => {
      if (!canvas.inputs?.mask) return canvas
      const { mask: _mask, ...inputs } = canvas.inputs
      return { ...canvas, inputs }
    })
    if (!png) {
      clear()
      return
    }
    // A mask belongs to a start picture; without one it is never written.
    if (!project.canvasesRef.current.find((canvas) => canvas.id === canvasId)?.inputs?.init) return
    const id = await projectId()
    if (!id) {
      live.current.notify('项目还没保存好，遮罩暂时存不下来', 'error')
      return
    }
    try {
      const saved = await call<{ path: string }>(Ipc.studioSaveMask, { projectId: id, canvasId, png })
      project.updateCanvas(canvasId, (canvas) => canvas.inputs?.init
        ? { ...canvas, inputs: { ...canvas.inputs, mask: { path: saved.path } } }
        : canvas)
    } catch (error) {
      live.current.notify(`遮罩没有保存成功：${message(error)}`, 'error')
    }
  }, [projectId])

  return { importImages, saveMask }
}
