export type LayoutLabel = 'object' | 'character' | 'text'
export type LayoutCanvas = 'single' | 'multi_panel' | 'collage'

export interface LayoutItemDraft {
  id: string
  label: LayoutLabel
  caption: string
  text?: string
  bbox: [number, number, number, number]
  visible?: boolean
  locked?: boolean
  opacity?: number
}

export interface LayoutDraft {
  width: number
  height: number
  summary: {
    caption: string
    meta: string[]
    canvas: LayoutCanvas
  }
  items: LayoutItemDraft[]
}

export interface CompileResult {
  ok: boolean
  errors: string[]
  prompt: string
  preview: string
}

export function createDraft(width = 1024, height = 1024): LayoutDraft {
  return {
    width,
    height,
    summary: {
      caption: '',
      meta: [],
      canvas: 'single',
    },
    items: [],
  }
}

export function exampleDraft(): LayoutDraft {
  return {
    width: 1024,
    height: 1024,
    summary: {
      caption: 'A minimalist travel poster with a cream background, a blue mountain illustration, and the title EXPLORE at the top.',
      meta: ['poster'],
      canvas: 'single',
    },
    items: [
      {
        id: 'item-text',
        label: 'text',
        caption: 'Large dark-blue uppercase title centered at the top.',
        text: 'EXPLORE',
        bbox: [128, 96, 896, 224],
      },
      {
        id: 'item-mountain',
        label: 'object',
        caption: 'A flat blue mountain illustration in the lower center.',
        bbox: [224, 320, 800, 896],
      },
    ],
  }
}

export function clampBox(box: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  const [x1, y1, x2, y2] = box
  const left = Math.max(0, Math.min(width - 1, Math.min(x1, x2)))
  const top = Math.max(0, Math.min(height - 1, Math.min(y1, y2)))
  const right = Math.max(left + 1, Math.min(width, Math.max(x1, x2)))
  const bottom = Math.max(top + 1, Math.min(height, Math.max(y1, y2)))
  return [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)]
}

function centeredBox(box: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  const [x1, y1, x2, y2] = box
  return [
    Math.floor(Math.round(y1)) - Math.floor(height / 2),
    Math.floor(Math.round(x1)) - Math.floor(width / 2),
    Math.ceil(Math.round(y2)) - Math.floor(height / 2),
    Math.ceil(Math.round(x2)) - Math.floor(width / 2),
  ]
}

export function compileLayout(draft: LayoutDraft): CompileResult {
  const errors: string[] = []
  if (!Number.isInteger(draft.width) || draft.width <= 0 || draft.width % 16 !== 0) {
    errors.push('画面宽度需要是 16 的倍数')
  }
  if (!Number.isInteger(draft.height) || draft.height <= 0 || draft.height % 16 !== 0) {
    errors.push('画面高度需要是 16 的倍数')
  }
  if (!draft.summary.caption.trim()) errors.push('先写一句整体描述')
  if (draft.items.length === 0) errors.push('至少需要一个区域')
  for (const [index, item] of draft.items.entries()) {
    if (item.visible === false) continue
    if (!item.caption.trim()) errors.push(`区域 ${index + 1} 还没有描述`)
    if (item.label === 'text' && !item.text?.trim()) errors.push(`文字区域 ${index + 1} 还没有填写要显示的文字`)
    const [x1, y1, x2, y2] = item.bbox
    if (x1 < 0 || y1 < 0 || x2 > draft.width || y2 > draft.height || x1 >= x2 || y1 >= y2) {
      errors.push(`区域 ${index + 1} 超出了画面`)
    }
  }
  if (errors.length) return { ok: false, errors, prompt: '', preview: '' }

  const summary: Record<string, unknown> = { caption: draft.summary.caption.trim() }
  if (draft.summary.meta.filter(Boolean).length) {
    summary.meta = draft.summary.meta.map((item) => item.trim()).filter(Boolean)
  }
  summary.canvas = draft.summary.canvas

  const items = draft.items
    .filter((item) => item.visible !== false)
    .map((item) => {
      const compiled: Record<string, unknown> = {
        label: item.label,
        caption: item.caption.trim(),
        bbox: centeredBox(item.bbox, draft.width, draft.height),
      }
      if (item.label === 'text' && item.text) compiled.text = item.text
      return compiled
    })

  const payload = {
    summary,
    items,
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
  }
  const prompt = JSON.stringify(payload)
  return { ok: true, errors: [], prompt, preview: JSON.stringify(payload, null, 2) }
}

export function draftJson(draft: LayoutDraft): string {
  return JSON.stringify(
    {
      width: draft.width,
      height: draft.height,
      bbox_coord_space: 'abs',
      bbox_format: 'xyxy',
      summary: draft.summary,
      items: draft.items.map(({ id: _id, ...item }) => item),
    },
    null,
    2,
  )
}

export function parseDraft(text: string): LayoutDraft | null {
  try {
    const raw = JSON.parse(text) as {
      width: number
      height: number
      summary: LayoutDraft['summary']
      items: Array<Omit<LayoutItemDraft, 'id'>>
    }
    if (!raw.width || !raw.height || !Array.isArray(raw.items)) return null
    return {
      width: raw.width,
      height: raw.height,
      summary: {
        caption: raw.summary?.caption ?? '',
        meta: Array.isArray(raw.summary?.meta) ? raw.summary.meta : [],
        canvas: raw.summary?.canvas ?? 'single',
      },
      items: raw.items.map((item, index) => ({
        ...item,
        id: `import-${index}-${Math.random().toString(36).slice(2, 7)}`,
        bbox: clampBox(item.bbox, raw.width, raw.height),
      })),
    }
  } catch {
    return null
  }
}
