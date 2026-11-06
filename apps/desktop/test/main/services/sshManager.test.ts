/**
 * Port of tools/test-ssh-manager.mjs: SSH argument building, host-key trust,
 * credential storage and the training-host inventory working together. Only
 * the process runner, tool discovery, the dialog and secure storage are faked.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrainingHost } from '@shared/types'
import type { RunOptions, RunResult } from '@main/lib/run'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

type Call = [command: string, args: string[], options: RunOptions]
const state = {
  scan: '',
  error: '',
  response: 0,
  encryption: true,
  dialogs: [] as Array<{ detail?: string; defaultId?: number }>,
  calls: [] as Call[],
}

async function fakeRun(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  state.calls.push([command, args, options])
  if (command === 'ssh-keyscan') return { code: 0, stdout: state.scan, stderr: '', timedOut: false }
  if (state.error) {
    const error = state.error
    state.error = ''
    return { code: 255, stdout: '', stderr: error, timedOut: false }
  }
  return { code: 0, stdout: '', stderr: '', timedOut: false }
}

vi.mock('@main/lib/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/lib/run')>()),
  run: fakeRun,
  runStream: (command: string, args: string[], options: RunOptions) => fakeRun(command, args, options),
}))
vi.mock('@main/services/sshTools', () => ({
  getSshTools: () => ({ ssh: 'ssh', scp: 'scp', keyscan: 'ssh-keyscan' }),
  sshLocalPath: (path: string) => path,
}))
vi.mock('@main/services/devices', () => ({ listDevices: () => [] }))
vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@test/mocks/electron')>()
  return {
    ...actual,
    safeStorage: {
      ...actual.safeStorage,
      isEncryptionAvailable: () => state.encryption,
      getSelectedStorageBackend: () => 'gnome_libsecret',
    },
    dialog: {
      ...actual.dialog,
      showMessageBox: async (options: { detail?: string; defaultId?: number }) => {
        state.dialogs.push(options)
        return { response: state.response }
      },
    },
  }
})

const root = useTempDataRoot()
const settings = settingsFixture()
const input = { name: 'Fixture', host: '127.0.0.1', user: 'fixture', port: 2222, trainerRoot: '~/trainer' }
const host: TrainingHost = { ...input, id: 'fixture', kind: 'ssh', status: 'unchecked' }

async function modules() {
  return {
    ssh: await import('@main/services/ssh'),
    hosts: await import('@main/services/trainingHosts'),
    credentials: await import('@main/services/sshCredentials'),
    hostKeys: await import('@main/services/sshHostKeys'),
  }
}

/** A fresh trainingHosts module that must re-read hosts.json from disk. */
async function reloadHosts() {
  vi.resetModules()
  return import('@main/services/trainingHosts')
}

beforeEach(() => {
  vi.resetModules()
  Object.assign(state, { scan: '', error: '', response: 0, encryption: true, dialogs: [], calls: [] })
})

describe('ssh argument building', () => {
  it('uses strict host keys and public keys by default for commands, tunnels and SCP', async () => {
    const { ssh } = await modules()
    for (const args of [ssh.sshArgs(host, 'true'), ssh.sshTunnelArgs(host, 1234, 5678), ssh.scpArgs(host, '/remote', '/local')]) {
      expect(args).toContain('BatchMode=yes')
      expect(args).toContain('PreferredAuthentications=publickey')
      expect(args).toContain('StrictHostKeyChecking=yes')
      expect(args.some((arg) => arg.startsWith('UserKnownHostsFile=') && arg.includes('known_hosts'))).toBe(true)
    }
    const args = ssh.sshArgs({ ...host, identityFile: '~/.ssh/key with spaces' }, 'echo "hello"')
    expect(args).toContain(join(homedir(), '.ssh/key with spaces'))
    expect(args).toContain('IdentitiesOnly=yes')
    expect(ssh.sshEnv(host)).toEqual({})
  })
})

describe('host key trust', () => {
  it('confirms unknown hosts by fingerprint, persists the key, then retries with saved authentication', async () => {
    const { hosts } = await modules()
    const data = Buffer.from('fixture public host key').toString('base64')
    state.scan = `# banner ignored\n[127.0.0.1]:2222 ssh-ed25519 ${data}\n`
    state.error = 'No ED25519 host key is known for [127.0.0.1]:2222 and you have requested strict checking.\nHost key verification failed.'
    const saved = hosts.saveTrainingHost({ ...input, authMethod: 'password', password: 'secret' })
    const tested = await hosts.testTrainingHost(settings, saved.id)
    expect(tested.status).toBe('ok')
    expect(tested.authMethod).toBe('password')
    expect(state.dialogs).toHaveLength(1)
    const fingerprint = createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64').replace(/=+$/, '')
    expect(state.dialogs[0]!.detail).toContain(`SHA256:${fingerprint}`)
    expect(state.dialogs[0]!.defaultId).toBe(1)
    expect(readFileSync(join(root(), 'ssh/known_hosts'), 'utf8').trim()).toBe(`[127.0.0.1]:2222 ssh-ed25519 ${data}`)
    const sshCalls = state.calls.filter(([command]) => command === 'ssh')
    expect(sshCalls).toHaveLength(2)
    for (const [, args, options] of sshCalls) {
      expect(args).toContain('StrictHostKeyChecking=yes')
      expect(args).toContain('PreferredAuthentications=password')
      expect(options.env?.['CLOVER_SSH_PASSWORD']).toBe('secret')
    }
    expect((await reloadHosts()).listTrainingHosts(settings)[1]!.authMethod).toBe('password')
  })

  it('never records trust for cancelled prompts, changed keys or failed scans', async () => {
    const { hostKeys } = await modules()
    const unknown = new Error('No ED25519 host key is known for 127.0.0.1 and you have requested strict checking.')
    state.scan = `127.0.0.1 ssh-ed25519 ${Buffer.from('key').toString('base64')}\n`
    state.response = 1
    expect(await hostKeys.trustUnknownHost(host, unknown)).toBe(false)
    expect(existsSync(join(root(), 'ssh/known_hosts'))).toBe(false)
    const dialogCount = state.dialogs.length
    expect(
      await hostKeys.trustUnknownHost(host, new Error('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Host key verification failed.')),
    ).toBe(false)
    expect(state.dialogs).toHaveLength(dialogCount)
    state.scan = ''
    await expect(hostKeys.trustUnknownHost(host, unknown)).rejects.toThrow(/无法读取 SSH 主机密钥/)
    expect(existsSync(join(root(), 'ssh/known_hosts'))).toBe(false)
  })
})

describe('authentication methods', () => {
  it('survive reloads, edits that omit the method and failed connection tests', async () => {
    const { hosts } = await modules()
    for (const authMethod of ['identityFile', 'password', 'none'] as const) {
      const saved = hosts.saveTrainingHost({
        ...input,
        authMethod,
        password: authMethod === 'password' ? 'secret' : undefined,
        identityFile: '/fixture/key',
      })
      expect((await reloadHosts()).listTrainingHosts(settings).find((item) => item.id === saved.id)!.authMethod).toBe(authMethod)
      const current = await import('@main/services/trainingHosts')
      const edited = current.saveTrainingHost({ ...input, id: saved.id, name: 'Renamed' })
      expect(edited.authMethod).toBe(authMethod)
      if (authMethod === 'identityFile') expect(edited.identityFile).toBe('/fixture/key')
      state.error = 'Permission denied'
      await current.testTrainingHost(settings, saved.id)
      expect((await reloadHosts()).listTrainingHosts(settings).find((item) => item.id === saved.id)!.authMethod).toBe(authMethod)
    }
  })

  it('keeps passwords out of host data, argv and helper files and survives blank edits', async () => {
    const { credentials, ssh, hosts } = await modules()
    const password = '空 格 \' " $() & % ! 🔑'
    const saved = hosts.saveTrainingHost({ ...input, authMethod: 'password', password })
    expect(saved.hasPassword).toBe(true)
    expect((saved as { password?: string }).password).toBeUndefined()
    expect(readFileSync(join(root(), 'hosts.json'), 'utf8')).not.toContain(password)
    expect(readFileSync(join(root(), 'ssh-credentials.json'), 'utf8')).not.toContain(password)
    expect(credentials.getSshPassword(saved.id)).toBe(password)
    expect((await reloadHosts()).listTrainingHosts(settings)[1]!.authMethod).toBe('password')
    hosts.saveTrainingHost({ ...input, id: saved.id, authMethod: 'password', password: '' })
    expect(credentials.getSshPassword(saved.id)).toBe(password)
    state.calls = []
    await ssh.sshExec(saved, 'true')
    await ssh.sshStream(saved, 'true', 1000, () => undefined)
    await ssh.scpFrom(saved, '/remote', '/local')
    expect(state.calls).toHaveLength(3)
    for (const [, args, options] of state.calls) {
      expect(args).toContain('BatchMode=no')
      expect(args).toContain('PreferredAuthentications=password')
      expect(args.some((arg) => arg.includes(password))).toBe(false)
      expect(options.env?.['CLOVER_SSH_PASSWORD']).toBe(password)
      expect(options.env?.['SSH_ASKPASS_REQUIRE']).toBe('force')
    }
    expect(readFileSync(join(root(), 'cache/ssh-askpass/askpass.cjs'), 'utf8')).not.toContain(password)
    expect(process.env['CLOVER_SSH_PASSWORD']).toBeUndefined()
  })

  it('clears credentials and stale identity files when switching methods or deleting hosts', async () => {
    const { hosts, credentials, ssh } = await modules()
    const saved = hosts.saveTrainingHost({ ...input, authMethod: 'password', password: 'secret', identityFile: '/unused' })
    expect(saved.identityFile).toBeUndefined()
    const none = hosts.saveTrainingHost({ ...input, id: saved.id, authMethod: 'none' })
    expect(credentials.hasSshPassword(saved.id)).toBe(false)
    expect(none.hasPassword).toBe(false)
    for (const args of [ssh.sshArgs(none, 'true'), ssh.scpArgs(none, '/remote', '/local'), ssh.sshTunnelArgs(none, 1234, 5678)]) {
      expect(args).toContain('PreferredAuthentications=none')
      expect(args).toContain('PubkeyAuthentication=no')
      expect(args).toContain('PasswordAuthentication=no')
      expect(args).not.toContain('-i')
    }
    expect(() => hosts.saveTrainingHost({ ...input, id: saved.id, authMethod: 'password' })).toThrow(/密码/)
    hosts.saveTrainingHost({ ...input, id: saved.id, authMethod: 'password', password: 'new' })
    hosts.removeTrainingHost(saved.id)
    expect(credentials.hasSshPassword(saved.id)).toBe(false)
  })

  it('fails without saving the host or password when encryption is unavailable', async () => {
    const { hosts } = await modules()
    state.encryption = false
    expect(() => hosts.saveTrainingHost({ ...input, authMethod: 'password', password: 'secret' })).toThrow(/安全存储/)
    expect(hosts.listTrainingHosts(settings)).toHaveLength(1)
  })
})
