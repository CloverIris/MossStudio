import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { getTrainingHost } from './trainingHosts'
import { sshCommand, sshEnv, sshTerminalArgs } from './ssh'
import { getSettings } from './settings'

export interface SshTerminalSession {
  id: string
  hostId: string
  hostName: string
  startedAt: string
  exitCode?: number | null
  buffer: string
}

const sessions = new Map<string, { meta: SshTerminalSession; child: ChildProcessWithoutNullStreams }>()

export function listSshTerminals(): SshTerminalSession[] {
  return [...sessions.values()].map(({ meta }) => ({ ...meta }))
}

export function openSshTerminal(hostId: string): SshTerminalSession {
  const host = getTrainingHost(getSettings(), hostId)
  if (!host || host.kind !== 'ssh') throw new Error('SSH 主机不存在')
  const existing = [...sessions.values()].find((item) => item.meta.hostId === hostId && item.meta.exitCode == null)
  if (existing) return { ...existing.meta }
  const meta: SshTerminalSession = {
    id: `tty-${randomUUID().slice(0, 8)}`,
    hostId,
    hostName: host.name,
    startedAt: new Date().toISOString(),
    buffer: '',
  }
  const child = spawn(sshCommand(), sshTerminalArgs(host), {
    env: sshEnv(host),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  sessions.set(meta.id, { meta, child })
  const append = (data: string): void => {
    meta.buffer = `${meta.buffer}${data}`.slice(-200_000)
    emit(Events.terminalData, { sessionId: meta.id, data })
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => append(chunk))
  child.stderr.on('data', (chunk: string) => append(chunk))
  child.on('error', (error) => append(`\r\n[ssh] ${String(error)}\r\n`))
  child.on('close', (code) => {
    meta.exitCode = code
    append(`\r\n[ssh 会话结束 ${code ?? 'null'}]\r\n`)
    emit(Events.terminalExit, { sessionId: meta.id, code })
  })
  return { ...meta }
}

export function inputSshTerminal(id: string, data: string): void {
  const session = sessions.get(id)
  if (!session || session.meta.exitCode != null) throw new Error('SSH 会话已结束')
  session.child.stdin.write(data)
}

export function closeSshTerminal(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  try {
    session.child.kill('SIGTERM')
  } catch {
    /* gone */
  }
}

export function closeAllSshTerminals(): void {
  for (const id of sessions.keys()) closeSshTerminal(id)
  sessions.clear()
}

export function getSshTerminal(hostId: string): SshTerminalSession | undefined {
  const found = [...sessions.values()].reverse().find((item) => item.meta.hostId === hostId && item.meta.exitCode == null)
  return found ? { ...found.meta } : undefined
}
