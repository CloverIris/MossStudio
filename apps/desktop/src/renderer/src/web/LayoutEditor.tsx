import { Copy, Download, Plus, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import {
  clampBox,
  compileLayout,
  draftJson,
  parseDraft,
  type LayoutDraft,
  type LayoutLabel,
} from '../lib/layout'

const LABELS: Array<{ id: LayoutLabel; name: string; color: string }> = [
  { id: 'object', name: '物体', color: '#8ab6ff' },
  { id: 'character', name: '人物', color: '#b7d2ff' },
  { id: 'text', name: '文字', color: '#f3cf8a' },
]

type Drag =
  | { kind: 'move' | 'resize'; id: string; startX: number; startY: number; origin: [number, number, number, number] }
  | null

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
      drag.kind === 'move'
        ? [x1 + dx, y1 + dy, x2 + dx, y2 + dy]
        : [x1, y1, Math.max(x1 + 8, x2 + dx), Math.max(y1 + 8, y2 + dy)]
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

  function setSize(width: number, height: number): void {
    onChange({
      ...draft,
      width,
      height,
      items: draft.items.map((item) => ({ ...item, bbox: clampBox(item.bbox, width, height) })),
    })
  }

  function compileAndInsert(): void {
    const result = compileLayout(draft)
    if (!result.ok) {
      setMessage(result.errors[0] ?? '布局不完整')
      return
    }
    onInsertPrompt(result.prompt)
    setMessage('布局 JSON 已插入提示词')
  }

  function openJson(): void {
    setJsonText(draftJson(draft))
    setJsonOpen(true)
  }

  function applyJson(): void {
    const parsed = parseDraft(jsonText)
    if (!parsed) {
      setMessage('JSON 解析失败：检查 width/height/items/bbox')
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

  return (
    <section className="mt-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-ui font-medium">布局编辑器 · Layout JSON</div>
          <div className="mt-0.5 text-caption text-[var(--color-text-tertiary)]">拖拽框选区域；生成前编译为官方 layout JSON</div>
        </div>
        <button type="button" className="text-caption text-accent-300" onClick={openJson}>JSON</button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setTool('select')} className={`rounded px-2 py-1 text-caption ${tool === 'select' ? 'bg-accent-500/20 text-accent-200' : 'bg-white/[0.04] text-[var(--color-text-secondary)]'}`}>选择</button>
        {LABELS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => { setLabel(item.id); setTool('draw') }}
            className={`rounded px-2 py-1 text-caption ${tool === 'draw' && label === item.id ? 'bg-accent-500/20 text-accent-200' : 'bg-white/[0.04] text-[var(--color-text-secondary)]'}`}
          >
            + {item.name}
          </button>
        ))}
        <button type="button" onClick={() => setSize(1024, 1024)} className="ml-auto rounded bg-white/[0.04] px-2 py-1 text-caption text-[var(--color-text-tertiary)]">1024²</button>
        <button type="button" onClick={() => setSize(768, 1024)} className="rounded bg-white/[0.04] px-2 py-1 text-caption text-[var(--color-text-tertiary)]">3:4</button>
        <button type="button" onClick={() => setSize(1024, 768)} className="rounded bg-white/[0.04] px-2 py-1 text-caption text-[var(--color-text-tertiary)]">4:3</button>
      </div>

      <div
        ref={canvasRef}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className="relative mt-2 w-full touch-none overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[#11151b]"
        style={{ aspectRatio: `${draft.width} / ${draft.height}` }}
      >
        <div className="pointer-events-none absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.18) 1px, transparent 1px)', backgroundSize: '12.5% 12.5%' }} />
        {draft.items.map((item) => {
          const meta = LABELS.find((entry) => entry.id === item.label) ?? LABELS[0]!
          return (
            <div
              key={item.id}
              data-box-id={item.id}
              className={`absolute cursor-move border text-caption ${item.locked ? 'cursor-not-allowed' : ''} ${selectedId === item.id ? 'ring-2 ring-white/50' : ''}`}
              style={{
                left: `${(item.bbox[0] / draft.width) * 100}%`,
                top: `${(item.bbox[1] / draft.height) * 100}%`,
                width: `${((item.bbox[2] - item.bbox[0]) / draft.width) * 100}%`,
                height: `${((item.bbox[3] - item.bbox[1]) / draft.height) * 100}%`,
                borderColor: meta.color,
                background: `${meta.color}18`,
                opacity: item.visible === false ? 0.25 : item.opacity ?? 1,
              }}
            >
              <span className="pointer-events-none absolute left-1 top-1 rounded px-1 py-0.5 text-micro" style={{ background: meta.color, color: '#10141c' }}>
                {meta.name}{item.text ? ` · ${item.text.slice(0, 10)}` : ''}
              </span>
              {!item.locked ? (
                <span
                  data-resize-id={item.id}
                  className="absolute bottom-0 right-0 size-4 cursor-nwse-resize"
                  style={{ background: `linear-gradient(135deg, transparent 45%, ${meta.color} 45%)` }}
                />
              ) : null}
            </div>
          )
        })}
        {drawBox ? (
          <div
            className="pointer-events-none absolute border border-dashed border-accent-300 bg-accent-500/10"
            style={{ left: `${(drawBox[0] / draft.width) * 100}%`, top: `${(drawBox[1] / draft.height) * 100}%`, width: `${((drawBox[2] - drawBox[0]) / draft.width) * 100}%`, height: `${((drawBox[3] - drawBox[1]) / draft.height) * 100}%` }}
          />
        ) : null}
      </div>

      <label className="mt-2 block space-y-1">
        <span className="text-caption text-[var(--color-text-tertiary)]">总览描述 summary.caption</span>
        <textarea value={draft.summary.caption} onChange={(event) => onChange({ ...draft, summary: { ...draft.summary, caption: event.target.value } })} rows={2} className="app-input w-full" placeholder="整张图的构图/风格/文字布局总览" />
      </label>

      {selected ? (
        <div className="mt-2 space-y-2 rounded-lg border border-[var(--color-border-subtle)] p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-caption text-[var(--color-text-secondary)]">选中：{LABELS.find((entry) => entry.id === selected.label)?.name}</span>
            <button type="button" onClick={() => removeItem(selected.id)} className="text-red-300"><Trash2 className="size-4" /></button>
          </div>
          <input value={selected.caption} onChange={(event) => updateItem(selected.id, { caption: event.target.value })} className="app-input w-full" placeholder="区域描述（生成用）" />
          {selected.label === 'text' ? (
            <input value={selected.text ?? ''} onChange={(event) => updateItem(selected.id, { text: event.target.value })} className="app-input w-full" placeholder="图中的文字内容" />
          ) : null}
          <div className="flex items-center gap-3 text-caption text-[var(--color-text-tertiary)]">
            <label className="inline-flex items-center gap-1"><input type="checkbox" checked={selected.visible !== false} onChange={(event) => updateItem(selected.id, { visible: event.target.checked })} /> 可见</label>
            <label className="inline-flex items-center gap-1"><input type="checkbox" checked={selected.locked === true} onChange={(event) => updateItem(selected.id, { locked: event.target.checked })} /> 锁定</label>
            <button type="button" className="ml-auto text-accent-300" onClick={compileAndInsert}>插入 Prompt</button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between text-caption text-[var(--color-text-tertiary)]">
          <span>点画布空白处开始框选</span>
          <button type="button" className="text-accent-300" onClick={compileAndInsert} disabled={!compiled.ok}>插入 Prompt</button>
        </div>
      )}

      {message ? <div className="mt-2 rounded bg-accent-500/10 px-2 py-1.5 text-caption text-accent-200">{message}</div> : null}
      {!compiled.ok ? <div className="mt-1 text-caption leading-4 text-amber-300">{compiled.errors[0]}</div> : null}

      <div className="mt-2 flex gap-2">
        <button type="button" onClick={openJson} className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-[var(--color-border-subtle)] px-2 py-1.5 text-caption text-[var(--color-text-secondary)]"><Copy className="size-4" /> JSON</button>
        <button type="button" onClick={compileAndInsert} disabled={!compiled.ok} className="app-button-primary flex-1 disabled:opacity-40">插入 Prompt</button>
        <button type="button" onClick={onSaveProject} className="inline-flex items-center justify-center gap-1 rounded border border-[var(--color-border-subtle)] px-2 py-1.5 text-caption text-[var(--color-text-secondary)]"><Download className="size-4" /> 保存</button>
      </div>

      {jsonOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center" onClick={() => setJsonOpen(false)}>
          <div className="w-full max-w-[680px] rounded-xl border border-[var(--color-border)] bg-[#1b2028] p-3 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <span className="text-ui font-medium">Layout JSON</span>
              <button type="button" onClick={() => setJsonOpen(false)} className="text-caption text-[var(--color-text-tertiary)]">关闭</button>
            </div>
            <textarea value={jsonText} onChange={(event) => setJsonText(event.target.value)} rows={12} className="app-input mt-2 w-full font-mono text-caption" spellCheck={false} />
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => void navigator.clipboard.writeText(jsonText)} className="flex-1 rounded border border-[var(--color-border-subtle)] px-2 py-1.5 text-caption text-[var(--color-text-secondary)]">复制</button>
              <button type="button" onClick={applyJson} className="app-button-primary flex-1">应用到画布</button>
              <button type="button" onClick={compileAndInsert} disabled={!compiled.ok} className="app-button-primary flex-1 disabled:opacity-40">插入 Prompt</button>
            </div>
            <p className="mt-2 text-caption leading-4 text-[var(--color-text-tertiary)]">
              编辑的是可导入草稿（width/height/summary/items）；插入 Prompt 时会编译成官方 abs_centralized + yxyx。
            </p>
          </div>
        </div>
      ) : null}
    </section>
  )
}
