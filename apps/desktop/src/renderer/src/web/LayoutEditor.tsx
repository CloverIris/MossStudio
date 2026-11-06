import { Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { clampBox, compileLayout, draftJson, parseDraft, type LayoutDraft, type LayoutLabel } from '../lib/layout'
import { Button, Card, Field, IconButton, Input, Modal, Segmented, Textarea, cn } from '../components/ui'

const LABELS: Array<{ id: LayoutLabel; name: string }> = [
  { id: 'object', name: '物体' },
  { id: 'character', name: '人物' },
  { id: 'text', name: '文字' },
]

type Drag = { kind: 'move' | 'resize'; id: string; startX: number; startY: number; origin: [number, number, number, number] } | null

interface Props {
  draft: LayoutDraft
  onChange: (draft: LayoutDraft) => void
  onInsertPrompt: (prompt: string) => void
  onSaveProject: () => void
}

export function LayoutEditor({ draft, onChange, onInsertPrompt, onSaveProject }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<'select' | 'draw'>('draw')
  const [label, setLabel] = useState<LayoutLabel>('object')
  const [selectedId, setSelectedId] = useState<string | null>(draft.items[0]?.id ?? null)
  const [drawing, setDrawing] = useState<{ start: [number, number]; current: [number, number] } | null>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [message, setMessage] = useState('')

  const selected = draft.items.find((item) => item.id === selectedId) ?? null
  const compiled = useMemo(() => compileLayout(draft), [draft])

  function point(event: React.PointerEvent): [number, number] {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return [0, 0]
    return [
      Math.round(((event.clientX - rect.left) / rect.width) * draft.width),
      Math.round(((event.clientY - rect.top) / rect.height) * draft.height),
    ]
  }

  function down(event: React.PointerEvent): void {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    const resizeId = target.dataset.resizeId
    const boxId = target.closest<HTMLElement>('[data-box-id]')?.dataset.boxId
    canvasRef.current?.setPointerCapture(event.pointerId)
    const [x, y] = point(event)
    if (resizeId) {
      const item = draft.items.find((entry) => entry.id === resizeId)
      if (item) {
        setSelectedId(item.id)
        if (!item.locked) setDrag({ kind: 'resize', id: item.id, startX: x, startY: y, origin: [...item.bbox] })
      }
      return
    }
    if (boxId) {
      const item = draft.items.find((entry) => entry.id === boxId)
      if (item) {
        setSelectedId(item.id)
        if (!item.locked) setDrag({ kind: 'move', id: item.id, startX: x, startY: y, origin: [...item.bbox] })
      }
      return
    }
    setSelectedId(null)
    if (tool === 'draw') setDrawing({ start: [x, y], current: [x, y] })
  }

  function move(event: React.PointerEvent): void {
    if (!drawing && !drag) return
    const [x, y] = point(event)
    if (drawing) {
      setDrawing({ start: drawing.start, current: [x, y] })
      return
    }
    if (!drag) return
    const dx = x - drag.startX
    const dy = y - drag.startY
    const [x1, y1, x2, y2] = drag.origin
    const box: [number, number, number, number] =
      drag.kind === 'move' ? [x1 + dx, y1 + dy, x2 + dx, y2 + dy] : [x1, y1, Math.max(x1 + 8, x2 + dx), Math.max(y1 + 8, y2 + dy)]
    const item = draft.items.find((entry) => entry.id === drag.id)
    if (item) updateItem(item.id, { bbox: clampBox(box, draft.width, draft.height) })
  }

  function up(): void {
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
          visible: true,
          locked: false,
          opacity: 1,
        }
        onChange({ ...draft, items: [...draft.items, item] })
        setSelectedId(item.id)
        setTool('select')
      }
      setDrawing(null)
    }
    setDrag(null)
  }

  function updateItem(id: string, patch: Partial<LayoutDraft['items'][number]>): void {
    onChange({ ...draft, items: draft.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) })
  }

  function removeItem(id: string): void {
    onChange({ ...draft, items: draft.items.filter((item) => item.id !== id) })
    if (selectedId === id) setSelectedId(null)
  }

  function compileAndInsert(): void {
    const result = compileLayout(draft)
    if (!result.ok) {
      setMessage(result.errors[0] ?? '布局不完整')
      return
    }
    onInsertPrompt(result.prompt)
    setMessage('已把布局写入提示词')
  }

  function openJson(): void {
    setJsonText(draftJson(draft))
    setJsonOpen(true)
  }

  function applyJson(): void {
    const parsed = parseDraft(jsonText)
    if (!parsed) {
      setMessage('内容无法识别，请检查格式后再试')
      return
    }
    onChange(parsed)
    setSelectedId(parsed.items[0]?.id ?? null)
    setMessage('已应用到画布')
  }

  const drawBox = drawing
    ? clampBox(
        [
          Math.min(drawing.start[0], drawing.current[0]),
          Math.min(drawing.start[1], drawing.current[1]),
          Math.max(drawing.start[0], drawing.current[0]),
          Math.max(drawing.start[1], drawing.current[1]),
        ],
        draft.width,
        draft.height,
      )
    : null

  type Mode = 'select' | LayoutLabel
  const mode: Mode = tool === 'select' ? 'select' : label
  const modeOptions: Array<{ value: Mode; label: string }> = [
    { value: 'select', label: '选择' },
    ...LABELS.map((item) => ({ value: item.id as Mode, label: `+ ${item.name}` })),
  ]

  return (
    <Card tone="surface" className="flex flex-col gap-3 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-control font-medium text-ink">画面布局</div>
          <div className="mt-0.5 text-caption text-ink-2">在画布上拖出方框，标出每样东西的位置</div>
        </div>
        <Button tone="ghost" onClick={openJson}>
          查看数据
        </Button>
      </div>

      <Segmented
        block
        label="绘制工具"
        value={mode}
        options={modeOptions}
        onChange={(value) => {
          if (value === 'select') setTool('select')
          else {
            setLabel(value)
            setTool('draw')
          }
        }}
      />

      <div
        ref={canvasRef}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className="relative w-full touch-none overflow-hidden rounded-lg bg-well text-ink"
        style={{ aspectRatio: `${draft.width} / ${draft.height}` }}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              'linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)',
            backgroundSize: '12.5% 12.5%',
          }}
        />
        {draft.items.map((item) => {
          const meta = LABELS.find((entry) => entry.id === item.label) ?? LABELS[0]!
          const isSelected = selectedId === item.id
          return (
            <div
              key={item.id}
              data-box-id={item.id}
              className={cn(
                'absolute text-caption',
                item.locked ? 'cursor-not-allowed' : 'cursor-move',
                isSelected ? 'bg-accent-soft outline outline-2 outline-accent' : 'bg-well-strong',
              )}
              style={{
                left: `${(item.bbox[0] / draft.width) * 100}%`,
                top: `${(item.bbox[1] / draft.height) * 100}%`,
                width: `${((item.bbox[2] - item.bbox[0]) / draft.width) * 100}%`,
                height: `${((item.bbox[3] - item.bbox[1]) / draft.height) * 100}%`,
                opacity: item.visible === false ? 0.25 : (item.opacity ?? 1),
              }}
            >
              <span
                className={cn(
                  'pointer-events-none absolute left-1 top-1 rounded-md px-1 py-0.5 text-micro',
                  isSelected ? 'bg-accent text-on-accent' : 'bg-raised text-ink',
                )}
              >
                {meta.name}
                {item.text ? ` · ${item.text.slice(0, 10)}` : ''}
              </span>
              {!item.locked ? (
                <span
                  data-resize-id={item.id}
                  className={cn('absolute bottom-0 right-0 size-6 cursor-nwse-resize rounded-tl-lg', isSelected ? 'bg-accent' : 'bg-ink-3')}
                />
              ) : null}
            </div>
          )
        })}
        {drawBox ? (
          <div
            className="pointer-events-none absolute bg-accent-soft outline-dashed outline-2 outline-accent"
            style={{
              left: `${(drawBox[0] / draft.width) * 100}%`,
              top: `${(drawBox[1] / draft.height) * 100}%`,
              width: `${((drawBox[2] - drawBox[0]) / draft.width) * 100}%`,
              height: `${((drawBox[3] - drawBox[1]) / draft.height) * 100}%`,
            }}
          />
        ) : null}
      </div>

      <Field label="整体描述">
        <Textarea
          value={draft.summary.caption}
          onChange={(event) => onChange({ ...draft, summary: { ...draft.summary, caption: event.target.value } })}
          rows={2}
          placeholder="整张图的构图、风格和文字位置"
        />
      </Field>

      {selected ? (
        <Card tone="panel" className="flex flex-col gap-3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-ui font-medium text-ink-2">已选中：{LABELS.find((entry) => entry.id === selected.label)?.name}</span>
            <IconButton label="删除这个区域" onClick={() => removeItem(selected.id)} className="size-10 text-danger">
              <Trash2 className="size-4" strokeWidth={1.6} />
            </IconButton>
          </div>
          <Input
            value={selected.caption}
            onChange={(event) => updateItem(selected.id, { caption: event.target.value })}
            placeholder="这个区域里是什么"
            aria-label="区域描述"
          />
          {selected.label === 'text' ? (
            <Input
              value={selected.text ?? ''}
              onChange={(event) => updateItem(selected.id, { text: event.target.value })}
              placeholder="图中的文字内容"
              aria-label="图中文字"
            />
          ) : null}
          <div className="flex items-center gap-4 text-ui text-ink-2">
            <label className="inline-flex min-h-10 items-center gap-2">
              <input
                type="checkbox"
                checked={selected.visible !== false}
                onChange={(event) => updateItem(selected.id, { visible: event.target.checked })}
              />{' '}
              显示
            </label>
            <label className="inline-flex min-h-10 items-center gap-2">
              <input
                type="checkbox"
                checked={selected.locked === true}
                onChange={(event) => updateItem(selected.id, { locked: event.target.checked })}
              />{' '}
              锁定
            </label>
          </div>
        </Card>
      ) : (
        <p className="text-caption text-ink-2">在画布空白处拖动，画出一个区域。</p>
      )}

      {message ? <div className="rounded-lg bg-accent-soft px-3 py-2 text-caption text-ink">{message}</div> : null}
      {!compiled.ok ? <div className="text-caption leading-4 text-warn">{compiled.errors[0]}</div> : null}

      <div className="flex gap-2">
        <Button tone="primary" size="md" block onClick={compileAndInsert} disabled={!compiled.ok} className="h-11 flex-1">
          写入提示词
        </Button>
        <Button size="md" onClick={onSaveProject} className="h-11">
          保存
        </Button>
      </div>

      <Modal
        open={jsonOpen}
        onClose={() => setJsonOpen(false)}
        title="布局数据"
        description="高级用法：可以直接编辑后应用到画布。"
        footer={
          <>
            <Button onClick={() => void navigator.clipboard.writeText(jsonText)}>复制</Button>
            <Button onClick={applyJson}>应用到画布</Button>
            <Button tone="primary" onClick={compileAndInsert} disabled={!compiled.ok}>
              写入提示词
            </Button>
          </>
        }
      >
        <Textarea
          value={jsonText}
          onChange={(event) => setJsonText(event.target.value)}
          rows={12}
          className="font-mono text-caption"
          spellCheck={false}
          aria-label="布局数据"
        />
      </Modal>
    </Card>
  )
}
