import { ArrowDown, ArrowUp, Pin, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Input, Modal } from './ui'

type Color = 'blue' | 'rose' | 'violet' | 'amber' | 'slate'

interface Segment {
  id: string
  text: string
  pinned: boolean
  color: Color
}

const COLORS: Record<Color, string> = {
  blue: '#8ab6ff',
  rose: '#f0a6b8',
  violet: '#b6a4f5',
  amber: '#f3cf8a',
  slate: '#9aa6b8',
}

function parse(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.includes('\n')) return trimmed.split(/\n+/).map((item) => item.trim()).filter(Boolean)
  return trimmed.split(/\s*[,，]\s*/).map((item) => item.trim()).filter(Boolean)
}

function guessColor(text: string): Color {
  if (/光|light|shadow|sun/i.test(text)) return 'rose'
  if (/构图|angle|shot|composition|frame/i.test(text)) return 'violet'
  if (/文字|text|title|logo|caption/i.test(text)) return 'amber'
  if (/主体|subject|character|object/i.test(text)) return 'blue'
  return 'slate'
}

export function PromptSegmentsModal({
  open,
  value,
  onClose,
  onApply,
}: {
  open: boolean
  value: string
  onClose: () => void
  onApply: (prompt: string) => void
}): React.JSX.Element {
  const [segments, setSegments] = useState<Segment[]>([])

  useEffect(() => {
    if (!open) return
    setSegments(parse(value).map((text, index) => ({
      id: `seg-${index}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      pinned: false,
      color: guessColor(text),
    })))
  }, [open, value])

  function update(id: string, patch: Partial<Segment>): void {
    setSegments((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function move(id: string, direction: -1 | 1): void {
    setSegments((current) => {
      const index = current.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item!)
      return next
    })
  }

  function apply(): void {
    const ordered = [...segments].sort((a, b) => Number(b.pinned) - Number(a.pinned))
    onApply(ordered.map((item) => item.text.trim()).filter(Boolean).join(', '))
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="提示词分段"
      description="每一段可单独编辑、着色、固定和排序；应用后合并为一条 Prompt。"
      width="max-w-3xl"
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>取消</Button>
          <Button tone="primary" onClick={apply}>应用分段</Button>
        </>
      }
    >
      <div className="space-y-2 p-4">
        {segments.map((segment, index) => (
          <div key={segment.id} className="flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] p-2" style={{ borderLeft: `3px solid ${COLORS[segment.color]}` }}>
            <span className="w-5 shrink-0 text-center text-caption font-mono text-[var(--color-text-tertiary)]">{index + 1}</span>
            <Input value={segment.text} onChange={(event) => update(segment.id, { text: event.target.value })} className="min-w-0 flex-1" />
            <select
              value={segment.color}
              onChange={(event) => update(segment.id, { color: event.target.value as Color })}
              className="h-7 rounded border border-[var(--color-border-subtle)] bg-transparent px-1 text-caption text-[var(--color-text-tertiary)]"
              aria-label="分段颜色"
            >
              {(Object.keys(COLORS) as Color[]).map((color) => <option key={color} value={color}>{color}</option>)}
            </select>
            <button type="button" className={`rounded p-1 ${segment.pinned ? 'text-accent-300' : 'text-[var(--color-text-tertiary)]'}`} onClick={() => update(segment.id, { pinned: !segment.pinned })} title="固定到前面"><Pin className="size-4" /></button>
            <button type="button" className="rounded p-1 text-[var(--color-text-tertiary)]" onClick={() => move(segment.id, -1)}><ArrowUp className="size-4" /></button>
            <button type="button" className="rounded p-1 text-[var(--color-text-tertiary)]" onClick={() => move(segment.id, 1)}><ArrowDown className="size-4" /></button>
            <button type="button" className="rounded p-1 text-red-300" onClick={() => setSegments((current) => current.filter((item) => item.id !== segment.id))}><Trash2 className="size-4" /></button>
          </div>
        ))}
        <Button tone="ghost" onClick={() => setSegments((current) => [...current, { id: `seg-${Date.now()}`, text: '', pinned: false, color: 'slate' }])}>
          <span className="inline-flex items-center gap-1"><Plus className="size-4" /> 添加分段</span>
        </Button>
      </div>
    </Modal>
  )
}
