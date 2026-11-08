import { toolByName } from '@shared/agent/registry'

/** Plain-language name of a tool, from the one place that defines it. */
export function toolLabel(name: string): string {
  return toolByName(name)?.title ?? name
}

/** Long tool payloads (a whole canvas list) are summarised, never dumped. */
function summarize(parsed: Record<string, unknown>): string {
  if (Array.isArray(parsed.canvases)) {
    const selected = parsed.selected as { title?: unknown } | null | undefined
    const title = typeof selected?.title === 'string' ? selected.title : ''
    return title ? `${parsed.canvases.length} 个画面 · 当前「${title}」` : `${parsed.canvases.length} 个画面`
  }
  if (Array.isArray(parsed.created)) return `新建 ${parsed.created.length} 个画面`
  if (Array.isArray(parsed.layers)) return `${parsed.layers.length} 个区域`
  return ''
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** One short line from a tool result: what it did, what is still missing, or the error. */
export function toolDetail(content: string): string {
  if (!content) return ''
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (typeof parsed.error === 'string') return parsed.error
    const problems = Array.isArray(parsed.problems) ? parsed.problems.filter((item): item is string => typeof item === 'string') : []
    if (typeof parsed.summary === 'string') return clip(problems.length ? `${parsed.summary} · 还差：${problems[0]}` : parsed.summary, 120)
    if (problems.length) return clip(`还差：${problems[0]}`, 120)
    // A write the advanced mode held back: it is a plan step, not a result.
    const proposed = parsed.proposed as { label?: unknown } | undefined
    if (proposed && typeof proposed === 'object') {
      return clip(typeof proposed.label === 'string' ? `已加入方案：${proposed.label}` : '已加入方案，等你确认', 120)
    }
    const overview = summarize(parsed)
    if (overview) return overview
    return clip(
      Object.entries(parsed)
        .slice(0, 3)
        .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
        .join(' · '),
      120,
    )
  } catch {
    return clip(content, 120)
  }
}

/** The headline of a trace: one tool by name, several by count. */
export function traceHeadline(names: readonly string[]): string {
  if (names.length === 0) return '执行中'
  if (names.length === 1) return toolLabel(names[0]!)
  return `执行了 ${names.length} 步 · ${toolLabel(names[0]!)} 等`
}
