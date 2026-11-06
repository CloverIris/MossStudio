import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from '@main/lib/run'
import { useTempDir } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

type Handler = (args: string[]) => Partial<RunResult> | undefined
const state = { handler: (() => undefined) as Handler, calls: [] as string[][] }
vi.mock('@main/lib/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/lib/run')>()),
  run: async (_command: string, args: string[]) => {
    state.calls.push(args)
    // Like real git, `worktree add` creates the destination (and so versions/).
    if (args[2] === 'worktree' && args[3] === 'add') mkdirSync(args[5]!, { recursive: true })
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...state.handler(args) }
  },
}))
vi.mock('@main/lib/gitBinary', () => ({ gitBinary: () => 'git' }))

const gbcRoot = useTempDir('gbc-')
const settings = () => settingsFixture({ gbcRoot: gbcRoot() })
const mirror = () => join(gbcRoot(), 'git', 'kohakugbc.git')
const haveMirror = () => {
  mkdirSync(mirror(), { recursive: true })
  writeFileSync(join(mirror(), 'HEAD'), 'x')
}

beforeEach(() => {
  vi.resetModules()
  state.handler = () => undefined
  state.calls = []
})
const load = () => import('@main/services/gbcGit')

describe('gbc mirror', () => {
  it('clones when missing and lists branches with main first', async () => {
    state.handler = (args) => (args.includes('for-each-ref') ? { stdout: 'dev|222\nmain|111\n' } : undefined)
    const branches = await (await load()).listGbcBranches(settings())
    expect(state.calls[0]!.slice(0, 2)).toEqual(['clone', '--bare'])
    expect(branches).toEqual([
      { name: 'main', sha: '111', isDefault: true, isStable: true },
      { name: 'dev', sha: '222', isDefault: false, isStable: false },
    ])
  })

  it('reports clone failures', async () => {
    state.handler = (args) => (args[0] === 'clone' ? { code: 128, stderr: 'denied' } : undefined)
    await expect((await load()).listGbcBranches(settings())).rejects.toThrow('GBC 克隆失败：denied')
  })

  it('tolerates a fetch failure only when a main ref exists locally', async () => {
    haveMirror()
    state.handler = (args) =>
      args.includes('fetch') ? { code: 1, stderr: 'offline' } : args.includes('for-each-ref') ? { stdout: 'main|1\n' } : undefined
    const { listGbcBranches } = await load()
    await expect(listGbcBranches(settings())).rejects.toThrow('GBC 更新失败：offline')
    mkdirSync(join(mirror(), 'refs', 'heads'), { recursive: true })
    writeFileSync(join(mirror(), 'refs', 'heads', 'main'), 'sha')
    expect(await listGbcBranches(settings())).toHaveLength(1)
  })

  it('rejects an empty mirror', async () => {
    haveMirror()
    state.handler = () => ({ stdout: '' })
    await expect((await load()).listGbcBranches(settings())).rejects.toThrow('GBC 镜像没有可用分支')
  })
})

describe('gbc commits and versions', () => {
  it('parses commits', async () => {
    state.handler = () => ({ stdout: 'full\u001fshort\u001f10\u001fsubject\u001fBob\n' })
    expect(await (await load()).listGbcCommits(settings(), 'main')).toEqual([
      { sha: 'full', short: 'short', date: new Date(10_000).toISOString(), subject: 'subject', author: 'Bob' },
    ])
  })

  it('creates a version worktree with metadata and lists newest first, skipping corrupt files', async () => {
    haveMirror()
    state.handler = (args) => (args.includes('log') ? { stdout: `${'f'.repeat(40)}\u001fabcdef0\u001f1700000000\u001fInit\n` } : undefined)
    const { createGbcVersion, listGbcVersions } = await load()
    const version = await createGbcVersion(settings(), 'main', 'abcdef0', '  ')
    expect(version).toMatchObject({
      name: 'GBC abcdef0',
      branch: 'main',
      commit: 'f'.repeat(40),
      shortCommit: 'abcdef0',
      subject: 'Init',
      commitDate: new Date(1700000000 * 1000).toISOString(),
    })
    expect(version.path).toBe(join(gbcRoot(), 'versions', version.id))
    expect(JSON.parse(readFileSync(join(gbcRoot(), 'versions', `${version.id}.json`), 'utf8'))).toEqual(version)
    writeFileSync(join(gbcRoot(), 'versions', 'broken.json'), '{')
    writeFileSync(join(gbcRoot(), 'versions', 'older.json'), JSON.stringify({ ...version, id: 'older', createdAt: '2000-01-01T00:00:00Z' }))
    expect((await listGbcVersions(settings())).map((item) => item.id)).toEqual([version.id, 'older'])
  })

  it('fails for unknown commits and worktree errors', async () => {
    haveMirror()
    const { createGbcVersion } = await load()
    state.handler = (args) => (args.includes('log') ? { code: 128 } : undefined)
    await expect(createGbcVersion(settings(), 'main', 'nope')).rejects.toThrow('GBC commit 不存在')
    state.handler = (args) => (args.includes('worktree') ? { code: 128, stderr: 'locked' } : { stdout: 'a\u001fb\u001f1\u001fs' })
    await expect(createGbcVersion(settings(), 'main', 'a')).rejects.toThrow('创建 GBC 版本失败：locked')
  })

  it('removes a version worktree and its metadata, ignoring unknown ids', async () => {
    haveMirror()
    state.handler = (args) => (args.includes('log') ? { stdout: 'a\u001fb\u001f1\u001fs' } : undefined)
    const { createGbcVersion, removeGbcVersion, listGbcVersions } = await load()
    const version = await createGbcVersion(settings(), 'main', 'a', 'Named')
    expect(version.name).toBe('Named')
    await removeGbcVersion(settings(), 'unknown')
    await removeGbcVersion(settings(), version.id)
    expect(await listGbcVersions(settings())).toEqual([])
    expect(state.calls.some((args) => args.includes('remove') && args.includes(version.path))).toBe(true)
  })
})
