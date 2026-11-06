import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AppNotification, Diagnostic, DiagnosticSolution, JobRecord } from '@shared/types'
import { ACTIVE_JOB_STATES, jobSummary, jobTitle, relative } from '../../lib/format'
import { useShell, type ActivityTab } from '../../lib/shell'
import { useApp } from '../../store'
import { cn } from '../cn'
import { Button, ConfirmDialog, EmptyState, FieldLabel, IconButton, ProgressBar, Tabs, useToast } from '../ui'

const isActive = (job: JobRecord): boolean => ACTIVE_JOB_STATES.has(job.state)

function JobLog({ job }: { job: JobRecord }): React.JSX.Element {
  const lines = useApp((state) => state.jobLogs[job.id])
  const loadJobLogs = useApp((state) => state.loadJobLogs)
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (!lines) void loadJobLogs(job.id)
  }, [job.id, lines, loadJobLogs])
  useLayoutEffect(() => {
    const element = box.current
    if (element) element.scrollTop = element.scrollHeight
  }, [lines?.length])
  return (
    <pre
      ref={box}
      data-job-log
      className="selectable max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface px-3 py-2.5 font-mono text-[12px] leading-5 text-ink-2"
    >
      {lines?.length ? lines.map((line) => line.text).join('\n') : '还没有输出'}
    </pre>
  )
}

function JobsTab(): React.JSX.Element {
  const jobs = useApp((state) => state.jobs)
  const cancelJob = useApp((state) => state.cancelJob)
  const focused = useShell((state) => state.focusedJobId)
  const focusJob = useShell((state) => state.focusJob)
  const toast = useToast()
  const active = jobs.filter(isActive)
  const finished = jobs.filter((job) => !isActive(job)).slice(0, 30)

  const row = (job: JobRecord): React.JSX.Element => {
    const open = focused === job.id
    const running = isActive(job)
    return (
      <div key={job.id} data-job-row={job.id} className={cn('flex flex-col gap-2 rounded-lg px-3 py-2.5', open && 'bg-well')}>
        <div className="flex items-start gap-3">
          <button type="button" aria-expanded={open} onClick={() => focusJob(open ? null : job.id)} className="min-w-0 flex-1 text-left">
            <div className="truncate text-control text-ink">{jobTitle(job)}</div>
            <div className={cn('tabular mt-0.5 truncate text-caption', job.state === 'failed' ? 'text-danger' : 'text-ink-2')}>
              {jobSummary(job)}
            </div>
          </button>
          {running ? (
            <Button
              tone="ghost"
              size="xs"
              onClick={() => {
                void cancelJob(job.id).catch((error: unknown) =>
                  toast.push(error instanceof Error ? error.message : String(error), 'error'),
                )
              }}
            >
              取消
            </Button>
          ) : (
            <span className="shrink-0 pt-0.5 text-caption text-ink-2">{relative(job.endedAt ?? job.startedAt)}</span>
          )}
        </div>
        {job.state === 'running' ? <ProgressBar value={job.progress.percent} label="任务进度" /> : null}
        {open ? <JobLog job={job} /> : null}
      </div>
    )
  }

  if (jobs.length === 0) {
    return <EmptyState title="还没有任务" description="在创作中生成图片后，进度和日志会出现在这里。" />
  }
  return (
    <div className="flex flex-col gap-1">
      {active.map(row)}
      {finished.length ? (
        <FieldLabel as="h3" className="px-3 pb-1 pt-4">
          已结束
        </FieldLabel>
      ) : null}
      {finished.map(row)}
    </div>
  )
}

const toneIcon: Record<AppNotification['tone'], React.JSX.Element> = {
  info: <Info className="size-4 text-ink-2" aria-hidden="true" strokeWidth={1.6} />,
  success: <CheckCircle2 className="size-4 text-ok" aria-hidden="true" strokeWidth={1.6} />,
  warning: <AlertTriangle className="size-4 text-warn" aria-hidden="true" strokeWidth={1.6} />,
  error: <AlertCircle className="size-4 text-danger" aria-hidden="true" strokeWidth={1.6} />,
}

function NotificationsTab(): React.JSX.Element {
  const notifications = useApp((state) => state.notifications)
  const markAllRead = useApp((state) => state.markAllNotificationsRead)
  // Reading the tab is what marks them read; keep the unread styling for this visit.
  const [unreadOnOpen] = useState(() => new Set(notifications.filter((item) => !item.read).map((item) => item.id)))
  useEffect(() => {
    markAllRead()
  }, [markAllRead, notifications.length])

  if (notifications.length === 0) {
    return <EmptyState title="没有通知" description="下载完成、生成完成和新版本会在这里提醒你。" />
  }
  return (
    <div className="flex flex-col gap-1">
      {notifications.map((item) => (
        <div key={item.id} data-unread={unreadOnOpen.has(item.id) || undefined} className="flex gap-3 rounded-lg px-3 py-2.5">
          <span className="mt-0.5 shrink-0">{toneIcon[item.tone]}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-control text-ink">{item.title}</span>
                {/* Unread is a dot, not a fill: fills mean selected (well) or a card (surface). */}
                {unreadOnOpen.has(item.id) ? (
                  <span role="img" aria-label="未读" className="size-1.5 shrink-0 rounded-full bg-accent" />
                ) : null}
              </span>
              <span className="shrink-0 text-caption text-ink-2">{relative(item.createdAt)}</span>
            </div>
            <p className="mt-0.5 text-caption text-ink-2 [overflow-wrap:anywhere]">{item.message}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Where a diagnostic's suggested fix takes the user. Actions without a real fix are not shown. */
export function solutionTarget(solution: DiagnosticSolution): { route?: string; job?: true; copy?: true } | null {
  switch (solution.action) {
    case 'open_log':
    case 'open_job_log': // the name release/rules.json uses
      return { job: true }
    case 'switch_mirror':
      return { route: '/settings/network' }
    case 'open_settings': {
      // rules.json names the section (e.g. { tab: 'storage' }); Settings maps old names itself.
      const tab = solution.params?.['tab']
      return { route: typeof tab === 'string' && /^[a-z-]+$/.test(tab) ? `/settings/${tab}` : '/settings' }
    }
    case 'open_models':
    case 'models':
      return { route: '/models' }
    case 'repair_runtime':
    case 'engines':
    case 'devices':
      return { route: '/settings/devices' }
    case 'copy_diagnostics':
      return { copy: true }
    default:
      return null
  }
}

function ProblemsTab(): React.JSX.Element {
  const [clearing, setClearing] = useState(false)
  const diagnostics = useApp((state) => state.diagnostics)
  const dismissDiagnostic = useApp((state) => state.dismissDiagnostic)
  const clearDiagnostics = useApp((state) => state.clearDiagnostics)
  const navigate = useNavigate()
  const openActivity = useShell((state) => state.openActivity)
  const closeActivity = useShell((state) => state.closeActivity)
  const toast = useToast()

  async function apply(diagnostic: Diagnostic, solution: DiagnosticSolution): Promise<void> {
    const target = solutionTarget(solution)
    if (!target) return
    if (target.job && diagnostic.jobId) openActivity('jobs', diagnostic.jobId)
    if (target.route) {
      closeActivity()
      void navigate(target.route)
    }
    if (target.copy) {
      try {
        await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2))
        toast.push('诊断信息已复制', 'success')
      } catch {
        toast.push('复制失败', 'error')
      }
    }
  }

  if (diagnostics.length === 0) {
    return <EmptyState title="没有问题" description="运行出错时，原因和修复方法会出现在这里。" />
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-end px-1 pb-1">
        <Button tone="ghost-danger" size="xs" onClick={() => setClearing(true)}>
          全部清除
        </Button>
      </div>
      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        title="清除所有问题？"
        description="问题列表会清空；之后再出错时会重新出现。"
        confirmLabel="全部清除"
        onConfirm={() => {
          setClearing(false)
          void clearDiagnostics()
        }}
      />
      {diagnostics.map((diagnostic) => {
        const solutions = diagnostic.solutions.filter(
          (solution) => solutionTarget(solution) && (!solutionTarget(solution)?.job || diagnostic.jobId),
        )
        return (
          <div key={diagnostic.id} data-problem={diagnostic.id} className="flex flex-col gap-2 rounded-lg bg-surface px-3 py-2.5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0">
                {diagnostic.severity === 'error' ? toneIcon.error : diagnostic.severity === 'warning' ? toneIcon.warning : toneIcon.info}
              </span>
              <div className="min-w-0 flex-1">
                {/* The time sits where every Activity list puts it: right of the title, ink-2. */}
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-control text-ink">{diagnostic.title}</span>
                  <span className="tabular shrink-0 text-caption text-ink-2">
                    {diagnostic.count > 1 ? `出现 ${diagnostic.count} 次 · ` : ''}
                    {relative(diagnostic.lastAt)}
                  </span>
                </div>
                <p className="mt-0.5 text-caption text-ink-2 [overflow-wrap:anywhere]">{diagnostic.explain}</p>
              </div>
              <IconButton label="忽略" className="-mr-1 -mt-1 size-7" onClick={() => void dismissDiagnostic(diagnostic.id)}>
                <X className="size-3.5" strokeWidth={1.6} />
              </IconButton>
            </div>
            {solutions.length ? (
              <div className="flex flex-wrap gap-2 pl-7">
                {solutions.map((solution, index) => (
                  // One list, many cards: no card's fix outranks another's, so none is primary.
                  <Button key={`${solution.action}-${index}`} onClick={() => void apply(diagnostic, solution)}>
                    {solution.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** Everything that happens in the background: jobs and their logs, notifications, problems. */
export function ActivityPanel(): React.JSX.Element | null {
  const open = useShell((state) => state.activityOpen)
  const tab = useShell((state) => state.activityTab)
  const setTab = useShell((state) => state.setActivityTab)
  const close = useShell((state) => state.closeActivity)
  const jobs = useApp((state) => state.jobs)
  const unread = useApp((state) => state.notifications.filter((item) => !item.read).length)
  const problems = useApp((state) => state.diagnostics.length)
  const activeJobs = useMemo(() => jobs.filter(isActive).length, [jobs])
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    panel.current?.focus({ preventScroll: true })
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="活动"
      data-activity-panel
      className="absolute inset-y-0 left-0 z-30 flex w-[440px] max-w-full flex-col bg-panel shadow-float outline-none"
    >
      <div className="flex items-center justify-between px-5 pb-3 pt-4">
        <h2 className="text-section font-semibold">活动</h2>
        <IconButton label="关闭活动" onClick={close}>
          <X className="size-4" strokeWidth={1.6} />
        </IconButton>
      </div>
      <Tabs<ActivityTab>
        label="活动类型"
        className="px-4 pb-3"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'jobs', label: '任务', count: activeJobs },
          { value: 'notifications', label: '通知', count: unread },
          { value: 'problems', label: '问题', count: problems },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {tab === 'jobs' ? <JobsTab /> : tab === 'notifications' ? <NotificationsTab /> : <ProblemsTab />}
      </div>
    </aside>
  )
}
