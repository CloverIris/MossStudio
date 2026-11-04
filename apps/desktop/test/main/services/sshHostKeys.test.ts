import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrainingHost } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'

const scan = { stdout: '', stderr: '' }
const run = vi.fn(async () => ({ code: 0, stdout: scan.stdout, stderr: scan.stderr, timedOut: false }))
const dialog = { response: 0, shown: [] as unknown[] }
vi.mock('@main/lib/run', () => ({ run: (...args: unknown[]) => run(...(args as [])) }))
vi.mock('@main/services/sshTools', () => ({ getSshTools: () => ({ keyscan: 'ssh-keyscan' }), sshLocalPath: (path: string) => path }))
vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dialog: { showMessageBox: async (options: unknown) => { dialog.shown.push(options); return { response: dialog.response } } },
}))

const root = useTempDataRoot()
const host: TrainingHost = { id: 'h', name: 'H', kind: 'ssh', host: 'gpu.test', user: 'u', trainerRoot: '~', status: 'ok' }
const unknown = new Error('No ECDSA host key is known for gpu.test and you have requested strict checking.')
const key = (text: string) => Buffer.from(text).toString('base64')

beforeEach(() => {
  vi.resetModules()
  run.mockClear()
  scan.stdout = ''
  scan.stderr = ''
  dialog.response = 0
  dialog.shown = []
})
const load = () => import('@main/services/sshHostKeys')

describe('hostKeyArgs', () => {
  it('pins strict checking and adds the app known_hosts after the user files', async () => {
    const { hostKeyArgs } = await load()
    const args = hostKeyArgs()
    expect(args.slice(0, 2)).toEqual(['-o', 'StrictHostKeyChecking=yes'])
    expect(args[3]).toBe(`UserKnownHostsFile=~/.ssh/known_hosts ~/.ssh/known_hosts2 "${join(root(), 'ssh', 'known_hosts').replace(/\\/g, '/')}"`)
  })
})

describe('trustUnknownHost', () => {
  it('ignores errors that are not an unknown-host prompt', async () => {
    const { trustUnknownHost } = await load()
    expect(await trustUnknownHost(host, 'Connection refused')).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['bad host', '-oProxyCommand=x', 'a,b', 'h*', ''])('rejects unsafe host %j before scanning', async (address) => {
    const { trustUnknownHost } = await load()
    await expect(trustUnknownHost({ ...host, host: address }, unknown)).rejects.toThrow('不是有效的 SSH 主机地址')
    expect(run).not.toHaveBeenCalled()
  })

  it('stores every supported key type with the bare host on port 22 and ignores unsupported ones', async () => {
    scan.stdout = [
      `gpu.test ssh-ed25519 ${key('ed')}`,
      `gpu.test ecdsa-sha2-nistp256 ${key('ec')}`,
      `gpu.test ssh-dss ${key('dss')}`,
      `gpu.test ssh-rsa ${key('rsa')}`,
      `gpu.test ssh-ed25519 ${key('ed')}`,
    ].join('\r\n')
    const { trustUnknownHost } = await load()
    expect(await trustUnknownHost(host, unknown)).toBe(true)
    expect(run.mock.calls[0]).toEqual(['ssh-keyscan', ['-T', '8', '-p', '22', '-t', 'ed25519,ecdsa,rsa', 'gpu.test'], { timeoutMs: 30_000 }])
    const lines = readFileSync(join(root(), 'ssh', 'known_hosts'), 'utf8').trim().split('\n')
    expect(lines).toEqual([`gpu.test ssh-ed25519 ${key('ed')}`, `gpu.test ecdsa-sha2-nistp256 ${key('ec')}`, `gpu.test ssh-rsa ${key('rsa')}`])
    expect((dialog.shown[0] as { detail: string }).detail.match(/SHA256:/g)).toHaveLength(3)
  })

  it('appends to an existing known_hosts file', async () => {
    scan.stdout = `gpu.test ssh-ed25519 ${key('one')}`
    const { trustUnknownHost } = await load()
    await trustUnknownHost(host, unknown)
    scan.stdout = `[gpu.test]:2222 ssh-ed25519 ${key('two')}`
    await trustUnknownHost({ ...host, port: 2222 }, unknown)
    const text = readFileSync(join(root(), 'ssh', 'known_hosts'), 'utf8')
    expect(text).toContain(`gpu.test ssh-ed25519 ${key('one')}`)
    expect(text).toContain(`[gpu.test]:2222 ssh-ed25519 ${key('two')}`)
  })

  it('reports keyscan stderr when no key comes back', async () => {
    scan.stderr = 'connect timed out'
    const { trustUnknownHost } = await load()
    await expect(trustUnknownHost(host, unknown)).rejects.toThrow('无法读取 SSH 主机密钥：connect timed out')
  })
})
