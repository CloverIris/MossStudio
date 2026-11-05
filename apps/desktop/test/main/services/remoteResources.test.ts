import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sshHostFixture } from '@test/mocks/backend/fixtures'

const sshExec = vi.fn()
vi.mock('@main/services/ssh', () => ({
  posixQuote: (value: string) => `'${value}'`,
  remoteAbsolute: async (_host: unknown, path: string) => path.replace(/^~\//, '/home/moss/'),
  sshExec: (...args: unknown[]) => sshExec(...args),
}))

const { inspectRemoteResource, removeRemoteResource } = await import('@main/services/remoteResources')
const host = sshHostFixture()
const out = (stdout: string, code = 0, stderr = '') => ({ code, stdout, stderr, timedOut: false })

beforeEach(() => sshExec.mockReset())

describe('inspectRemoteResource', () => {
  it('defaults a blank path to ~/.mossstudio and reports a found engine', async () => {
    sshExec.mockResolvedValueOnce(out('\n  /home/moss/.mossstudio/bin/moss-server  \nextra'))
    const result = await inspectRemoteResource(host, 'engine', '   ')
    expect(result).toEqual({ path: '/home/moss/.mossstudio', exists: true, found: '/home/moss/.mossstudio/bin/moss-server', message: '找到引擎：/home/moss/.mossstudio/bin/moss-server' })
    expect(sshExec.mock.calls[0]![1]).toContain("find '/home/moss/.mossstudio' -maxdepth 4")
  })

  it('reports missing engines, models and outputs', async () => {
    sshExec.mockResolvedValue(out(''))
    expect(await inspectRemoteResource(host, 'engine', '/e')).toMatchObject({ exists: false, found: undefined, message: '没有找到可执行的 moss-server' })
    expect(await inspectRemoteResource(host, 'models', '/m')).toMatchObject({ exists: false, message: '没有找到完整 model_index.json 的模型目录' })
    expect(await inspectRemoteResource(host, 'outputs', '/o')).toMatchObject({ exists: false, message: '输出目录不存在' })
  })

  it('finds model and output directories', async () => {
    sshExec.mockResolvedValueOnce(out('/m/snap\n')).mockResolvedValueOnce(out('/o\n'))
    expect(await inspectRemoteResource(host, 'models', '/m')).toMatchObject({ exists: true, found: '/m/snap', message: '找到模型：/m/snap' })
    expect(await inspectRemoteResource(host, 'outputs', '/o')).toMatchObject({ exists: true, message: '输出目录存在' })
  })
})

describe('removeRemoteResource', () => {
  it.each(['/', '/home', '/home/moss', '/a/b'])('refuses the shallow path %s', async (path) => {
    await expect(removeRemoteResource(host, path)).rejects.toThrow('拒绝删除过短或根路径')
    expect(sshExec).not.toHaveBeenCalled()
  })

  it('expands ~ before the depth check and removes deep paths', async () => {
    sshExec.mockResolvedValueOnce(out(''))
    await removeRemoteResource(host, '~/.mossstudio/engine')
    expect(sshExec).toHaveBeenCalledWith(host, "rm -rf '/home/moss/.mossstudio/engine'", 120_000)
  })

  it('surfaces rm failures', async () => {
    sshExec.mockResolvedValueOnce(out('', 1, 'Permission denied'))
    await expect(removeRemoteResource(host, '/a/b/c')).rejects.toThrow('Permission denied')
    sshExec.mockResolvedValueOnce(out('', 1))
    await expect(removeRemoteResource(host, '/a/b/c')).rejects.toThrow('删除失败')
  })
})
