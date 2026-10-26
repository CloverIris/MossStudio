import { AlertTriangle, CheckCircle2, Copy, Info, RefreshCw, ShieldAlert, Trash2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { openWindow } from '../lib/windows'
import type { Diagnostic, DiagnosticSolution } from '@shared/types'
import { call } from '../lib/api'
import { relative } from '../lib/format'
import { useApp } from '../store'
import { MotionPanel } from '../components/motion'
import { Button, Card, EmptyState, IconButton, Pill, cn, useToast } from '../components/ui'

const severityMeta = {
  error: { icon: <XCircle className="size-4 text-red-500" />, label: '错误', tone: 'red' as const },
  warning: { icon: <AlertTriangle className="size-4 text-amber-500" />, label: '警告', tone: 'amber' as const },
  info: { icon: <Info className="size-4 text-sky-500" />, label: '提示', tone: 'blue' as const },
}

export function DiagnosticsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const diagnostics = useApp((state) => state.diagnostics)
  const jobs = useApp((state) => state.jobs)
  const dismissDiagnostic = useApp((state) => state.dismissDiagnostic)
  const clearDiagnostics = useApp((state) => state.clearDiagnostics)
  const refreshDiagnostics = useApp((state) => state.refreshDiagnostics)
  const setActiveJob = useApp((state) => state.setActiveJob)
  const loadJobLogs = useApp((state) => state.loadJobLogs)
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all')
  const [busy, setBusy] = useState<string | null>(null)

  const filtered = diagnostics.filter((item) => filter === 'all' || item.severity === filter)

  async function act(diagnostic: Diagnostic, solution: DiagnosticSolution): Promise<void> {
    setBusy(diagnostic.id)
    try {
      if (solution.action === 'open_log') {
        if (diagnostic.jobId) {
          setActiveJob(diagnostic.jobId)
          await loadJobLogs(diagnostic.jobId)
        }
        openWindow('terminal')
      } else if (solution.action === 'open_settings' || solution.action === 'switch_mirror') {
        navigate('/settings')
      } else if (solution.action === 'open_models') {
        navigate('/models')
      } else if (solution.action === 'open_instances') {
        navigate('/instances')
      } else if (solution.action === 'repair_runtime') {
        const job = jobs.find((item) => item.id === diagnostic.jobId)
        navigate(job ? `/instances/${job.instanceId}` : '/instances')
      } else if (solution.action === 'copy_diagnostics') {
        await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2))
        toast.push('诊断信息已复制', 'success')
      } else {
        toast.push('这个修复动作会在后续版本接入', 'info')
      }
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">诊断</h1>
          <p className="mt-1 text-ui text-[var(--color-text-secondary)]">
            运行失败会被翻译成可操作的卡片；同一错误不会反复弹窗。
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <IconButton label="刷新" onClick={() => void refreshDiagnostics()}>
            <RefreshCw className="size-4" />
          </IconButton>
          <Button
            tone="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2))
              toast.push('已复制全部诊断', 'success')
            }}
            disabled={diagnostics.length === 0}
          >
            <span className="inline-flex items-center gap-1.5">
              <Copy className="size-4" /> 导出
            </span>
          </Button>
          <Button
            tone="ghost"
            onClick={() => void clearDiagnostics()}
            disabled={diagnostics.length === 0}
          >
            <span className="inline-flex items-center gap-1.5 text-[var(--color-text-tertiary)]">
              <Trash2 className="size-4" /> 清空
            </span>
          </Button>
        </div>
      </header>

      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg bg-[var(--color-surface-tertiary)] p-0.5">
          {(
            [
              ['all', `全部 ${diagnostics.length}`],
              ['error', `错误 ${diagnostics.filter((item) => item.severity === 'error').length}`],
              ['warning', `警告 ${diagnostics.filter((item) => item.severity === 'warning').length}`],
            ] as Array<['all' | 'error' | 'warning', string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'rounded-[7px] px-3 py-1 text-ui font-medium transition',
                filter === value
                  ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-secondary)]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-caption text-[var(--color-text-tertiary)]">诊断数据保存在本地</span>
      </div>

      <MotionPanel transitionKey={filter}>
        {filtered.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="size-8 text-accent-500" />}
            title={diagnostics.length === 0 ? '没有诊断记录' : '当前筛选下没有记录'}
            description="任务失败、OOM、网络与依赖问题会生成卡片，并附带解决按钮。"
            action={
              <Button tone="secondary" onClick={() => openWindow('terminal')}>
                查看运行
              </Button>
            }
          />
        ) : (
          <div className="space-y-2.5">
            {filtered.map((diagnostic) => {
              const meta = severityMeta[diagnostic.severity]
              const job = jobs.find((item) => item.id === diagnostic.jobId)
              return (
                <Card key={diagnostic.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">{meta.icon}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium">{diagnostic.title}</span>
                        <Pill tone={meta.tone}>{meta.label}</Pill>
                        <span className="text-caption text-[var(--color-text-tertiary)]">{diagnostic.ruleId}</span>
                        {diagnostic.count > 1 ? (
                          <span className="text-caption text-[var(--color-text-tertiary)]">
                            ×{diagnostic.count}
                          </span>
                        ) : null}
                        <span className="ml-auto text-caption text-[var(--color-text-tertiary)]">
                          {relative(diagnostic.lastAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-ui leading-5 text-[var(--color-text-secondary)]">
                        {diagnostic.explain}
                      </p>
                      {job ? (
                        <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">
                          {job.instanceName} · {job.params.width}×{job.params.height} · {job.params.steps} 步
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {diagnostic.solutions.map((solution) => (
                          <Button
                            key={solution.label}
                            tone={solution.action === 'retry_lower' ? 'primary' : 'secondary'}
                            onClick={() => void act(diagnostic, solution)}
                            disabled={busy === diagnostic.id}
                          >
                            {solution.label}
                          </Button>
                        ))}
                        <Button
                          tone="ghost"
                          onClick={() => void dismissDiagnostic(diagnostic.id)}
                        >
                          忽略
                        </Button>
                      </div>
                      {diagnostic.raw ? (
                        <details className="mt-2 group">
                          <summary className="cursor-pointer list-none text-caption text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]">
                            原始输出 ▸
                          </summary>
                          <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-white/45 p-2.5 font-mono text-caption leading-4 text-[var(--color-text-secondary)] dark:bg-black/25">
                            {diagnostic.raw}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => void dismissDiagnostic(diagnostic.id)}
                      className="text-[var(--color-text-tertiary)] hover:text-red-500"
                      aria-label="关闭诊断"
                    >
                      <XCircle className="size-4" />
                    </button>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </MotionPanel>

      <div className="flex items-center gap-2 text-caption text-[var(--color-text-tertiary)]">
        <ShieldAlert className="size-4" />
        同一 signature 60 秒内只弹一次 toast；全局 5 分钟最多 3 条。
      </div>
    </div>
  )
}
