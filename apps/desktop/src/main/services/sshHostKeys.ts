import { dialog } from 'electron'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TrainingHost } from '@shared/types'
import { paths } from '../lib/paths'
import { run } from '../lib/run'
import { getSshTools, sshLocalPath } from './sshTools'

const directory = (): string => join(paths.root(), 'ssh')
const knownHosts = (): string => join(directory(), 'known_hosts')

export function hostKeyArgs(): string[] {
  const file = sshLocalPath(knownHosts()).replace(/\\/g, '/').replace(/"/g, '\\"')
  return ['-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=~/.ssh/known_hosts ~/.ssh/known_hosts2 "${file}"`]
}

/** Ask only for unknown hosts; a changed/revoked key must keep failing strict checking. */
export async function trustUnknownHost(host: TrainingHost, error: unknown): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error)
  if (!/No \S+ host key is known for /i.test(message)) return false
  if (host.kind !== 'ssh' || !host.host || /[\s,*?!|/]/.test(host.host) || host.host.startsWith('-')) {
    throw new Error('不是有效的 SSH 主机地址')
  }
  const port = host.port ?? 22
  const result = await run(getSshTools().keyscan, ['-T', '8', '-p', String(port), '-t', 'ed25519,ecdsa,rsa', host.host], {
    timeoutMs: 30_000,
  })
  const keys = new Map<string, { type: string; fingerprint: string }>()
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\S+ (ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]+={0,2})$/)
    if (!match) continue
    const [, type, data] = match
    const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64').replace(/=+$/, '')}`
    keys.set(`${type} ${data}`, { type, fingerprint })
  }
  if (!keys.size) throw new Error(`无法读取 SSH 主机密钥：${result.stderr.trim() || '服务器没有返回支持的主机密钥'}`)
  const answer = await dialog.showMessageBox({
    type: 'question',
    title: '确认 SSH 主机密钥',
    message: `首次连接 ${host.host}:${port}`,
    detail: `请与服务器管理员提供的指纹核对，确认后将记住此主机。\n\n${[...keys.values()].map((key) => `${key.type}\n${key.fingerprint}`).join('\n\n')}`,
    buttons: ['信任并连接', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (answer.response !== 0) return false
  // Store the exact keys shown above; a substitution before retry still fails verification.
  const address = port === 22 ? host.host : `[${host.host}]:${port}`
  mkdirSync(directory(), { recursive: true, mode: 0o700 })
  appendFileSync(knownHosts(), `\n${[...keys.keys()].map((key) => `${address} ${key}`).join('\n')}\n`, { mode: 0o600 })
  return true
}
