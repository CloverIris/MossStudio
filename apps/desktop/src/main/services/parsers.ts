import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Diagnostic, DiagnosticSolution, JobProgress, JobStage } from '@shared/types'
import { contentDir } from '../lib/content'

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

export class LineSplitter {
  private buffer = ''

  push(chunk: string): string[] {
    const text = this.buffer + chunk
    const parts = text.split(/\r\n|\n|\r/)
    this.buffer = parts.pop() ?? ''
    return parts.filter((part) => part.trim().length > 0)
  }

  flush(): string[] {
    const rest = this.buffer
    this.buffer = ''
    return rest.trim() ? [rest] : []
  }
}

export interface ParsedProgress {
  percent: number
  current: number
  total: number
  etaMs?: number
  rate?: string
  label?: string
}

const TQDM =
  /^\s*(?<pct>\d{1,3})%\|.*?\|\s*(?<cur>\d+)\/(?<total>\d+)\s*\[(?<elapsed>[^<\]]*)<(?<eta>[^,\]]*)(?:,\s*(?<rate>[^\]]*))?\]/

const DOWNLOAD =
  /^(?<label>.+?):\s*(?<pct>\d{1,3})%\|.*?\|\s*(?<cur>[\d.]+[KMG]?i?B?)\/(?<total>[\d.]+[KMG]?i?B?)/i

function etaToMs(value: string): number | undefined {
  const parts = value.trim().split(':').map((part) => Number.parseInt(part, 10))
  if (parts.some((part) => Number.isNaN(part))) return undefined
  if (parts.length === 2) return (parts[0]! * 60 + parts[1]!) * 1000
  if (parts.length === 3) return ((parts[0]! * 60 + parts[1]!) * 60 + parts[2]!) * 1000
  return undefined
}

export function parseTqdm(line: string): ParsedProgress | null {
  const match = line.match(TQDM)
  if (!match?.groups) return null
  const current = Number.parseInt(match.groups['cur'] ?? '', 10)
  const total = Number.parseInt(match.groups['total'] ?? '', 10)
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null
  return {
    percent: Math.max(0, Math.min(100, Number.parseFloat(match.groups['pct'] ?? '') || (current / total) * 100)),
    current,
    total,
    etaMs: match.groups['eta'] ? etaToMs(match.groups['eta']) : undefined,
    rate: match.groups['rate']?.trim(),
  }
}

export function parseDownloadProgress(line: string): ParsedProgress | null {
  const match = line.match(DOWNLOAD)
  if (!match?.groups) return null
  return {
    percent: Number.parseFloat(match.groups['pct'] ?? '') || 0,
    current: 0,
    total: 0,
    label: match.groups['label']?.trim(),
    rate: `${match.groups['cur']} / ${match.groups['total']}`,
  }
}

export function progressFor(
  line: string,
  stage: JobStage,
  current: JobProgress,
): JobProgress | null {
  const parsed = parseTqdm(line)
  if (!parsed) return null
  const next: JobProgress = {
    stage: stage === 'idle' || stage === 'ready' ? 'denoise' : stage,
    current: parsed.current,
    total: parsed.total,
    percent: parsed.percent,
    etaMs: parsed.etaMs,
    message: parsed.rate,
  }
  // Progress never goes backwards within the same stage.
  if (next.stage === current.stage && next.percent < current.percent) {
    next.percent = current.percent
    next.current = Math.max(current.current, next.current)
  }
  return next
}

interface RawRule {
  id: string
  match: string | null
  severity: 'error' | 'warning' | 'info'
  title: string
  explain: string
  solutions?: Array<{ label: string; action: string; params?: Record<string, unknown> }>
  dedupe?: { windowSec: number; maxPerWindow: number }
}

export interface ErrorRule extends RawRule {
  regex?: RegExp
}

const FALLBACK: RawRule[] = [
  {
    id: 'E_EXIT',
    match: null,
    severity: 'error',
    title: '程序异常退出',
    explain: '进程以非零状态退出，但没有匹配到已知错误。请查看原始输出。',
    solutions: [{ label: '查看日志', action: 'open_log' }],
  },
  {
    id: 'E_OOM',
    match: '(out of memory|OutOfMemoryError|MPS backend out of memory)',
    severity: 'error',
    title: '显存/内存不足',
    explain: '模型在当前分辨率或精度下耗尽了设备内存。',
    solutions: [
      { label: '降低分辨率重试', action: 'retry_lower' },
      { label: '打开运行时设置', action: 'open_settings' },
    ],
  },
  {
    id: 'E_MODULE',
    match: "ModuleNotFoundError: No module named '([^']+)'",
    severity: 'error',
    title: '缺少 Python 包',
    explain: '当前实例的运行时缺少依赖，通常是环境没有安装完整。',
    solutions: [
      { label: '修复运行时', action: 'repair_runtime' },
      { label: '打开实例', action: 'open_settings' },
    ],
  },
  {
    id: 'E_NET',
    match: '(HTTPError|SSLError|ConnectionError|Max retries exceeded|Could not resolve host)',
    severity: 'warning',
    title: '网络请求失败',
    explain: '下载或鉴权没有完成，可能是网络或镜像不可用。',
    solutions: [
      { label: '切换镜像', action: 'switch_mirror' },
      { label: '打开网络设置', action: 'open_settings' },
    ],
  },
]

let cached: { at: number; rules: ErrorRule[] } | null = null

export function loadRules(): ErrorRule[] {
  if (cached && Date.now() - cached.at < 30_000) return cached.rules
  let raw = FALLBACK
  const local = contentDir()
  if (local) {
    try {
      const parsed = JSON.parse(readFileSync(join(local, 'rules.json'), 'utf8')) as { rules?: RawRule[] }
      if (parsed.rules?.length) raw = parsed.rules
    } catch {
      // fall back
    }
  }
  const rules = raw.map((rule) => {
    if (!rule.match) return { ...rule }
    try {
      return { ...rule, regex: new RegExp(rule.match, 'i') }
    } catch {
      return { ...rule }
    }
  })
  cached = { at: Date.now(), rules }
  return rules
}

export function matchRule(line: string): ErrorRule | null {
  for (const rule of loadRules()) {
    if (!rule.regex) continue
    if (rule.regex.test(line)) return rule
  }
  return null
}

export function exitRule(): ErrorRule {
  return loadRules().find((rule) => rule.id === 'E_EXIT') ?? { ...FALLBACK[0]! }
}

export function normalizeSignature(ruleId: string, raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[a-z]:\\[^\s]+|\/[^\s]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hash>')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
  return `${ruleId}:${normalized}`
}

export function toDiagnostic(rule: ErrorRule, raw: string, jobId?: string): Omit<Diagnostic, 'id' | 'count' | 'firstAt' | 'lastAt' | 'toast'> {
  const match = rule.regex?.exec(raw)
  const render = (text: string): string => text.replace(/\{(\d+)\}/g, (_, index: string) => match?.[Number(index)] ?? '未知')
  const solutions: DiagnosticSolution[] = (rule.solutions ?? []).map((solution) => ({
    label: solution.label,
    action: solution.action,
    params: solution.params,
  }))
  if (!solutions.length) solutions.push({ label: '复制诊断信息', action: 'copy_diagnostics' })
  return {
    jobId,
    ruleId: rule.id,
    severity: rule.severity,
    title: render(rule.title),
    explain: render(rule.explain),
    solutions,
    raw: raw.slice(-4000),
    signature: normalizeSignature(rule.id, raw),
  }
}
