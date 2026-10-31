import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Square, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import { useApp } from '../store'
import { call, onEvent } from '../lib/api'
import { cn } from '../components/ui'

const stateLabel = {
  queued: '排队',
  starting: '启动中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已停止',
}

const stateColor = {
  queued: 'bg-neutral-400',
  starting: 'bg-amber-500',
  running: 'bg-accent-400',
  succeeded: 'bg-accent-500',
  failed: 'bg-red-500',
  canceled: 'bg-neutral-500',
}

const stageLabel: Record<string, string> = {
  idle: '等待启动',
  ready: '引擎就绪',
  load: '加载模型',
  text: '文本编码',
  denoise: '去噪',
  decode: '图像解码',
  save: '保存结果',
}

function etaLabel(etaMs: number | undefined): string {
  if (etaMs === undefined || !Number.isFinite(etaMs) || etaMs <= 0) return ''
  const seconds = Math.ceil(etaMs / 1000)
  return seconds < 60 ? ` · 约 ${seconds} 秒` : ` · 约 ${Math.ceil(seconds / 60)} 分钟`
}

export function TerminalPage(): React.JSX.Element {
  const jobs = useApp((state) => state.jobs)
  const activeJobId = useApp((state) => state.activeJobId)
  const logsByJob = useApp((state) => state.jobLogs)
  const setActiveJob = useApp((state) => state.setActiveJob)
  const loadJobLogs = useApp((state) => state.loadJobLogs)
  const sendJobInput = useApp((state) => state.sendJobInput)
  const cancelJob = useApp((state) => state.cancelJob)
  const [engine, setEngine] = useState('all')
  const [sessions, setSessions] = useState<Array<{ id: string; hostId: string; hostName: string; startedAt: string; exitCode?: number | null; buffer: string }>>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const ordered = useMemo(
    () =>
      jobs.slice().sort((a, b) => {
        const rank = (state: string): number => (state === 'running' || state === 'starting' ? 0 : 1)
        return rank(a.state) - rank(b.state) || b.startedAt.localeCompare(a.startedAt)
      }),
    [jobs],
  )
  const engineKey = (job: typeof jobs[number]): string => job.hostId ? `remote:${job.hostId}` : 'local'
  const engines = [...new Set(ordered.map(engineKey))]
  const visible = engine === 'all' ? ordered : ordered.filter((job) => engineKey(job) === engine)
  const active = visible.find((job) => job.id === activeJobId) ?? visible[0] ?? null
  const logs = active ? logsByJob[active.id] ?? [] : []

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const writtenRef = useRef(0)
  const activeIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (engine !== 'all' && !engines.includes(engine)) setEngine('all')
    if (!activeJobId && visible[0]) setActiveJob(visible[0].id)
  }, [activeJobId, visible, setActiveJob, engine, engines])

  useEffect(() => {
    if (active && !logsByJob[active.id]) void loadJobLogs(active.id)
  }, [active?.id, logsByJob, loadJobLogs])
  useEffect(() => {
    const current = jobs.find((job) => job.id === activeJobId)
    if (current && !['failed', 'canceled', 'succeeded'].includes(current.state)) return
    const next = jobs.find((job) => job.state === 'running' || job.state === 'starting')
    if (next) setActiveJob(next.id)
  }, [jobs, activeJobId, setActiveJob])

  useEffect(() => {
    void call<typeof sessions>(Ipc.sshTerminalList).then(setSessions).catch(() => undefined)
    const offData = onEvent<{ sessionId: string; data: string }>(Events.terminalData, (payload) => {
      setSessions((previous) => previous.map((session) => session.id === payload.sessionId ? { ...session, buffer: `${session.buffer}${payload.data}`.slice(-200_000) } : session))
      if (payload.sessionId === activeSessionId) termRef.current?.write(payload.data)
    })
    const offExit = onEvent<{ sessionId: string; code: number | null }>(Events.terminalExit, (payload) => {
      setSessions((previous) => previous.map((session) => session.id === payload.sessionId ? { ...session, exitCode: payload.code } : session))
      if (payload.sessionId === activeSessionId) termRef.current?.write(`\r\n\x1b[38;2;217;107;107m[会话已结束 ${payload.code ?? 'null'}]\x1b[0m\r\n`)
    })
    return () => { offData(); offExit() }
  }, [activeSessionId])

  useEffect(() => {
    if (!hostRef.current) return
    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: true,
      fontFamily: '"Cascadia Code", "SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.45,
      scrollback: 5000,
      theme: {
        background: 'rgba(16,18,22,0.52)',
        foreground: '#c7d0de',
        cursor: '#8ab6ff',
        selectionBackground: 'rgba(138,182,255,0.24)',
        black: '#141619',
        brightBlack: '#697384',
        red: '#d96b6b',
        brightRed: '#f0a0a0',
        green: '#8ab6ff',
        brightGreen: '#a9c7ff',
        yellow: '#d9a441',
        brightYellow: '#f3cf8a',
        blue: '#6ea3f5',
        brightBlue: '#8ab6ff',
        magenta: '#b69be8',
        brightMagenta: '#d0bcf5',
        cyan: '#8ecdd8',
        brightCyan: '#b4e3eb',
        white: '#c7d0de',
        brightWhite: '#f1f5fb',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    const dataSub = term.onData((data) => {
      if (activeSessionId) {
        void call(Ipc.sshTerminalInput, { id: activeSessionId, data })
        return
      }
      if (data.includes('\x03')) {
        const current = useApp.getState().activeJobId
        if (current) void cancelJob(current)
        return
      }
      const current = useApp.getState().activeJobId
      if (!current) return
      const job = useApp.getState().jobs.find((item) => item.id === current)
      if (!job || (job.state !== 'running' && job.state !== 'starting')) return
      void sendJobInput(current, data.replace(/\r/g, ''))
    })
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // container may be hidden during a transition
      }
    })
    observer.observe(hostRef.current)
    return () => {
      dataSub.dispose()
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sendJobInput, activeSessionId, cancelJob])

  useEffect(() => {
    const term = termRef.current
    const session = sessions.find((item) => item.id === activeSessionId)
    if (!term || !session) return
    term.clear()
    term.write(`\x1b[38;2;138;182;255mSSH ${session.hostName}\x1b[0m  ${session.startedAt}\r\n\r\n`)
    if (session.buffer) term.write(session.buffer)
  }, [activeSessionId])

  useEffect(() => {
    const term = termRef.current
    if (!term || !active || activeSessionId) return
    if (activeIdRef.current !== active.id) {
      activeIdRef.current = active.id
      writtenRef.current = 0
      term.clear()
    }
    if (writtenRef.current > logs.length) {
      term.clear()
      writtenRef.current = 0
    }
    if (writtenRef.current === 0) {
      term.clear()
      term.write(`\x1b[38;2;138;182;255mMossStudio terminal\x1b[0m  ${active.instanceName}\r\n`)
      const subtitle =
        active.kind === 'training'
          ? `training · step ${active.metrics?.step ?? active.progress.current}/${active.progress.total || '—'}${
              active.metrics?.loss !== undefined ? ` · loss ${active.metrics.loss.toFixed(4)}` : ''
            }`
          : `${active.caseName ?? active.mode} · ${active.params.width}×${active.params.height}`
      term.write(`\x1b[38;2;113;123;138m${subtitle}\x1b[0m\r\n\r\n`)
    }
    for (let index = writtenRef.current; index < logs.length; index += 1) {
      const line = logs[index]!
      const text = line.stream === 'stderr' ? `\x1b[38;2;217;107;107m${line.text}\x1b[0m` : line.text
      term.write(`${text}\r\n`)
    }
    writtenRef.current = logs.length
    fitRef.current?.fit()
  }, [active, logs])


  return (
    <div className="flex h-full min-h-0 bg-transparent">
      <aside className="glass-thin flex w-[260px] shrink-0 flex-col border-r border-[var(--color-border-subtle)]">
        <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-ui font-medium">
            <SquareTerminal className="size-4 text-[var(--color-text-tertiary)]" />
            引擎 / 推理进程
          </div>
          <span className="text-caption text-[var(--color-text-tertiary)]">{visible.length}</span>
        </header>
        <div className="border-b border-[var(--color-border-subtle)] px-1.5 py-1.5">
          <div className="mb-1 flex items-center justify-between text-micro font-medium uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
            <span>SSH 会话</span>
            <span>{sessions.filter((item) => item.exitCode == null).length}</span>
          </div>
          <div className="space-y-1">
            {sessions.map((session) => (
              <div key={session.id} className={cn('flex items-center gap-1 rounded border px-1.5 py-1', activeSessionId === session.id ? 'border-accent-500/40 bg-accent-500/10' : 'border-[var(--color-border-subtle)]')}>
                <button type="button" className="min-w-0 flex-1 truncate text-left text-caption" onClick={() => { setActiveSessionId(session.id); setActiveJob(null) }}>
                  {session.hostName}{session.exitCode != null ? ' · 已结束' : ''}
                </button>
                <button type="button" className="text-[var(--color-text-tertiary)] hover:text-red-300" onClick={() => { void call(Ipc.sshTerminalClose, { id: session.id }); setSessions((previous) => previous.filter((item) => item.id !== session.id)); if (activeSessionId === session.id) setActiveSessionId(null) }}><span className="text-caption">×</span></button>
              </div>
            ))}
            {sessions.length === 0 ? <p className="text-micro text-[var(--color-text-tertiary)]">在引擎页点“SSH 终端”打开服务器 TTY</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 border-b border-[var(--color-border-subtle)] px-1.5 py-1.5">
          {['all', ...engines].map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setEngine(key)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-micro',
                engine === key ? 'border-accent-500/40 bg-accent-500/10 text-accent-200' : 'border-[var(--color-border-subtle)] text-[var(--color-text-tertiary)]',
              )}
            >
              {key === 'all' ? '全部' : key === 'local' ? '本机' : `远端 ${key.slice('remote:'.length).slice(-6)}`}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {ordered.length === 0 ? (
            <p className="px-3 py-8 text-center text-ui leading-5 text-[var(--color-text-tertiary)]">
              还没有任务。
              <br />
              去 MossStudio 开始生成。
            </p>
          ) : (
            visible.map((job) => (
              <button
                key={job.id}
                type="button"
                onClick={() => {
                  setActiveJob(job.id)
                  void loadJobLogs(job.id)
                }}
                className={cn(
                  'mb-1 flex w-full items-start gap-2 rounded-[6px] px-2.5 py-2 text-left transition',
                  job.id === active?.id
                    ? 'bg-white/[0.07]'
                    : 'hover:bg-white/[0.04]',
                )}
              >
                <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', stateColor[job.state])} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-[var(--color-text)]">
                    {job.params.prompt.trim().slice(0, 32) || job.instanceName}
                  </span>
                  <span className="mt-0.5 block truncate text-caption text-[var(--color-text-tertiary)]">
                    {job.kind === 'training' ? '训练' : '推理'} · {stateLabel[job.state]} · {job.instanceName}
                  </span>
                </span>
                {(job.state === 'running' || job.state === 'starting') ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation()
                      void cancelJob(job.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.stopPropagation()
                        void cancelJob(job.id)
                      }
                    }}
                    className="mt-0.5 rounded-[3px] p-1 text-[var(--color-text-tertiary)] hover:bg-red-500/15 hover:text-red-300"
                  >
                    <Square className="size-4" />
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] px-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-ui font-medium">
              {activeSessionId ? sessions.find((item) => item.id === activeSessionId)?.hostName ?? 'SSH 会话' : active ? active.params.prompt.trim().slice(0, 48) || active.instanceName : '没有选中任务'}
            </span>
            {active ? (
              <span className="text-caption text-[var(--color-text-tertiary)]">
                {active.kind === 'training' ? '训练' : '推理'} · {stateLabel[active.state]} · PID {active.pid ?? '—'}
              </span>
            ) : null}
          </div>
          {!activeSessionId && active && (active.state === 'running' || active.state === 'starting') ? (
            <button
              type="button"
              onClick={() => void cancelJob(active.id)}
              className="rounded-[4px] px-2 py-1 text-caption text-red-300 hover:bg-red-500/10"
            >
              停止
            </button>
          ) : null}
        </header>
        {!activeSessionId && active && (active.state === 'running' || active.state === 'starting' || active.state === 'queued') ? (
          <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-2">
            <div className="mb-1 flex items-center justify-between gap-3 text-caption">
              <span className="truncate text-[var(--color-text-secondary)]">
                {active.state === 'queued'
                  ? `排队中${active.progress.message ? ` · ${active.progress.message}` : ''}`
                  : stageLabel[active.progress.stage] ?? '处理中'}
                {active.progress.stage === 'denoise' && active.progress.total > 0
                  ? ` · ${active.progress.current}/${active.progress.total} 步`
                  : ''}
                {active.state === 'running' ? etaLabel(active.progress.etaMs) : ''}
              </span>
              {active.progress.stage === 'denoise' && active.progress.total > 0 ? (
                <span className="shrink-0 font-mono text-micro text-[var(--color-text-tertiary)]">
                  {Math.round(active.progress.percent)}%
                </span>
              ) : null}
            </div>
            <div
              role="progressbar"
              aria-label={stageLabel[active.progress.stage] ?? '推理进度'}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={active.progress.stage === 'denoise' && active.progress.total > 0 ? active.progress.percent : undefined}
              className="h-1 overflow-hidden rounded-full bg-white/10"
            >
              <div
                className={`h-full rounded-full bg-accent-400 transition-[width] duration-300 ${
                  active.progress.stage === 'denoise' && active.progress.total > 0 ? '' : 'w-1/3 animate-pulse'
                }`}
                style={active.progress.stage === 'denoise' && active.progress.total > 0
                  ? { width: `${Math.min(100, Math.max(0, active.progress.percent))}%` }
                  : undefined}
              />
            </div>
          </div>
        ) : null}
        <div ref={hostRef} className="min-h-0 flex-1 p-2" />
      </section>
    </div>
  )
}
