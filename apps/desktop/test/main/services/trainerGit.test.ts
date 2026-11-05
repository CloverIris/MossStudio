import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from '@main/lib/run'
import { useTempDir } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

type Handler = (args: string[]) => Partial<RunResult> | undefined
const state = {
  handler: (() => undefined) as Handler,
  calls: [] as string[][],
  health: [] as Array<{ healthy: boolean; branches: number; detail?: string }>,
}
vi.mock('@main/lib/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/lib/run')>()),
  run: async (_command: string, args: string[]) => {
    state.calls.push(args)
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...state.handler(args) }
  },
}))
vi.mock('@main/lib/gitBinary', () => ({ gitBinary: () => 'git' }))
vi.mock('@main/lib/events', () => ({ emit: () => undefined }))
vi.mock('@main/services/gitHealth', () => ({ checkBareMirror: async () => state.health.shift() ?? { healthy: true, branches: 1 } }))
vi.mock('@main/services/network', async (importOriginal) => ({ ...(await importOriginal<object>()), getLastNetwork: () => null }))

const trainerRoot = useTempDir('trainer-')
const settings = (patch = {}) => settingsFixture({ trainerRoot: trainerRoot(), ...patch })
const SOURCE = 'https://github.com/KohakuBlueleaf/KohakuMossTrainer'
const mirror = () => join(trainerRoot(), 'git', 'kohaku-trainer.git')
const haveMirror = () => { mkdirSync(mirror(), { recursive: true }); writeFileSync(join(mirror(), 'HEAD'), 'x') }

beforeEach(() => {
  vi.resetModules()
  Object.assign(state, { handler: () => undefined, calls: [], health: [] })
})
const load = () => import('@main/services/trainerGit')

describe('trainer paths', () => {
  it('derive from the trainer root', async () => {
    const api = await load()
    expect(api.trainerMirror(settings())).toBe(mirror())
    expect(api.trainerVersionDir(settings(), 'v1')).toBe(join(trainerRoot(), 'versions', 'v1'))
    expect(api.trainerRuntimeDir(settings(), 'r1')).toBe(join(trainerRoot(), 'runtimes', 'r1'))
  })
})

describe('ensureTrainerMirror', () => {
  it('clones via the mirror, falling back to the source', async () => {
    state.handler = (args) => (args[0] === 'clone' && args[3] !== SOURCE ? { code: 128 } : undefined)
    await (await load()).ensureTrainerMirror(settings({ gitMirror: 'https://ghproxy.net/' }))
    expect(state.calls.filter((args) => args[0] === 'clone').map((args) => args[3])).toEqual([`https://ghproxy.net/${SOURCE}`, SOURCE])
  })

  it('throws when every clone fails', async () => {
    state.handler = (args) => (args[0] === 'clone' ? { code: 128, stderr: 'nope' } : undefined)
    await expect((await load()).ensureTrainerMirror(settings())).rejects.toThrow('训练器克隆失败：nope')
  })

  it('fetches tags on a healthy mirror and re-clones a mirror fetch cannot repair', async () => {
    haveMirror()
    await (await load()).ensureTrainerMirror(settings())
    expect(state.calls[0]).toEqual(['-C', mirror(), 'fetch', '--prune', '--tags', 'origin', '+refs/heads/*:refs/heads/*'])
    vi.resetModules()
    state.calls = []
    state.health = [{ healthy: false, branches: 0 }, { healthy: false, branches: 0 }, { healthy: true, branches: 1 }]
    await (await load()).ensureTrainerMirror(settings())
    expect(state.calls.map((args) => (args[0] === 'clone' ? 'clone' : args[2]))).toEqual(['fetch', 'clone'])
    expect(readdirSync(join(trainerRoot(), 'git')).some((name) => name.startsWith('kohaku-trainer.git.broken-'))).toBe(true)
  })

  it('dedupes concurrent calls for the same root', async () => {
    const { ensureTrainerMirror } = await load()
    await Promise.all([ensureTrainerMirror(settings()), ensureTrainerMirror(settings())])
    expect(state.calls.filter((args) => args[0] === 'clone')).toHaveLength(1)
  })
})

describe('branches, commits and tags', () => {
  it('marks the branch at the v0.1.0 tag as stable', async () => {
    haveMirror()
    state.handler = (args) => {
      if (args.includes('for-each-ref')) return { stdout: 'feature|222\nmain|111\n' }
      if (args.includes('rev-parse')) return { stdout: '222\n' }
      return undefined
    }
    const branches = await (await load()).listTrainerBranches(settings())
    expect(branches).toEqual([
      { name: 'main', sha: '111', isDefault: true, isStable: false },
      { name: 'feature', sha: '222', isDefault: false, isStable: true },
    ])
  })

  it('has no stable branch without the tag and rejects empty mirrors', async () => {
    haveMirror()
    state.handler = (args) => (args.includes('for-each-ref') ? { stdout: 'main|111\n' } : args.includes('rev-parse') ? { code: 128 } : undefined)
    const { listTrainerBranches, trainerTagSha } = await load()
    expect((await listTrainerBranches(settings()))[0]!.isStable).toBe(false)
    expect(await trainerTagSha(settings())).toBeNull()
    state.handler = () => ({ stdout: '' })
    await expect(listTrainerBranches(settings())).rejects.toThrow('训练器镜像里没有可用分支')
  })

  it('lists commits and rejects empty output', async () => {
    haveMirror()
    state.handler = (args) => (args.includes('log') ? { stdout: 'a\u001fb\u001f2\u001fs\u001fx\n' } : undefined)
    const { listTrainerCommits } = await load()
    expect((await listTrainerCommits(settings(), 'main'))[0]).toEqual({ sha: 'a', short: 'b', date: new Date(2000).toISOString(), subject: 's', author: 'x' })
    state.handler = () => ({ stdout: '' })
    await expect(listTrainerCommits(settings(), 'main')).rejects.toThrow('训练器分支 main 没有可用提交')
  })

  it('maps worktree, commit and dirty checks', async () => {
    const { trainerCommitExists, createTrainerWorktree, isTrainerDirty } = await load()
    state.handler = () => ({ code: 0, stdout: ' M train.py' })
    expect(await trainerCommitExists(settings(), 'a')).toBe(true)
    expect(await isTrainerDirty('/v')).toBe(true)
    expect(state.calls.at(-1)).toContain(':(exclude).venv')
    state.handler = () => ({ code: 1, stderr: 'bad', stdout: '' })
    await expect(createTrainerWorktree(settings(), 'a', '/dest')).rejects.toThrow('创建训练版本失败：bad')
  })
})
