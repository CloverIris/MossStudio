import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot } from '@test/helpers/tempDir'

type SafeStorage = (typeof import('@test/mocks/electron'))['safeStorage']

const root = useTempDataRoot()
const file = () => join(root(), 'hf-credentials.json')
let safeStorage: SafeStorage
let backend = 'gnome_libsecret'

beforeEach(async () => {
  vi.resetModules()
  backend = 'gnome_libsecret'
  safeStorage = (await import('electron')).safeStorage as SafeStorage
  // Linux code paths ask which keyring backs safeStorage.
  vi.spyOn(safeStorage, 'getSelectedStorageBackend').mockImplementation(() => backend)
})
const load = () => import('@main/services/hfCredentials')

describe('hf credentials', () => {
  it('reports no token without a credential file', async () => {
    const { hasHfToken, getHfToken } = await load()
    expect(hasHfToken()).toBe(false)
    expect(getHfToken()).toBeUndefined()
  })

  it('stores tokens encrypted per scope and decrypts them back', async () => {
    const { saveHfToken, hasHfToken, getHfToken } = await load()
    saveHfToken('local', 'hf_secret')
    saveHfToken('ssh-a', 'hf_remote')
    expect(readFileSync(file(), 'utf8')).not.toContain('hf_secret')
    expect(hasHfToken()).toBe(true)
    expect(getHfToken()).toBe('hf_secret')
    expect(getHfToken('ssh-a')).toBe('hf_remote')
    expect(hasHfToken('other')).toBe(false)
  })

  it('removes a scope when saving an empty token', async () => {
    const { saveHfToken, hasHfToken } = await load()
    saveHfToken('local', 'hf_secret')
    saveHfToken('local', null)
    expect(hasHfToken()).toBe(false)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({})
  })

  it('refuses to save when secure storage is unavailable or plaintext on Linux', async () => {
    const { saveHfToken } = await load()
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
    expect(() => saveHfToken('local', 'x')).toThrow('系统安全存储不可用')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    if (process.platform === 'linux') {
      backend = 'basic_text'
      expect(() => saveHfToken('local', 'x')).toThrow('系统安全存储不可用')
    }
  })

  it('treats a corrupt credential file as empty', async () => {
    writeFileSync(file(), '{')
    const { hasHfToken } = await load()
    expect(hasHfToken()).toBe(false)
  })
})
