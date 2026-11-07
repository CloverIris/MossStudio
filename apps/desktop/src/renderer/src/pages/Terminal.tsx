import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import { call, onEvent } from '../lib/api'
import { Notice } from '../components/common/Notice'
import { Button, LoadingRow, Sheet } from '../components/ui'

interface SshSession {
  id: string
  hostId: string
  hostName: string
  startedAt: string
  exitCode?: number | null
  buffer: string
}

/** xterm draws on a canvas, so it needs real colours: read them from the theme tokens. */
function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string): string => style.getPropertyValue(name).trim()
  return {
    background: token('--panel'),
    foreground: token('--ink'),
    cursor: token('--accent'),
    selectionBackground: token('--accent-soft'),
    red: token('--danger'),
    brightRed: token('--danger'),
    green: token('--ok'),
    brightGreen: token('--ok'),
    yellow: token('--warn'),
    brightYellow: token('--warn'),
    brightBlack: token('--ink-3'),
    white: token('--ink-2'),
    brightWhite: token('--ink'),
  }
}

/**
 * An interactive shell on a remote host, in a sheet over Settings. Closing the
 * sheet keeps the session running; 结束会话 ends it.
 */
export function SshTerminalSheet({
  hostId,
  hostName,
  open,
  onClose,
}: {
  hostId: string | null
  hostName: string
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [session, setSession] = useState<SshSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ended, setEnded] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open || !hostId) return
    let canceled = false
    setSession(null)
    setError(null)
    setEnded(false)
    void call<SshSession>(Ipc.sshTerminalOpen, { hostId })
      .then((next) => {
        if (!canceled) {
          setSession(next)
          setEnded(next.exitCode != null)
        }
      })
      .catch((reason: unknown) => {
        if (!canceled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      canceled = true
    }
  }, [open, hostId, attempt])

  async function endSession(): Promise<void> {
    if (session) await call(Ipc.sshTerminalClose, { id: session.id }).catch(() => undefined)
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`终端 · ${hostName}`}
      description="直接在远程主机上输入命令。关闭面板不会结束会话。"
      width="max-w-[880px]"
      footer={
        <>
          <Button tone="ghost" size="md" onClick={onClose}>
            关闭
          </Button>
          <Button tone="danger" size="md" disabled={!session || ended} onClick={() => void endSession()}>
            结束会话
          </Button>
        </>
      }
    >
      {error ? (
        <Notice
          tone="danger"
          role="alert"
          action={
            <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>
              重试
            </Button>
          }
        >
          没能打开终端：{error}。请先在设置里测试这台主机的连接。
        </Notice>
      ) : session ? (
        <TerminalView session={session} onExit={() => setEnded(true)} />
      ) : (
        <LoadingRow label="正在连接…" />
      )}
    </Sheet>
  )
}

function TerminalView({ session, onExit }: { session: SshSession; onExit: () => void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const exited = useRef(onExit)
  exited.current = onExit

  useEffect(() => {
    if (!host.current) return
    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 13,
      lineHeight: 1.4,
      scrollback: 5000,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    if (session.buffer) term.write(session.buffer)
    if (session.exitCode != null) term.write(`\r\n[会话已结束 ${session.exitCode}]\r\n`)
    const fitSafely = (): void => {
      try {
        fit.fit()
      } catch {
        /* hidden during the sheet animation */
      }
    }
    fitSafely()
    term.focus()
    const input = term.onData((data) => {
      void call(Ipc.sshTerminalInput, { id: session.id, data }).catch(() => undefined)
    })
    const offData = onEvent<{ sessionId: string; data: string }>(Events.terminalData, (payload) => {
      if (payload.sessionId === session.id) term.write(payload.data)
    })
    const offExit = onEvent<{ sessionId: string; code: number | null }>(Events.terminalExit, (payload) => {
      if (payload.sessionId !== session.id) return
      term.write(`\r\n[会话已结束 ${payload.code ?? ''}]\r\n`)
      exited.current()
    })
    const observer = new ResizeObserver(fitSafely)
    observer.observe(host.current)
    return () => {
      input.dispose()
      offData()
      offExit()
      observer.disconnect()
      term.dispose()
    }
  }, [session])

  return <div ref={host} className="h-[min(60vh,520px)] overflow-hidden rounded-lg bg-panel p-2" />
}
