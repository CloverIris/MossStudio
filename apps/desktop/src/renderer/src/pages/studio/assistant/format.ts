/** Plain-language names for the tools the assistant uses on the canvas. */
export const TOOL_LABELS: Record<string, string> = {
  studio_read_context: '查看画面',
  studio_set_prompt: '改写描述',
  studio_set_sampler: '调整参数',
  studio_add_layer: '添加区域',
  studio_generate: '开始生成',
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

/** One short line from a tool result: the error, or the first few fields. */
export function toolDetail(content: string): string {
  if (!content) return ''
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (typeof parsed.error === 'string') return parsed.error
    return Object.entries(parsed)
      .slice(0, 3)
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
      .join(' · ')
  } catch {
    return content.slice(0, 120)
  }
}
