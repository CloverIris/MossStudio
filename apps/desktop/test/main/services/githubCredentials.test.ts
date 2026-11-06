import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot } from '@test/helpers/tempDir'

type SafeStorage = (typeof import('@test/mocks/electron'))['safeStorage']

const root = useTempDataRoot()
const credentials = () => join(root(), 'github-credentials.json')
const settingsFile = () => join(root(), 'settings.json')
let safeStorage: SafeStorage
let backend = 'gnome_libsecret'

beforeEach(async () => {
  vi.resetModules()
  backend = 'gnome_libsecret'
  safeStorage = (await import('electron')).safeStorage as SafeStorage
  vi.spyOn(safeStorage, 'getSelectedStorageBackend').mockImplementation(() => backend)
})

describe('github credentials', () => {
  it('stores the token encrypted and decrypts it back; an empty token removes it', async () => {
    const { saveGithubToken, hasGithubToken, getGithubToken } = await import('@main/services/githubCredentials')
    expect(hasGithubToken()).toBe(false)
    saveGithubToken('github_pat_secret')
    expect(readFileSync(credentials(), 'utf8')).not.toContain('github_pat_secret')
    expect(getGithubToken()).toBe('github_pat_secret')
    saveGithubToken(null)
    expect(hasGithubToken()).toBe(false)
  })

  it('refuses to save without secure storage', async () => {
    const { saveGithubToken } = await import('@main/services/githubCredentials')
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
    expect(() => saveGithubToken('x')).toThrow('系统安全存储不可用')
  })
})

describe('a plain GitHub token in settings.json (from before encryption)', () => {
  it('moves into the encrypted store and leaves settings.json', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ githubToken: ' github_pat_old ' }))
    const settings = await import('@main/services/settings')
    expect(settings.getSettings().hasGithubToken).toBe(true)
    expect('githubToken' in settings.getSettings()).toBe(false)
    expect(readFileSync(settingsFile(), 'utf8')).not.toContain('github_pat_old')
    const { getGithubToken } = await import('@main/services/githubCredentials')
    expect(getGithubToken()).toBe('github_pat_old')
  })

  it('keeps working, and stays in the file, where there is no secure storage', async () => {
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
    writeFileSync(settingsFile(), JSON.stringify({ githubToken: 'github_pat_old' }))
    const settings = await import('@main/services/settings')
    expect(settings.getSettings().hasGithubToken).toBe(true)
    expect(settings.legacyGithubToken()).toBe('github_pat_old')
    // Saving any other setting must not drop it from the file, nor expose it to the renderer.
    const next = settings.updateSettings({ theme: 'dark' })
    expect('githubToken' in next).toBe(false)
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8')).githubToken).toBe('github_pat_old')
  })
})
