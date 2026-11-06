import { safeStorage } from 'electron'
import { join } from 'node:path'
import { paths } from '../lib/paths'
import { atomicWriteJson, readJson } from './settings'

const file = (): string => join(paths.root(), 'hf-credentials.json')
const load = (): Record<string, string> => readJson(file(), {})

export function hasHfToken(scope = 'local'): boolean {
  return Boolean(load()[scope])
}

export function getHfToken(scope = 'local'): string | undefined {
  const encrypted = load()[scope]
  return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : undefined
}

export function saveHfToken(scope: string, token: string | null): void {
  const credentials = load()
  if (!token) delete credentials[scope]
  else {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    ) {
      throw new Error('系统安全存储不可用，无法保存 HF Token')
    }
    credentials[scope] = safeStorage.encryptString(token).toString('base64')
  }
  atomicWriteJson(file(), credentials)
}
