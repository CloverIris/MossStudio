import { beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.fn()
vi.mock('@main/lib/run', () => ({ run: (...args: unknown[]) => run(...args) }))

beforeEach(() => run.mockReset())

const { pythonVersion } = await import('@main/lib/python')
const ok = (stdout: string, stderr = '') => ({ code: 0, stdout, stderr, timedOut: false })

describe('pythonVersion', () => {
  it('accepts Python 3.10+ from stdout', async () => {
    run.mockResolvedValue(ok('Python 3.12.14\n'))
    expect(await pythonVersion('C:/Python/python.exe')).toBe('3.12.14')
    expect(run).toHaveBeenCalledWith('C:/Python/python.exe', ['--version'], { timeoutMs: 5000 })
  })

  it('reads the version from stderr (Python 2 style) too', async () => {
    run.mockResolvedValue(ok('', 'Python 3.10.0'))
    expect(await pythonVersion('python')).toBe('3.10.0')
  })

  it.each(['2.7.18', '3.9.23', '4.0.0'])('rejects Python %s', async (version) => {
    run.mockResolvedValue(ok(`Python ${version}`))
    expect(await pythonVersion('python')).toBeNull()
  })

  it('rejects a non-zero exit and unparseable output', async () => {
    run.mockResolvedValue({ code: 1, stdout: 'Python 3.12.14', stderr: '', timedOut: false })
    expect(await pythonVersion('python')).toBeNull()
    run.mockResolvedValue(ok('Python was not found; run without arguments to install from the Microsoft Store'))
    expect(await pythonVersion('python')).toBeNull()
  })

  it('accepts a working Microsoft Store alias like any other interpreter', async () => {
    run.mockResolvedValue(ok('Python 3.12.14'))
    expect(await pythonVersion('C:/Users/test/AppData/Local/Microsoft/WindowsApps/python.exe')).toBe('3.12.14')
  })
})
