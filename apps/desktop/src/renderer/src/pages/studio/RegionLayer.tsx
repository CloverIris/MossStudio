import { useRef, useState } from 'react'
import type { ProjectCanvas, ProjectLayer, ProjectLayerKind } from '@shared/types'
import { cn } from '../../components/ui'
import { pointInCanvas } from './boardLayout'
import { moveBox, newRegion, regionFromDrag, resizeBox } from './canvases'

export const KIND_LABEL: Record<ProjectLayerKind, string> = { object: '物体', character: '人物', text: '文字' }

/** 遮罩 paints the repaint mask of the selected canvas (see MaskLayer). */
export type BoardTool = 'select' | 'draw' | 'pan' | 'mask'

type Gesture = { owner: Element } & (
  | { kind: 'draw'; pointerId: number; start: [number, number]; current: [number, number] }
  | { kind: 'move' | 'resize'; pointerId: number; id: string; start: [number, number]; origin: [number, number, number, number] }
)

function percentBox(bbox: [number, number, number, number], canvas: Pick<ProjectCanvas, 'width' | 'height'>): React.CSSProperties {
  const [x1, y1, x2, y2] = bbox
  return {
    left: `${(x1 / canvas.width) * 100}%`,
    top: `${(y1 / canvas.height) * 100}%`,
    width: `${((x2 - x1) / canvas.width) * 100}%`,
    height: `${((y2 - y1) / canvas.height) * 100}%`,
  }
}

/**
 * The regions of a canvas drawn over its picture. Interactive only on the
 * selected layout canvas: draw a box with 画框, move or resize with 选择.
 */
export function RegionLayer({
  canvas,
  interactive,
  tool,
  regionKind,
  selectedRegionId,
  onSelectRegion,
  onChangeLayers,
  onRegionDrawn,
  onOpenRegion,
}: {
  canvas: ProjectCanvas
  interactive: boolean
  tool: BoardTool
  regionKind: ProjectLayerKind
  selectedRegionId: string | null
  onSelectRegion: (id: string | null) => void
  onChangeLayers: (update: (layers: ProjectLayer[]) => ProjectLayer[]) => void
  onRegionDrawn: (id: string) => void
  onOpenRegion: (id: string) => void
}): React.JSX.Element {
  const surface = useRef<HTMLDivElement>(null)
  // The gesture lives in a ref so back-to-back pointer events never read a stale
  // value; `preview` is only the rectangle drawn while dragging.
  const gestureRef = useRef<Gesture | null>(null)
  const [preview, setPreview] = useState<[number, number, number, number] | null>(null)
  const visible = canvas.layers.filter((layer) => layer.visible !== false)

  const point = (event: React.PointerEvent): [number, number] => {
    const rect = surface.current?.getBoundingClientRect()
    return rect ? pointInCanvas({ x: event.clientX, y: event.clientY }, rect, canvas) : [0, 0]
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!interactive || event.button !== 0 || tool === 'pan') return
    const target = event.target as HTMLElement
    const resizeId = target.closest<HTMLElement>('[data-resize-id]')?.dataset.resizeId
    const boxId = target.closest<HTMLElement>('[data-region-id]')?.dataset.regionId
    const at = point(event)
    // Capture on the element that was hit; moves bubble back up to this surface.
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      // The pointer is already gone (e.g. released before this handler ran).
    }
    if (resizeId || boxId) {
      const layer = canvas.layers.find((item) => item.id === (resizeId ?? boxId))
      if (!layer) return
      event.stopPropagation()
      onSelectRegion(layer.id)
      if (layer.locked) return
      gestureRef.current = { owner: target, kind: resizeId ? 'resize' : 'move', pointerId: event.pointerId, id: layer.id, start: at, origin: [...layer.bbox] }
      return
    }
    if (tool !== 'draw') return
    event.stopPropagation()
    onSelectRegion(null)
    gestureRef.current = { owner: target, kind: 'draw', pointerId: event.pointerId, start: at, current: at }
    setPreview([at[0], at[1], at[0], at[1]])
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const at = point(event)
    if (gesture.kind === 'draw') {
      gesture.current = at
      setPreview([Math.min(gesture.start[0], at[0]), Math.min(gesture.start[1], at[1]), Math.max(gesture.start[0], at[0]), Math.max(gesture.start[1], at[1])])
      return
    }
    const dx = at[0] - gesture.start[0]
    const dy = at[1] - gesture.start[1]
    const bbox = gesture.kind === 'move' ? moveBox(gesture.origin, dx, dy, canvas) : resizeBox(gesture.origin, dx, dy, canvas)
    onChangeLayers((layers) => layers.map((layer) => layer.id === gesture.id ? { ...layer, bbox } : layer))
  }

  const finish = (event: React.PointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    setPreview(null)
    if (gesture.kind === 'draw') {
      const bbox = regionFromDrag(gesture.start, point(event), canvas)
      if (bbox) {
        const region = newRegion(regionKind, bbox)
        onChangeLayers((layers) => [...layers, region])
        onRegionDrawn(region.id)
      }
    }
    if (gesture.owner.hasPointerCapture(event.pointerId)) gesture.owner.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      ref={surface}
      data-region-surface
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      // Only 画框 needs the empty area; otherwise clicks fall through to the picture.
      className={cn('absolute inset-0 touch-none select-none', interactive && tool === 'draw' ? 'cursor-crosshair' : 'pointer-events-none')}
    >
      {visible.map((layer) => {
        const selected = interactive && layer.id === selectedRegionId
        return (
          <div
            key={layer.id}
            data-region-id={layer.id}
            title={`${KIND_LABEL[layer.kind]} · ${layer.caption || '还没有描述'}`}
            onDoubleClick={(event) => { if (interactive) { event.stopPropagation(); onOpenRegion(layer.id) } }}
            className={cn(
              'absolute rounded-[3px]',
              interactive && tool !== 'pan' && 'pointer-events-auto',
              selected ? 'outline-2 outline-accent' : 'outline-[1.5px] outline-dashed outline-ink-3',
              interactive && !layer.locked && tool !== 'pan' ? 'cursor-move' : 'cursor-default',
            )}
            style={{ ...percentBox(layer.bbox, canvas), opacity: Math.max(0.35, layer.opacity ?? 1) }}
          >
            {selected ? (
              <span className="pointer-events-none absolute -left-0.5 -top-6 max-w-[220px] truncate rounded-[4px] bg-ink px-1.5 py-0.5 text-micro text-on-ink">
                {KIND_LABEL[layer.kind]} · {layer.caption || '还没有描述'}
              </span>
            ) : null}
            {layer.kind === 'text' && layer.text ? (
              <span className="pointer-events-none absolute inset-1 overflow-hidden text-micro text-ink">{layer.text}</span>
            ) : null}
            {selected && !layer.locked ? (
              <span data-resize-id={layer.id} aria-hidden="true" className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-[3px] bg-accent" />
            ) : null}
          </div>
        )
      })}
      {preview ? (
        <div aria-hidden="true" className="pointer-events-none absolute rounded-[3px] bg-accent-soft outline-2 outline-accent" style={percentBox(preview, canvas)} />
      ) : null}
    </div>
  )
}
