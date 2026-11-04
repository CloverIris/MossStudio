import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrainingHost } from '@shared/types'
import type { RunResult } from '@main/lib/run'
import { useTempDataRoot } from '@test/helpers/tempDir'

const run = vi.fn<(command: string, args: string[], options?: unknown) => Promise<RunResult>>()
const tools = { shell: undefined as string | undefined }
vi.mock('@main/lib/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/lib/run')>()),
  run: (command: string, args: string[], options?: unknown) => run(command, args, options),
  runStream: (command: string, args: string[], options?: unknown) => run(command, args, options),
}))
vi.mock('@main/services/sshTools', () => ({
  getSshTools: () => ({ ssh: 'ssh', scp: 'scp', keyscan: 'ssh-keyscan', shell: tools.shell }),
  sshLocalPath: (path: string) => path,
}))
vi.mock('@main/services/sshCredentials', () => ({ getSshPassword: () => 'pw' }))

const root = useTempDataRoot()
const host: TrainingHost = { id: 'h', name: 'H', kind: 'ssh', host: 'gpu.test', user: 'moss', port: 2200, trainerRoot: '~/trainer', status: 'ok' }
const ok = (stdout = '', stderr = '', code = 0): RunResult => ({ code, stdout, stderr, timedOut: false })

beforeEach(() => {
  vi.resetModules()
  run.mockReset()
  tools.shell = undefined
})
const load = () => import('@main/services/ssh')

describe('quoting and targets', () => {
  it('posixQuote wraps and escapes single quotes', async () => {
    const { posixQuote } = await load()
    expect(posixQuote("it's")).toBe(`'it'\\''s'`)
    expect(posixQuote('')).toBe("''")
  })

  it('targetOf requires host and user', async () => {
    const { targetOf } = await load()
    expect(targetOf(host)).toBe('moss@gpu.test')
    expect(() => targetOf({ ...host, user: '' })).toThrow('SSH host 配置不完整')
  })
})

describe('argument builders', () => {
  it('sshArgs runs the command through a quoted login shell with the port', async () => {
    const { sshArgs } = await load()
    const args = sshArgs(host, "echo 'x'")
    expect(args.slice(-2)).toEqual(['moss@gpu.test', `bash -lc 'echo '\\''x'\\'''`])
    expect(args.join(' ')).toContain('-p 2200')
    expect(args).toContain('ConnectTimeout=12')
  })

  it('omits the port flag when unset and rejects non-SSH hosts', async () => {
    const { sshArgs, scpArgs } = await load()
    expect(sshArgs({ ...host, port: undefined }, 'true')).not.toContain('-p')
    expect(() => sshArgs({ ...host, kind: 'local' }, 'true')).toThrow('不是有效的 SSH 主机')
    expect(() => scpArgs({ ...host, host: undefined }, '/a', '/b')).toThrow('不是有效的 SSH 训练主机')
  })

  it('tunnel, scp and terminal arguments place target and flags correctly', async () => {
    const { sshTunnelArgs, scpArgs, sshTerminalArgs } = await load()
    expect(sshTunnelArgs(host, 1000, 2000).slice(-4)).toEqual(['-N', '-L', '127.0.0.1:1000:127.0.0.1:2000', 'moss@gpu.test'])
    const scp = scpArgs(host, '/remote/file', '/local/file')
    expect(scp.slice(0, 2)).toEqual(['-S', 'ssh'])
    expect(scp.join(' ')).toContain('-P 2200')
    expect(scp.slice(-2)).toEqual(['moss@gpu.test:/remote/file', '/local/file'])
    expect(sshTerminalArgs(host).slice(-3)).toEqual(['-tt', 'moss@gpu.test', 'bash -l'])
  })
})

describe('sshEnv', () => {
  it('creates the askpass helper once and passes the password only via env', async () => {
    const { sshEnv } = await load()
    const env = sshEnv({ ...host, authMethod: 'password' })
    expect(env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force', CLOVER_SSH_PASSWORD: 'pw', ELECTRON_RUN_AS_NODE: '1' })
    const script = join(root(), 'cache', 'ssh-askpass', 'askpass.cjs')
    expect(readFileSync(script, 'utf8')).toContain('process.env.CLOVER_SSH_PASSWORD')
    expect(env['CLOVER_SSH_ASKPASS_SCRIPT']).toBe(script.replace(/\\/g, '/'))
    if (process.platform !== 'win32') expect(env['SSH_ASKPASS']).toBe(join(root(), 'cache', 'ssh-askpass', 'askpass.sh'))
    expect(sshEnv({ ...host, authMethod: 'password' })['SSH_ASKPASS']).toBe(env['SSH_ASKPASS'])
  })
})

describe('remote helpers', () => {
  it('remoteAbsolute expands ~/ using the remote HOME and leaves other paths', async () => {
    const { remoteAbsolute } = await load()
    expect(await remoteAbsolute(host, '/abs')).toBe('/abs')
    expect(run).not.toHaveBeenCalled()
    run.mockResolvedValueOnce(ok('/home/moss\n'))
    expect(await remoteAbsolute(host, '~/models')).toBe('/home/moss/models')
    run.mockResolvedValueOnce(ok('', 'denied', 255))
    await expect(remoteAbsolute(host, '~/x')).rejects.toThrow('denied')
    run.mockResolvedValueOnce(ok('', '', 1))
    await expect(remoteAbsolute(host, '~/x')).rejects.toThrow('无法读取远端 HOME')
  })

  it('remotePathExists reads the last yes/no marker', async () => {
    const { remotePathExists } = await load()
    run.mockResolvedValueOnce(ok('motd\nyes\n'))
    expect(await remotePathExists(host, '/p')).toBe(true)
    run.mockResolvedValueOnce(ok('no\n'))
    expect(await remotePathExists(host, '/p')).toBe(false)
  })

  it('remoteFreePort accepts a valid last-line port and rejects junk', async () => {
    const { remoteFreePort } = await load()
    run.mockResolvedValueOnce(ok('warning\n41234\n'))
    expect(await remoteFreePort(host)).toBe(41234)
    for (const stdout of ['80', '70000', 'abc']) {
      run.mockResolvedValueOnce(ok(stdout))
      await expect(remoteFreePort(host)).rejects.toThrow('无法在远端分配端口')
    }
  })
})

describe('probeHost', () => {
  it('splits the sectioned output', async () => {
    const { probeHost } = await load()
    run.mockResolvedValueOnce(ok('@@OS@@Linux x86_64\n@@GPU@@NVIDIA A100, 81920 MiB\nNVIDIA A100, 81920 MiB\n@@GIT@@git version 2.43\n@@UV@@\n@@PY@@Python 3.12.1\n@@ROOT@@yes\n'))
    const probe = await probeHost(host)
    expect(probe).toMatchObject({
      os: 'Linux x86_64', gpu: 'NVIDIA A100, 81920 MiB\nNVIDIA A100, 81920 MiB', git: 'git version 2.43', uv: '', python: 'Python 3.12.1', rootReady: true,
    })
  })

  it('throws stderr, stdout or the exit code on failure', async () => {
    const { probeHost } = await load()
    run.mockResolvedValueOnce(ok('', 'Permission denied', 255))
    await expect(probeHost(host)).rejects.toThrow('Permission denied')
    run.mockResolvedValueOnce(ok('', '', 7))
    await expect(probeHost(host)).rejects.toThrow('ssh 退出码 7')
  })
})
