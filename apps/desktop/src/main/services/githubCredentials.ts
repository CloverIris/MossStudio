import { safeStorage } from 'electron'
import { join } from 'node:path'
import { paths } from '../lib/paths'
import { atomicWriteJson, readJson } from './settings'

/**
 * The GitHub token, encrypted with the system's secure storage like the Hugging Face token
 * (hfCredentials.ts). Settings only ever say whether one is saved (hasGithubToken); the value
 * never reaches the renderer or settings.json.
 */
const file = (): string => join(paths.root(), 'github-credentials.json')
const load = (): { token?: string } => readJson(file(), {})

export function hasGithubToken(): boolean {
  return Boolean(load().token)
}

export function getGithubToken(): string | undefined {
  const encrypted = load().token
  return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : undefined
}

export function saveGithubToken(token: string | null): void {
  if (!token) {
    atomicWriteJson(file(), {})
    return
  }
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('系统安全存储不可用，无法保存 GitHub 令牌')
  }
  atomicWriteJson(file(), { token: safeStorage.encryptString(token).toString('base64') })
}
