import { useCallback, useMemo, useRef } from 'react'
import { Ipc } from '@shared/channels'
import type { ProjectCanvas } from '@shared/types'
import { call } from '../../lib/api'
import { createImageCanvas } from './canvases'
import { MAX_REFERENCES, setLink, type LinkRole } from './links'
import type { StudioProject } from './useStudioProject'

interface ImportedPicture { path: string; width: number; height: number }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 输入 › 添加 › 从文件: choose picture files, copy them into the project's
 * assets, put each on the board as a picture card next to the canvas and link
 * it into the role. The project is saved first when it is new (assets live in
 * its folder).
 */
export function useInputImport(options: {
  project: Pick<StudioProject, 'projectId' | 'saveNow' | 'canvasesRef' | 'setCanvases'>
  notify: (text: string, tone?: 'error' | 'info' | 'success') => void
}): {
  /** Import files as picture cards placed beside `near`; returns the new cards. */
  importPaths: (paths: readonly string[], near?: ProjectCanvas) => Promise<ProjectCanvas[]>
  /** Pick files, then link them into `targetId`'s role. */
  addFromFile: (targetId: string, role: LinkRole, kind?: string) => Promise<void>
} {
  const live = useRef(options)
  live.current = options

  const importPaths = useCallback(async (paths: readonly string[], near?: ProjectCanvas): Promise<ProjectCanvas[]> => {
    const { project, notify } = live.current
    const projectId = project.projectId ?? (await project.saveNow())?.id ?? null
    if (!projectId) {
      notify('项目还没保存好，图片暂时放不进来', 'error')
      return []
    }
    const created: ProjectCanvas[] = []
    const failed: string[] = []
    for (const path of paths) {
      try {
        const picture = await call<ImportedPicture>(Ipc.studioImportImage, { projectId, path })
        created.push(createImageCanvas([...project.canvasesRef.current, ...created], picture, near))
      } catch (error) {
        failed.push(`${path.split(/[\\/]/).pop() ?? path}：${message(error)}`)
      }
    }
    if (failed.length) notify(`有 ${failed.length} 张图片没有放进来。${failed[0]}`, 'error')
    if (created.length) project.setCanvases((previous) => [...previous, ...created])
    return created
  }, [])

  const addFromFile = useCallback(async (targetId: string, role: LinkRole, kind?: string): Promise<void> => {
    const { project, notify } = live.current
    const target = project.canvasesRef.current.find((canvas) => canvas.id === targetId)
    if (!target) return
    let paths: string[]
    try {
      paths = await call<string[]>(Ipc.pickImages, { title: role === 'reference' ? '选择参考图' : role === 'control' ? '选择控制图' : '选择起始图' })
    } catch (error) {
      notify(message(error), 'error')
      return
    }
    const room = role === 'reference' ? Math.max(0, MAX_REFERENCES - (target.inputs?.references?.links.length ?? 0)) : 1
    if (!paths?.length || room === 0) return
    if (paths.length > room) notify(`参考图最多 ${MAX_REFERENCES} 张，只放入了前 ${room} 张`, 'info')
    const created = await importPaths(paths.slice(0, room), target)
    if (!created.length) return
    project.setCanvases((previous) => previous.map((canvas) => canvas.id === targetId
      ? created.reduce((next, image) => setLink(next, role, { canvasId: image.id }, kind), canvas)
      : canvas))
  }, [importPaths])

  return useMemo(() => ({ importPaths, addFromFile }), [importPaths, addFromFile])
}
