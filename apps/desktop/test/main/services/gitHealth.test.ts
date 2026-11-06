import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '@test/helpers/tempDir'

const run = vi.fn()
vi.mock('@main/lib/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/lib/run')>()),
  run: (...args: unknown[]) => run(...args),
}))
vi.mock('@main/lib/gitBinary', () => ({ gitBinary: () => 'git' }))

const { checkBareMirror } = await import('@main/services/gitHealth')
const temp = useTempDir()
const result = (code: number, stdout = '', stderr = '') => ({ code, stdout, stderr, timedOut: false })
const mirror = () => {
  mkdirSync(temp(), { recursive: true })
  writeFileSync(join(temp(), 'HEAD'), 'ref: refs/heads/main\n')
  return temp()
}

beforeEach(() => run.mockReset())

describe('checkBareMirror', () => {
  it('is unhealthy without HEAD and never runs git', async () => {
    expect(await checkBareMirror(join(temp(), 'missing'))).toEqual({ healthy: false, branches: 0, detail: '镜像缺少 HEAD' })
    expect(run).not.toHaveBeenCalled()
  })

  it('reports for-each-ref failures with the first stderr line', async () => {
    run.mockResolvedValueOnce(result(128, '', 'fatal: not a git repository\nmore'))
    expect(await checkBareMirror(mirror())).toEqual({ healthy: false, branches: 0, detail: 'fatal: not a git repository' })
    run.mockResolvedValueOnce(result(128))
    expect((await checkBareMirror(mirror())).detail).toBe('读取分支引用失败')
  })

  it('is healthy once any branch resolves to a commit', async () => {
    run
      .mockResolvedValueOnce(result(0, 'refs/heads/.invalid\nrefs/heads/main\n'))
      .mockResolvedValueOnce(result(128, '', 'bad'))
      .mockResolvedValueOnce(result(0, 'abc123\n'))
    expect(await checkBareMirror(mirror())).toEqual({ healthy: true, branches: 2 })
    expect(run.mock.calls[2]![1]).toEqual(['-C', temp(), 'rev-parse', '--verify', 'refs/heads/main^{commit}'])
  })

  it('distinguishes no branches from unresolvable branches', async () => {
    run.mockResolvedValueOnce(result(0, '\n'))
    expect(await checkBareMirror(mirror())).toEqual({ healthy: false, branches: 0, detail: '镜像中没有本地分支' })
    run.mockResolvedValueOnce(result(0, 'refs/heads/main')).mockResolvedValueOnce(result(0, '  \n'))
    expect(await checkBareMirror(mirror())).toEqual({ healthy: false, branches: 1, detail: '分支引用存在但没有可解析的 commit' })
  })
})
