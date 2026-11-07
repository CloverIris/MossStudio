import { Eye, EyeOff, GripVertical, Lock, LockOpen, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ProjectCanvas, ProjectLayer, ProjectLayerKind } from '@shared/types'
import { Button, ConfirmDialog, EmptyState, FieldLabel, IconButton, Input, Segmented, Textarea, cn } from '../../components/ui'
import { SliderField } from './InputControls'
import { reorderLayers } from './canvases'
import { KIND_LABEL } from './RegionLayer'

const KINDS = Object.keys(KIND_LABEL) as ProjectLayerKind[]

/** The selected region and the list of regions of the selected canvas. */
export function InspectorPanel({
  canvas,
  selectedRegionId,
  focusToken,
  onSelectRegion,
  onChangeLayers,
}: {
  canvas: ProjectCanvas | null
  selectedRegionId: string | null
  /** Changes when the user asks to edit a region (double-click on the board); focuses its caption. */
  focusToken: number
  onSelectRegion: (id: string | null) => void
  onChangeLayers: (update: (layers: ProjectLayer[]) => ProjectLayer[]) => void
}): React.JSX.Element {
  const caption = useRef<HTMLTextAreaElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    if (focusToken) requestAnimationFrame(() => caption.current?.focus())
  }, [focusToken])

  if (!canvas) return <EmptyState size="section" title="没有选中画面" description="选中一个画面后，这里显示它的区域。" />
  if (canvas.kind === 'image') {
    return <EmptyState size="section" title="导入的图片没有区域" description="把它连到画面上就能用它生成。" />
  }
  if (canvas.kind === 'result') {
    return <EmptyState size="section" title="生成结果的区域不能再改" description="复制成新画面后就可以编辑。" />
  }
  if (canvas.kind === 'style') {
    return <EmptyState size="section" title="风格没有区域" description="风格的描述和 LoRA 在左侧编辑，接着它的画面都会用上。" />
  }
  if (canvas.upscale) {
    return <EmptyState size="section" title="放大没有区域" description="放大按原图重画，不用画区域。" />
  }

  const layers = canvas.layers
  const region = layers.find((layer) => layer.id === selectedRegionId) ?? null
  const patch = (id: string, value: Partial<ProjectLayer>): void =>
    onChangeLayers((items) => items.map((item) => (item.id === id ? { ...item, ...value } : item)))

  return (
    <div className="flex flex-col gap-5">
      {region ? (
        <section aria-label="区域" className="flex flex-col gap-2.5">
          <FieldLabel as="h3">{KIND_LABEL[region.kind]}区域</FieldLabel>
          <Segmented<ProjectLayerKind>
            block
            label="区域类型"
            value={region.kind}
            onChange={(kind) => patch(region.id, { kind, text: kind === 'text' ? (region.text ?? '') : region.text })}
            options={KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }))}
          />
          <Textarea
            ref={caption}
            aria-label="区域描述"
            value={region.caption}
            onChange={(event) => patch(region.id, { caption: event.target.value })}
            placeholder={
              region.kind === 'character'
                ? '这个人是什么样子、在做什么'
                : region.kind === 'text'
                  ? '文字的样式，例如：大号白色标题'
                  : '这里画什么'
            }
            className="h-[92px] resize-none"
          />
          {region.kind === 'text' ? (
            <Input
              aria-label="要显示的文字"
              value={region.text ?? ''}
              onChange={(event) => patch(region.id, { text: event.target.value })}
              placeholder="要显示的文字"
            />
          ) : null}
          <SliderField
            label="不透明度"
            min={0.1}
            max={1}
            step={0.05}
            value={region.opacity ?? 1}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(opacity) => patch(region.id, { opacity })}
          />
          <div className="flex items-center gap-1">
            <IconButton
              label={region.locked ? '解锁区域' : '锁定区域'}
              aria-pressed={region.locked}
              onClick={() => patch(region.id, { locked: !region.locked })}
            >
              {region.locked ? <Lock className="size-4" strokeWidth={1.6} /> : <LockOpen className="size-4" strokeWidth={1.6} />}
            </IconButton>
            <IconButton
              label={region.visible === false ? '显示区域' : '隐藏区域'}
              aria-pressed={region.visible === false}
              onClick={() => patch(region.id, { visible: region.visible === false })}
            >
              {region.visible === false ? <EyeOff className="size-4" strokeWidth={1.6} /> : <Eye className="size-4" strokeWidth={1.6} />}
            </IconButton>
            <span className="flex-1" />
            <Button tone="ghost-danger" size="xs" onClick={() => setRemoving(region.id)}>
              <Trash2 className="size-3.5" strokeWidth={1.6} />
              删除
            </Button>
          </div>
        </section>
      ) : (
        <p className="rounded-lg bg-well px-3 py-2.5 text-caption text-ink-2">
          用工具栏的「画框」在画面上拖出一个框，就能告诉模型哪里画什么。
        </p>
      )}

      <section aria-label="图层" className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between pb-2">
          <FieldLabel as="h3">图层</FieldLabel>
          {layers.length ? (
            <Button tone="ghost-danger" size="xs" className="-mr-2" onClick={() => setClearing(true)}>
              清空
            </Button>
          ) : null}
        </div>
        {layers.length === 0 ? <p className="text-caption text-ink-2">还没有区域。</p> : null}
        <ul className="flex flex-col gap-0.5">
          {layers.map((layer, index) => (
            <li
              key={layer.id}
              data-layer-id={layer.id}
              draggable
              onDragStart={(event) => {
                if ((event.target as HTMLElement).closest('button:not([data-layer-select])')) {
                  event.preventDefault()
                  return
                }
                setDragId(layer.id)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', layer.id)
              }}
              onDragOver={(event) => {
                if (!dragId || dragId === layer.id) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropId(layer.id)
              }}
              onDragLeave={() => setDropId((current) => (current === layer.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault()
                if (dragId && dragId !== layer.id) onChangeLayers((items) => reorderLayers(items, dragId, layer.id))
                setDragId(null)
                setDropId(null)
              }}
              onDragEnd={() => {
                setDragId(null)
                setDropId(null)
              }}
              className={cn(
                'group relative flex h-9 items-center gap-2 rounded-md pl-1 pr-1 text-ui transition-colors',
                layer.id === selectedRegionId ? 'bg-well' : 'hover:bg-well',
                dragId === layer.id && 'opacity-40',
                dropId === layer.id && 'bg-accent-soft',
              )}
            >
              <GripVertical className="size-3.5 shrink-0 cursor-grab text-ink-3" aria-hidden="true" strokeWidth={1.6} />
              <button
                type="button"
                data-layer-select
                aria-current={layer.id === selectedRegionId ? 'true' : undefined}
                onClick={() => onSelectRegion(layer.id)}
                className={cn('flex min-w-0 flex-1 items-center gap-2.5 text-left', layer.visible === false && 'text-ink-3')}
              >
                <span className="tabular w-4 shrink-0 text-caption text-ink-2">{index + 1}</span>
                <span className="shrink-0 px-1 text-micro text-ink-2">{KIND_LABEL[layer.kind]}</span>
                <span className="min-w-0 flex-1 truncate">{layer.caption || layer.text || '还没有描述'}</span>
              </button>
              {layer.locked ? <Lock className="size-3.5 shrink-0 text-ink-2" aria-label="已锁定" strokeWidth={1.6} /> : null}
              <IconButton
                label={layer.visible === false ? `显示区域 ${index + 1}` : `隐藏区域 ${index + 1}`}
                className="size-7"
                onClick={() => patch(layer.id, { visible: layer.visible === false })}
              >
                {layer.visible === false ? (
                  <EyeOff className="size-3.5" strokeWidth={1.6} />
                ) : (
                  <Eye className="size-3.5" strokeWidth={1.6} />
                )}
              </IconButton>
            </li>
          ))}
        </ul>
        {layers.length > 1 ? <p className="pt-2 text-caption text-ink-2">拖动调整顺序；排在前面的区域先被描述。</p> : null}
      </section>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="删除这个区域？"
        description="区域和它的描述都会删除，画面的其他区域不受影响。"
        confirmLabel="删除区域"
        onConfirm={() => {
          onChangeLayers((items) => items.filter((item) => item.id !== removing))
          onSelectRegion(null)
          setRemoving(null)
        }}
      />
      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        title="清空所有区域？"
        description={`这个画面的 ${layers.length} 个区域都会删除，描述和底图会保留。`}
        confirmLabel="清空区域"
        onConfirm={() => {
          onChangeLayers(() => [])
          onSelectRegion(null)
          setClearing(false)
        }}
      />
    </div>
  )
}
