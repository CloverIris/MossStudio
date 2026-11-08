import { toolByName } from '@shared/agent/registry'

/** Plain-language name of a tool, from the one place that defines it. */
export function toolLabel(name: string): string {
  return toolByName(name)?.title ?? name
}

/** One short line from a tool result: what it did, what is still missing, or the error. */
export function toolDetail(content: string): string {
  if (!content) return ''
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (typeof parsed.error === 'string') return parsed.error
    const problems = Array.isArray(parsed.problems) ? parsed.problems.filter((item): item is string => typeof item === 'string') : []
    if (typeof parsed.summary === 'string') return problems.length ? `${parsed.summary} · 还差：${problems[0]}` : parsed.summary
    if (problems.length) return `还差：${problems[0]}`
    return Object.entries(parsed)
      .slice(0, 3)
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
      .join(' · ')
  } catch {
    return content.slice(0, 120)
  }
}
