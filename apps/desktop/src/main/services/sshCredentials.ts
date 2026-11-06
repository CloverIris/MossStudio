import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../lib/paths'

const file = (): string => join(paths.root(), 'ssh-credentials.json')

function load(): Record<string, string> {
  if (!existsSync(file())) return {}
  return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, string>
}

export function hasSshPassword(id: string): boolean {
  return Boolean(load()[id])
}

export function saveSshPassword(id: string, password: string): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('系统安全存储不可用，无法保存 SSH 密码')
  }
  const credentials = load()
  credentials[id] = safeStorage.encryptString(password).toString('base64')
  writeFileSync(file(), JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600 })
}

export function getSshPassword(id: string): string {
  const encrypted = load()[id]
  if (!encrypted) throw new Error('请先为该 SSH 设备设置密码')
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

export function removeSshPassword(id: string): void {
  const credentials = load()
  if (!(id in credentials)) return
  delete credentials[id]
  writeFileSync(file(), JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600 })
}
