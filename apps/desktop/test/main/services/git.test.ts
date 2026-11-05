import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from '@main/lib/run'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

type Handler = (args: string[]) => Partial<RunResult> | undefined
const state = {
  handler: (() => undefined) as Handler,
  calls: [] as string[][],
  health: [] as Array<{ healthy: boolean; branches: number; detail?: string }>,
  events: [] as Array<{ phase: string; message: string }>,
}
vi.mock('@main/lib/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/lib/run')>()),
  run: async (_command: string, args: string[]) => {
    state.calls.push(args)
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...state.handler(args) }
  },
}))
vi.mock('@main/lib/gitBinary', () => ({ gitBinary: () => 'git' }))
vi.mock('@main/lib/events', () => ({ emit: (_channel: string, payload: { phase: string; message: string }) => state.events.push(payload) }))
vi.mock('@main/services/gitHealth', () => ({ checkBareMirror: async () => state.health.shift() ?? { healthy: true, branches: 1 } }))
vi.mock('@main/services/network', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/services/network')>()),
  getLastNetwork: () => null,
}))

const root = useTempDataRoot()
const settings = settingsFixture()
const SOURCE = 'https://github.com/OpenMOSS/MOSS-Image'
const mirror = () => join(root(), 'git', 'moss-image.git')

beforeEach(() => {
  vi.resetModules()
  Object.assign(state, { handler: () => undefined, calls: [], health: [], events: [] })
})
const load = () => import('@main/services/git')

describe('listBranches', () => {
  it('parses refs, flags default/stable and sorts default first', async () => {
    const main = 'a'.repeat(40)
    state.handler = (args) => {
      if (args.includes('for-each-ref')) return { stdout: `zeta|${'b'.repeat(40)}| \nmain|${main}| \nalpha|${'c'.repeat(40)}|*\n` }
      if (args.includes('rev-parse')) return { stdout: `${main}\n` }
      return undefined
    }
    const branches = await (await load()).listBranches()
    expect(branches.map((branch) => [branch.name, branch.isDefault, branch.isStable])).toEqual([
      ['alpha', true, false], ['main', true, true], ['zeta', false, false],
    ])
    expect(state.calls[0]).toEqual(['-C', mirror(), 'for-each-ref', '--format=%(refname:short)|%(objectname)|%(HEAD)', 'refs/heads'])
  })

  it('uses a per-source mirror for other sources', async () => {
    state.handler = (args) => args.includes('for-each-ref') ? { stdout: 'main|deadbeef|\n' } : { code: 128 }
    const { listBranches } = await load()
    const [main] = await listBranches('https://example.com/fork.git')
    expect(main!.isStable).toBe(false)
    expect(state.calls[0]![1]).toMatch(/moss-image-[0-9a-f]{12}\.git$/)
  })

  it('reports git failures and empty mirrors', async () => {
    const { listBranches } = await load()
    state.handler = () => ({ code: 128, stderr: 'fatal: bad\n' })
    await expect(listBranches()).rejects.toThrow('读取分支失败：fatal: bad')
    state.handler = () => ({ code: 0, stdout: '\n' })
    await expect(listBranches()).rejects.toThrow('镜像里没有可用分支')
  })
})

describe('listCommits', () => {
  it('parses unit-separated log lines and sanitises the branch name', async () => {
    state.handler = () => ({ stdout: `${'a'.repeat(40)}\u001faaaaaaa\u001f1700000000\u001ffeat: x | y\u001fAlice\nbad\n` })
    const commits = await (await load()).listCommits('main; rm -rf /', 5)
    expect(commits[0]).toEqual({ sha: 'a'.repeat(40), short: 'aaaaaaa', date: new Date(1700000000 * 1000).toISOString(), subject: 'feat: x | y', author: 'Alice' })
    expect(commits[1]).toEqual({ sha: 'bad', short: '', date: new Date(0).toISOString(), subject: '', author: '' })
    expect(state.calls[0]!.slice(-3)).toEqual(['-n5', '--format=%H%x1f%h%x1f%ct%x1f%s%x1f%an', 'mainrm-rf/'])
  })

  it('rejects failures and empty branches', async () => {
    const { listCommits } = await load()
    state.handler = () => ({ code: 1, stderr: 'unknown revision' })
    await expect(listCommits('x')).rejects.toThrow('读取提交失败：unknown revision')
    state.handler = () => ({ stdout: '  ' })
    await expect(listCommits('')).rejects.toThrow('分支 (空) 没有可用提交')
  })
})

describe('small git helpers', () => {
  it('commitExists, branchStableSha and isDirty map exit codes and output', async () => {
    const { commitExists, branchStableSha, isDirty } = await load()
    state.handler = () => ({ code: 0, stdout: 'abc\n' })
    expect(await commitExists('abc')).toBe(true)
    expect(await branchStableSha()).toBe('abc')
    expect(await isDirty('/w')).toBe(true)
    state.handler = () => ({ code: 1, stdout: '' })
    expect(await commitExists('abc')).toBe(false)
    expect(await branchStableSha()).toBeNull()
    expect(await isDirty('/w')).toBe(false)
  })

  it('createWorktree and checkout throw with the stderr tail', async () => {
    const { createWorktree, checkout } = await load()
    state.handler = () => ({ code: 128, stderr: 'already exists' })
    await expect(createWorktree('sha', '/dest')).rejects.toThrow('创建实例失败：already exists')
    await expect(checkout('/dest', 'sha')).rejects.toThrow('切换版本失败：already exists')
  })
})

describe('ensureMirror', () => {
  it('clones through the configured mirror and falls back to GitHub', async () => {
    state.handler = (args) => {
      if (args[0] === 'clone' && args.includes(`https://ghproxy.net/${SOURCE}`)) {
        mkdirSync(args.at(-1)!, { recursive: true })
        return { code: 128, stderr: 'proxy down' }
      }
      return undefined
    }
    await (await load()).ensureMirror(settingsFixture({ gitMirror: 'https://ghproxy.net/' }))
    const clones = state.calls.filter((args) => args[0] === 'clone')
    expect(clones.map((args) => args[3])).toEqual([`https://ghproxy.net/${SOURCE}`, SOURCE])
    expect(state.events.map((event) => event.message)).toContain('镜像失败，回退直连 GitHub')
  })

  it('throws when the direct clone also fails', async () => {
    state.handler = (args) => (args[0] === 'clone' ? { code: 128, stderr: 'network unreachable' } : undefined)
    await expect((await load()).ensureMirror(settings)).rejects.toThrow('克隆失败：network unreachable')
  })

  it('archives a leftover directory without HEAD before cloning', async () => {
    mkdirSync(mirror(), { recursive: true })
    await (await load()).ensureMirror(settings)
    expect(readdirSync(dirname(mirror())).some((name) => name.startsWith('moss-image.git.broken-'))).toBe(true)
    expect(state.calls[0]![0]).toBe('clone')
  })

  it('rejects a fresh clone that is not healthy', async () => {
    state.health = [{ healthy: false, branches: 0, detail: '镜像中没有本地分支' }]
    await expect((await load()).ensureMirror(settings)).rejects.toThrow('镜像不可用：镜像中没有本地分支')
  })

  it('fetches a healthy mirror and keeps it when fetch fails', async () => {
    mkdirSync(mirror(), { recursive: true })
    writeFileSync(join(mirror(), 'HEAD'), 'ref: refs/heads/main')
    state.handler = (args) => (args.includes('fetch') ? { code: 1, stderr: 'timeout' } : undefined)
    await (await load()).ensureMirror(settings)
    expect(state.calls.map((args) => args[2])).toEqual(['fetch'])
    expect(existsSync(join(mirror(), 'HEAD'))).toBe(true)
    expect(state.events.at(-1)!.message).toBe('拉取失败（保留本地镜像）：timeout')
  })

  it('repairs an unhealthy mirror by fetch, then by re-cloning', async () => {
    mkdirSync(mirror(), { recursive: true })
    writeFileSync(join(mirror(), 'HEAD'), 'x')
    state.health = [{ healthy: false, branches: 0 }, { healthy: false, branches: 0 }, { healthy: true, branches: 1 }]
    await (await load()).ensureMirror(settings)
    expect(state.calls.map((args) => args[0] === 'clone' ? 'clone' : args[2])).toEqual(['fetch', 'clone'])
    expect(readdirSync(dirname(mirror())).some((name) => name.startsWith('moss-image.git.broken-'))).toBe(true)
  })

  it('shares one in-flight task per mirror', async () => {
    const { ensureMirror } = await load()
    await Promise.all([ensureMirror(settings), ensureMirror(settings)])
    expect(state.calls.filter((args) => args[0] === 'clone')).toHaveLength(1)
  })
})
