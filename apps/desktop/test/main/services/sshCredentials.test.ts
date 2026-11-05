import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot } from '@test/helpers/tempDir'

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@test/mocks/electron')>()
  return { ...actual, safeStorage: { ...actual.safeStorage, getSelectedStorageBackend: () => 'gnome_libsecret' } }
})

const root = useTempDataRoot()
beforeEach(() => vi.resetModules())
const load = () => import('@main/services/sshCredentials')

describe('ssh credentials', () => {
  it('round-trips passwords per host with owner-only permissions', async () => {
    const { saveSshPassword, getSshPassword, hasSshPassword } = await load()
    saveSshPassword('a', 'pa')
    saveSshPassword('b', 'pb')
    expect(getSshPassword('a')).toBe('pa')
    expect(getSshPassword('b')).toBe('pb')
    expect(hasSshPassword('a')).toBe(true)
    if (process.platform !== 'win32') expect(statSync(join(root(), 'ssh-credentials.json')).mode & 0o777).toBe(0o600)
  })

  it('throws a helpful error for a host without a password', async () => {
    const { getSshPassword, hasSshPassword } = await load()
    expect(hasSshPassword('x')).toBe(false)
    expect(() => getSshPassword('x')).toThrow('请先为该 SSH 设备设置密码')
  })

  it('removes a password and is a no-op for unknown ids', async () => {
    const { saveSshPassword, removeSshPassword, hasSshPassword } = await load()
    removeSshPassword('missing')
    saveSshPassword('a', 'pa')
    removeSshPassword('a')
    expect(hasSshPassword('a')).toBe(false)
  })

  it('surfaces a corrupt credential file instead of silently dropping passwords', async () => {
    writeFileSync(join(root(), 'ssh-credentials.json'), '{')
    const { hasSshPassword } = await load()
    expect(() => hasSshPassword('a')).toThrow()
  })
})
