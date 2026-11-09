import { Box, Type, User } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ProjectCanvas, ProjectLayer, ProjectLayerKind } from '@shared/types'
import { Input, cn } from '../../components/ui'
import { pointInCanvas } from './boardLayout'
import { moveBox, regionFromDrag, regionsAtPoint, resizeFrom, type BoxHandle } from './canvases'

export const KIND_LABEL: Record<ProjectLayerKind, string> = { object: '物体', character: '人物', text: '文字' }
export const KIND_ICON: Record<ProjectLayerKind, typeof Box> = { object: Box, character: User, text: Type }
const KINDS = Object.keys(KIND_LABEL) as ProjectLayerKind[]

/** 遮罩 paints the repaint mask of the selected canvas (see MaskLayer). */
export type BoardTool = 'select' | 'pan' | 'mask'

type Box4 = [number, number, number, number]

const HANDLES: Array<{ corner: BoxHandle; className: string }> = [
  { corner: 'nw', className: '-left-1 -top-1 cursor-nwse-resize' },
  { corner: 'n', className: 'left-1/2 -top-1 -translate-x-1/2 cursor-ns-resize' },
  { corner: 'ne', className: '-right-1 -top-1 cursor-nesw-resize' },
  { corner: 'e', className: '-right-1 top-1/2 -translate-y-1/2 cursor-ew-resize' },
  { corner: 'se', className: '-right-1 -bottom-1 cursor-nwse-resize' },
  { corner: 's', className: 'left-1/2 -bottom-1 -translate-x-1/2 cursor-ns-resize' },
  { corner: 'sw', className: '-bottom-1 -left-1 cursor-nesw-resize' },
  { corner: 'w', className: '-left-1 top-1/2 -translate-y-1/2 cursor-ew-resize' },
]

/** A press that moves less than this (screen pixels) is a click, not a box. */
const DRAW_SLOP = 4

/** A region changed to another kind; a 文字 region gets its text field. */
export function withKind(layer: ProjectLayer, kind: ProjectLayerKind): ProjectLayer {
  return { ...layer, kind, text: kind === 'text' ? (layer.text ?? '') : layer.text }
}

/** What a box says on the picture: a 文字 region its text, otherwise its description. */
export function regionWords(layer: ProjectLayer): string {
  if (layer.kind === 'text' && layer.text?.trim()) return `「${layer.text.trim()}」`
  return layer.caption.trim()
}

function percentBox(bbox: Box4, canvas: Pick<ProjectCanvas, 'width' | 'height'>): React.CSSProperties {
  const [x1, y1, x2, y2] = bbox
  return {
    left: `${(x1 / canvas.width) * 100}%`,
    top: `${(y1 / canvas.height) * 100}%`,
    width: `${((x2 - x1) / canvas.width) * 100}%`,
    height: `${((y2 - y1) / canvas.height) * 100}%`,
  }
}

/**
 * Drawing a box by dragging on a 画面's face. The drag starts on the face
 * (see CanvasCard), so a press that does not move stays a click on whatever
 * is under it.
 */
export function useRegionDraw(
  canvas: ProjectCanvas,
  onDrawn: (bbox: Box4) => void,
): { box: Box4 | null; start: (event: React.PointerEvent<HTMLElement>, surface: HTMLElement | null) => void } {
  const [box, setBox] = useState<Box4 | null>(null)
  const latest = useRef({ canvas, onDrawn })
  latest.current = { canvas, onDrawn }
  const stopRef = useRef<(() => void) | null>(null)
  useEffect(() => () => stopRef.current?.(), [])

  const start = (event: React.PointerEvent<HTMLElement>, surface: HTMLElement | null): void => {
    if (event.button !== 0 || !surface) return
    stopRef.current?.()
    const pointerId = event.pointerId
    const rect = surface.getBoundingClientRect()
    const at = (next: { clientX: number; clientY: number }): [number, number] =>
      pointInCanvas({ x: next.clientX, y: next.clientY }, rect, latest.current.canvas)
    const origin = at(event)
    const startX = event.clientX
    const startY = event.clientY
    let drawing = false

    const move = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      if (!drawing && Math.hypot(next.clientX - startX, next.clientY - startY) < DRAW_SLOP) return
      drawing = true
      const point = at(next)
      setBox([Math.min(origin[0], point[0]), Math.min(origin[1], point[1]), Math.max(origin[0], point[0]), Math.max(origin[1], point[1])])
    }
    const stop = (): void => {
      stopRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      setBox(null)
    }
    const end = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      stop()
      if (!drawing || next.type !== 'pointerup') return
      // Letting go of a box is not a click on the picture under it.
      const swallow = (click: MouseEvent): void => {
        click.stopPropagation()
        click.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true), 400)
      const bbox = regionFromDrag(origin, at(next), latest.current.canvas)
      if (bbox) latest.current.onDrawn(bbox)
    }
    stopRef.current = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return { box, start }
}

type Gesture = { owner: Element; pointerId: number; id: string; start: [number, number]; origin: Box4; corner?: BoxHandle }

/**
 * The regions of a canvas over its picture, each with its type and words.
 * On the selected 画面 a box is clicked to select it, dragged to move,
 * pulled by a corner to resize, and double-clicked to edit its words.
 */
export function RegionLayer({
  canvas,
  interactive,
  selectedRegionId,
  drawing,
  planned,
  onSelectRegion,
  onChangeLayers,
  onEditRegion,
}: {
  canvas: ProjectCanvas
  interactive: boolean
  selectedRegionId: string | null
  /** The box being drawn. */
  drawing: Box4 | null
  /** Boxes the assistant's waiting plan would add: dashed, until 应用 makes them real. */
  planned?: readonly ProjectLayer[]
  onSelectRegion: (id: string | null) => void
  onChangeLayers: (update: (layers: ProjectLayer[]) => ProjectLayer[]) => void
  onEditRegion: (id: string) => void
}): React.JSX.Element {
  const surface = useRef<HTMLDivElement>(null)
  // The gesture lives in a ref so back-to-back pointer events never read a stale value.
  const gestureRef = useRef<Gesture | null>(null)
  // Where the last click landed and which box of the stack it took: clicking the
  // same spot again walks one box down, so a covered region is reachable.
  const stackPick = useRef<{ key: string; at: [number, number]; index: number } | null>(null)
  const visible = canvas.layers.filter((layer) => layer.visible !== false)

  const point = (event: React.PointerEvent): [number, number] => {
    const rect = surface.current?.getBoundingClientRect()
    return rect ? pointInCanvas({ x: event.clientX, y: event.clientY }, rect, canvas) : [0, 0]
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!interactive || event.button !== 0) return
    const target = event.target as HTMLElement
    const handle = target.closest<HTMLElement>('[data-resize-id]')
    const hit = handle?.dataset.resizeId ?? target.closest<HTMLElement>('[data-region-id]')?.dataset.regionId
    let layer = hit ? canvas.layers.find((item) => item.id === hit) : undefined
    if (!layer) return
    event.stopPropagation()

    // Overlapping boxes: a click takes the topmost one, and another click on the
    // same spot takes the next one down. Dragging a corner keeps its own box.
    if (!handle) {
      const at = point(event)
      const stack = regionsAtPoint(canvas.layers, at)
      if (stack.length > 1) {
        const previous = stackPick.current
        const key = stack.map((item) => item.id).join(',')
        const again = previous !== null && previous.key === key && Math.hypot(at[0] - previous.at[0], at[1] - previous.at[1]) < 8
        const index = again ? (previous.index + 1) % stack.length : 0
        stackPick.current = { key, at, index }
        layer = stack[index] ?? layer
      } else {
        stackPick.current = null
      }
    } else {
      stackPick.current = null
    }

    onSelectRegion(layer.id)
    if (layer.locked) return
    try {
      // Capture on the element that was hit; moves bubble back up to this surface.
      target.setPointerCapture(event.pointerId)
    } catch {
      // The pointer is already gone.
    }
    gestureRef.current = {
      owner: target,
      pointerId: event.pointerId,
      id: layer.id,
      start: point(event),
      origin: [...layer.bbox],
      corner: handle?.dataset.corner as BoxHandle | undefined,
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const at = point(event)
    const dx = at[0] - gesture.start[0]
    const dy = at[1] - gesture.start[1]
    const bbox = gesture.corner ? resizeFrom(gesture.origin, gesture.corner, dx, dy, canvas) : moveBox(gesture.origin, dx, dy, canvas)
    onChangeLayers((layers) => layers.map((layer) => (layer.id === gesture.id ? { ...layer, bbox } : layer)))
  }

  const finish = (event: React.PointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
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
      // The empty area lets presses through to the face: a drag there draws a box (see CanvasCard).
      className="pointer-events-none absolute inset-0 touch-none select-none"
    >
      {visible.map((layer) => {
        const selected = interactive && layer.id === selectedRegionId
        const words = regionWords(layer)
        const Icon = KIND_ICON[layer.kind]
        return (
          <div
            key={layer.id}
            data-region-id={layer.id}
            title={`${KIND_LABEL[layer.kind]}${words ? ` · ${words}` : ''}`}
            onDoubleClick={(event) => {
              if (!interactive) return
              event.stopPropagation()
              onEditRegion(layer.id)
            }}
            className={cn(
              'absolute rounded-[4px]',
              interactive && 'pointer-events-auto',
              selected ? 'bg-accent-soft outline-2 outline-accent' : 'bg-raised/10 outline-[1.5px] outline-ink-3',
              interactive && !layer.locked ? 'cursor-move' : 'cursor-default',
            )}
            style={{ ...percentBox(layer.bbox, canvas), opacity: Math.max(0.35, layer.opacity ?? 1) }}
          >
            <span
              data-region-words
              className="pointer-events-none absolute left-1 top-1 flex max-w-[calc(100%-8px)] items-center gap-1 rounded-[4px] bg-raised/85 px-1 py-px text-micro text-ink"
            >
              <Icon className="size-3 shrink-0 text-ink-2" aria-label={KIND_LABEL[layer.kind]} strokeWidth={1.8} />
              {words ? <span className="truncate">{words}</span> : null}
            </span>
            {selected && !layer.locked
              ? HANDLES.map(({ corner, className }) => (
                  <span
                    key={corner}
                    data-resize-id={layer.id}
                    data-corner={corner}
                    aria-hidden="true"
                    className={cn('absolute size-2.5 rounded-[2px] bg-accent', className)}
                  />
                ))
              : null}
          </div>
        )
      })}
      {planned?.map((layer) => {
        const words = regionWords(layer)
        const Icon = KIND_ICON[layer.kind]
        return (
          <div
            key={layer.id}
            data-planned-region
            title={`方案 · ${KIND_LABEL[layer.kind]}${words ? ` · ${words}` : ''}`}
            className="pointer-events-none absolute rounded-[4px] bg-accent-soft outline-[1.5px] outline-dashed outline-accent"
            style={percentBox(layer.bbox, canvas)}
          >
            <span className="absolute left-1 top-1 flex max-w-[calc(100%-8px)] items-center gap-1 rounded-[4px] bg-raised/85 px-1 py-px text-micro text-ink">
              <Icon className="size-3 shrink-0 text-accent" aria-label={KIND_LABEL[layer.kind]} strokeWidth={1.8} />
              {words ? <span className="truncate">{words}</span> : null}
            </span>
          </div>
        )
      })}
      {planned?.length ? (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-md bg-raised px-1.5 py-px text-micro font-semibold text-accent shadow-float">
          方案
        </span>
      ) : null}
      {drawing ? (
        <div
          aria-hidden="true"
          data-region-draft
          className="pointer-events-none absolute rounded-[4px] bg-accent-soft outline-2 outline-accent"
          style={percentBox(drawing, canvas)}
        />
      ) : null}
    </div>
  )
}

const PLACEHOLDER: Record<ProjectLayerKind, string> = {
  object: '这里画什么',
  character: '这个人是什么样子、在做什么',
  text: '文字的样式，例如：大号白色标题',
}

/**
 * The field on a box, under it: what goes there, and its type. Opens as soon
 * as a box is drawn (or on a double-click). Enter or a click elsewhere
 * finishes; Esc on a box just drawn and left empty takes it back.
 */
export function RegionEditor({
  layer,
  style,
  onChange,
  onDone,
}: {
  layer: ProjectLayer
  /** Where the field sits, relative to the card. */
  style: React.CSSProperties
  onChange: (layer: ProjectLayer) => void
  onDone: (cancel: boolean) => void
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const caption = useRef<HTMLInputElement>(null)
  const text = useRef<HTMLInputElement>(null)
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) done.current(false)
    }
    window.addEventListener('pointerdown', onPointer, true)
    return () => window.removeEventListener('pointerdown', onPointer, true)
  }, [])

  // The field to type into: a 文字 region's text first.
  useEffect(() => {
    requestAnimationFrame(() => (layer.kind === 'text' ? text : caption).current?.focus())
  }, [layer.kind])

  // Enter in a field finishes; Esc anywhere in the editor.
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key !== 'Escape' && !(event.key === 'Enter' && event.target instanceof HTMLInputElement)) return
    event.preventDefault()
    event.stopPropagation()
    onDone(event.key === 'Escape')
  }

  return (
    <div
      ref={root}
      data-region-editor
      data-board-ui
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
      className="absolute z-[8] flex w-[260px] origin-top-left flex-col gap-1.5 rounded-xl bg-raised p-2 shadow-float"
      style={style}
    >
      {layer.kind === 'text' ? (
        <Input
          ref={text}
          aria-label="框里的文字"
          placeholder="要显示的文字"
          value={layer.text ?? ''}
          onChange={(event) => onChange({ ...layer, text: event.target.value })}
        />
      ) : null}
      <Input
        ref={caption}
        aria-label="框里的描述"
        placeholder={PLACEHOLDER[layer.kind]}
        value={layer.caption}
        onChange={(event) => onChange({ ...layer, caption: event.target.value })}
      />
      <div role="group" aria-label="框的类型" className="flex gap-1">
        {KINDS.map((kind) => {
          const Icon = KIND_ICON[kind]
          const on = kind === layer.kind
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(withKind(layer, kind))}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-caption transition-colors',
                on ? 'bg-accent text-on-accent' : 'bg-well text-ink-2 hover:text-ink',
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" strokeWidth={1.8} />
              {KIND_LABEL[kind]}
            </button>
          )
        })}
      </div>
    </div>
  )
}
