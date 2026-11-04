import { win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Port of tools/test-ssh-manager.mjs (Git-for-Windows SSH suite discovery).
 * Platform, env, fs and the registry probe are all faked so the Windows search
 * order runs on any host.
 */
const fake = {
  files: new Set<string>(),
  registry: {} as Record<string, string>,
  realpath: (path: string): string => path,
  probes: [] as Array<{ command: string; args: string[] }>,
}
const normal = (path: string): string => win32.normalize(path).toLowerCase()

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: string) => fake.files.has(normal(String(path))),
    realpathSync: (path: string) => fake.realpath(path),
  }
})
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: (command: string, args: string[]) => {
    fake.probes.push({ command, args })
    const root = fake.registry[args[1]!]
    return { stdout: root ? `InstallPath    REG_SZ    ${root}\r\n` : '' }
  },
}))

const originalEnv = process.env
const originalPlatform = process.platform

async function tools(options: { env?: Record<string, string>; files?: string[]; registry?: Record<string, string>; platform?: NodeJS.Platform; realpath?: (path: string) => string } = {}) {
  vi.resetModules()
  fake.files = new Set((options.files ?? []).map(normal))
  fake.registry = options.registry ?? {}
  fake.realpath = options.realpath ?? ((path) => path)
  fake.probes = []
  process.env = { ...(options.env ?? {}) }
  Object.defineProperty(process, 'platform', { value: options.platform ?? 'win32', configurable: true })
  return import('@main/services/sshTools')
}

const suiteFiles = (root: string) => ['ssh.exe', 'scp.exe', 'ssh-keyscan.exe', 'sh.exe', 'msys-2.0.dll'].map((name) => win32.join(root, 'usr/bin', name))

beforeEach(() => { fake.probes = [] })
afterEach(() => {
  process.env = originalEnv
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

describe('getSshTools on Windows', () => {
  it('finds Git on PATH in custom locations with spaces and keeps the SSH suite together', async () => {
    const root = 'D:\\Developer Tools\\Git'
    const api = await tools({ env: { Path: 'C:\\Windows\\System32;"D:\\Developer Tools\\Git\\cmd"' }, files: [win32.join(root, 'cmd/git.exe'), ...suiteFiles(root)] })
    const selected = api.getSshTools()
    expect(selected.ssh).toBe(win32.join(root, 'usr/bin/ssh.exe'))
    expect(selected.scp).toBe(win32.join(root, 'usr/bin/scp.exe'))
    expect(selected.keyscan).toBe(win32.join(root, 'usr/bin/ssh-keyscan.exe'))
    expect(selected.shell).toBe(win32.join(root, 'usr/bin/sh.exe'))
    expect(api.sshLocalPath('D:\\Key Files\\id_ed25519')).toBe('/d/Key Files/id_ed25519')
    expect(fake.probes).toHaveLength(0)
  })

  it('finds Git via the registry and caches the detection', async () => {
    const root = 'E:\\Portable Git'
    const api = await tools({ registry: { 'HKCU\\Software\\GitForWindows': root }, files: suiteFiles(root) })
    expect(api.getSshTools().ssh).toBe(win32.join(root, 'usr/bin/ssh.exe'))
    const calls = fake.probes.length
    expect(fake.probes[0]).toEqual({ command: 'reg.exe', args: ['query', 'HKCU\\Software\\GitForWindows', '/v', 'InstallPath'] })
    api.getSshTools()
    expect(fake.probes).toHaveLength(calls)
  })

  it('checks HKLM after HKCU', async () => {
    const root = 'F:\\Git'
    const api = await tools({ registry: { 'HKLM\\Software\\GitForWindows': root }, files: suiteFiles(root) })
    expect(api.getSshTools().ssh).toBe(win32.join(root, 'usr/bin/ssh.exe'))
    expect(fake.probes.map((probe) => probe.args[1])).toEqual(['HKCU\\Software\\GitForWindows', 'HKLM\\Software\\GitForWindows'])
  })

  it('finds common install roots and symlinked PATH entries', async () => {
    const root = 'E:\\Portable Git'
    const common = await tools({ env: { ProgramFiles: root }, files: suiteFiles(win32.join(root, 'Git')) })
    expect(common.getSshTools().ssh).toBe(win32.join(root, 'Git/usr/bin/ssh.exe'))
    const linked = await tools({ env: { PATH: 'C:\\links' }, files: ['C:\\links\\git.exe', ...suiteFiles(root)], realpath: () => win32.join(root, 'bin/git.exe') })
    expect(linked.getSshTools().ssh).toBe(win32.join(root, 'usr/bin/ssh.exe'))
  })

  it('falls back to Windows OpenSSH as a suite when Git is incomplete', async () => {
    const root = 'D:\\Git'
    const system = 'C:\\Windows\\System32\\OpenSSH'
    const api = await tools({
      env: { PATH: `${root}\\cmd` },
      files: [win32.join(root, 'cmd/git.exe'), win32.join(root, 'usr/bin/ssh.exe'), ...['ssh.exe', 'scp.exe', 'ssh-keyscan.exe'].map((name) => win32.join(system, name))],
    })
    expect(api.getSshTools().ssh).toBe(win32.join(system, 'ssh.exe'))
    expect(api.getSshTools().shell).toBeUndefined()
    expect(api.sshLocalPath('D:\\Files\\key')).toBe('D:\\Files\\key')
  })

  it('uses plain command names when nothing is installed', async () => {
    const api = await tools()
    expect(api.getSshTools()).toEqual({ ssh: 'ssh', scp: 'scp', keyscan: 'ssh-keyscan', shell: undefined })
  })

  it('keeps explicit overrides authoritative', async () => {
    const system = 'C:\\Windows\\System32\\OpenSSH'
    const api = await tools({
      env: { CLOVER_SSH_BIN: win32.join(system, 'ssh.exe'), CLOVER_SCP_BIN: 'custom-scp', CLOVER_SSH_KEYSCAN_BIN: 'custom-keyscan' },
      files: suiteFiles('D:\\Git'),
    })
    expect(api.getSshTools()).toEqual({ ssh: win32.join(system, 'ssh.exe'), scp: 'custom-scp', keyscan: 'custom-keyscan', shell: undefined })
  })
})

describe('getSshTools on macOS/Linux', () => {
  it.each(['darwin', 'linux'] as const)('%s always uses the system suite without probing', async (platform) => {
    const root = 'D:\\Git'
    const api = await tools({ platform, env: { PATH: `${root}\\cmd` }, files: [win32.join(root, 'cmd/git.exe'), ...suiteFiles(root)] })
    expect(api.getSshTools()).toEqual({ ssh: 'ssh', scp: 'scp', keyscan: 'ssh-keyscan', shell: undefined })
    expect(api.sshLocalPath('/Users/fixture/My Keys/id_ed25519')).toBe('/Users/fixture/My Keys/id_ed25519')
    expect(fake.probes).toHaveLength(0)
  })

  it('derives scp/keyscan next to an overridden ssh binary when they exist', async () => {
    const api = await tools({ platform: 'linux', env: { CLOVER_SSH_BIN: '/opt/ssh/bin/ssh' }, files: ['/opt/ssh/bin/scp'] })
    const selected = api.getSshTools()
    expect(selected.ssh).toBe('/opt/ssh/bin/ssh')
    expect(selected.scp).toBe('/opt/ssh/bin/scp')
    expect(selected.keyscan).toBe('ssh-keyscan')
  })
})
