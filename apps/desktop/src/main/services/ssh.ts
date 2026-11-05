import { homedir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TrainingHost } from '@shared/types'
import { run, runStream, type RunResult } from '../lib/run'
import { paths } from '../lib/paths'
import { getSshPassword } from './sshCredentials'
import { hostKeyArgs } from './sshHostKeys'
import { getSshTools, sshLocalPath } from './sshTools'

let askpass: string | undefined

export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

export function targetOf(host: TrainingHost): string {
  if (!host.host || !host.user) throw new Error('SSH host 配置不完整')
  return `${host.user}@${host.host}`
}

function authArgs(host: TrainingHost): string[] {
  const method = host.authMethod ?? 'identityFile'
  if (method === 'password') {
    return [
      '-o', 'BatchMode=no',
      '-o', 'PreferredAuthentications=password',
      '-o', 'PasswordAuthentication=yes',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'NumberOfPasswordPrompts=1',
    ]
  }
  if (method === 'none') {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'PreferredAuthentications=none',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'GSSAPIAuthentication=no',
      '-o', 'HostbasedAuthentication=no',
    ]
  }
  const args = ['-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey']
  if (host.identityFile) args.push('-o', 'IdentitiesOnly=yes', '-i', sshLocalPath(expandHome(host.identityFile)))
  return args
}

/** Only the SSH child inherits the password; never put it in argv or helper files. */
export function sshEnv(host: TrainingHost): NodeJS.ProcessEnv {
  if (host.authMethod !== 'password') return {}
  const password = getSshPassword(host.id)
  if (!askpass) {
    const directory = join(paths.cache(), 'ssh-askpass')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const script = join(directory, 'askpass.cjs')
    writeFileSync(script, "process.stdout.write(process.env.CLOVER_SSH_PASSWORD + '\\n')\n", { mode: 0o600 })
    if (process.platform === 'win32' && !getSshTools().shell) {
      // Win32 OpenSSH accepts an executable with arguments in SSH_ASKPASS.
      askpass = `"${process.execPath}" "${script}"`
    } else {
      const launcher = join(directory, 'askpass.sh')
      writeFileSync(launcher, '#!/bin/sh\nexec "$CLOVER_SSH_NODE" "$CLOVER_SSH_ASKPASS_SCRIPT"\n', { mode: 0o700 })
      askpass = sshLocalPath(launcher)
    }
  }
  return {
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env['DISPLAY'] || ':0',
    ELECTRON_RUN_AS_NODE: '1',
    CLOVER_SSH_NODE: sshLocalPath(process.execPath),
    CLOVER_SSH_ASKPASS_SCRIPT: join(paths.cache(), 'ssh-askpass', 'askpass.cjs').replace(/\\/g, '/'),
    CLOVER_SSH_PASSWORD: password,
  }
}

function commonArgs(host: TrainingHost): string[] {
  if (host.kind !== 'ssh' || !host.host || !host.user) throw new Error('不是有效的 SSH 主机')
  const args = [
    ...authArgs(host),
    ...hostKeyArgs(),
    '-o',
    'ConnectTimeout=12',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ]
  if (host.port) args.push('-p', String(host.port))
  return args
}

export function sshArgs(host: TrainingHost, command: string): string[] {
  return [...commonArgs(host), targetOf(host), `bash -lc ${posixQuote(command)}`]
}

/** Quote/lifecycle wrapper for a long-running remote process started over SSH. */
export function sshTunnelArgs(host: TrainingHost, localPort: number, remotePort: number): string[] {
  return [
    ...commonArgs(host),
    '-N',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    targetOf(host),
  ]
}

export function sshCommand(): string {
  return getSshTools().ssh
}

export function scpCommand(): string {
  return getSshTools().scp
}

export function scpArgs(host: TrainingHost, remotePath: string, localPath: string): string[] {
  if (host.kind !== 'ssh' || !host.host || !host.user) throw new Error('不是有效的 SSH 训练主机')
  const args = [
    '-S', sshCommand(),
    ...authArgs(host),
    ...hostKeyArgs(),
    '-o', 'ConnectTimeout=12',
  ]
  if (host.port) args.push('-P', String(host.port))
  args.push(`${targetOf(host)}:${remotePath}`, sshLocalPath(localPath))
  return args
}

export async function scpFrom(host: TrainingHost, remotePath: string, localPath: string, timeoutMs = 180_000): Promise<RunResult> {
  return run(scpCommand(), scpArgs(host, remotePath, localPath), { timeoutMs, env: sshEnv(host) })
}

export async function remoteAbsolute(host: TrainingHost, path: string): Promise<string> {
  if (!path.startsWith('~/')) return path
  const home = await sshExec(host, 'printf %s "$HOME"', 15_000)
  if (home.code !== 0) throw new Error(home.stderr.trim() || '无法读取远端 HOME')
  return `${home.stdout.trim()}/${path.slice(2)}`
}

export async function sshExec(host: TrainingHost, command: string, timeoutMs = 60_000, input?: string): Promise<RunResult> {
  return run(sshCommand(), sshArgs(host, command), { timeoutMs, env: sshEnv(host), input })
}

/**
 * Writes `data` to `remotePath` on the host (parent folders created), through
 * base64 on the SSH session's stdin: no scp, so no banner or quoting quirks,
 * and the file appears whole (written beside it, then renamed).
 */
export async function sshWriteFile(host: TrainingHost, remotePath: string, data: Uint8Array, timeoutMs = 180_000): Promise<void> {
  const slash = remotePath.lastIndexOf('/')
  const dir = slash > 0 ? remotePath.slice(0, slash) : '.'
  const temporary = `${remotePath}.part`
  const command = `mkdir -p ${posixQuote(dir)} && base64 -d > ${posixQuote(temporary)} && mv -f ${posixQuote(temporary)} ${posixQuote(remotePath)}`
  const result = await sshExec(host, command, timeoutMs, Buffer.from(data).toString('base64'))
  if (result.code !== 0) throw new Error(result.stderr.trim() || `上传到远端失败：${remotePath}`)
}

export async function sshStream(
  host: TrainingHost,
  command: string,
  timeoutMs: number,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  input?: string,
): Promise<RunResult> {
  return runStream(sshCommand(), sshArgs(host, command), { timeoutMs, env: sshEnv(host), input }, onLine)
}

export async function remotePathExists(host: TrainingHost, path: string, timeoutMs = 15_000): Promise<boolean> {
  const result = await sshExec(host, `test -d ${posixQuote(path)} && echo yes || echo no`, timeoutMs)
  return result.stdout.trim().endsWith('yes')
}

export async function remoteFreePort(host: TrainingHost): Promise<number> {
  const code =
    'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
  const result = await sshExec(host, `python3 -c ${posixQuote(code)}`, 15_000)
  const port = Number.parseInt(result.stdout.trim().split('\n').pop() ?? '', 10)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`无法在远端分配端口：${(result.stderr || result.stdout).trim().slice(-500)}`)
  }
  return port
}

export interface RemoteProbe {
  os: string
  gpu: string
  git: string
  uv: string
  python: string
  rootReady: boolean
  raw: string
}

function section(output: string, name: string): string {
  const match = output.match(new RegExp(`@@${name}@@([\\s\\S]*?)(?=@@[A-Z_]+@@|$)`))
  return (match?.[1] ?? '').trim()
}

export async function probeHost(host: TrainingHost): Promise<RemoteProbe> {
  const root = host.trainerRoot
  const command = [
    'printf "@@OS@@"',
    'uname -s -m 2>/dev/null || true',
    'printf "@@GPU@@"',
    'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || true',
    'printf "@@GIT@@"',
    'git --version 2>/dev/null || true',
    'printf "@@UV@@"',
    'command -v uv 2>/dev/null || true',
    'printf "@@PY@@"',
    '(python3 --version 2>&1 || python --version 2>&1) || true',
    'printf "@@ROOT@@"',
    `test -d ${posixQuote(root)} && echo yes || echo no`,
  ].join('\n')
  const result = await sshExec(host, command, 30_000)
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `ssh 退出码 ${result.code}`)
  }
  return {
    os: section(result.stdout, 'OS'),
    gpu: section(result.stdout, 'GPU'),
    git: section(result.stdout, 'GIT'),
    uv: section(result.stdout, 'UV'),
    python: section(result.stdout, 'PY'),
    rootReady: section(result.stdout, 'ROOT') === 'yes',
    raw: result.stdout,
  }
}

export function sshTerminalArgs(host: TrainingHost, command = 'bash -l'): string[] {
  return [...commonArgs(host), '-tt', targetOf(host), command]
}
