import { beforeEach, describe, expect, it, vi } from 'vitest'

const setupEnvironment = vi.fn()
const resolveGitBinary = vi.fn(() => '/bundled/git')
vi.mock('dugite', () => ({
  setupEnvironment: (...args: unknown[]) => setupEnvironment(...args),
  resolveGitBinary: () => resolveGitBinary(),
}))

beforeEach(() => {
  vi.resetModules()
  setupEnvironment.mockReset()
})

describe('gitBinary', () => {
  it('installs dugite env once and returns the bundled path', async () => {
    setupEnvironment.mockReturnValue({ env: { GIT_TEST_EXEC_PATH: '/exec', GIT_TEST_UNSET: undefined } })
    vi.stubEnv('GIT_TEST_EXEC_PATH', '')
    const { gitBinary } = await import('@main/lib/gitBinary')
    expect(gitBinary()).toBe('/bundled/git')
    expect(gitBinary()).toBe('/bundled/git')
    expect(setupEnvironment).toHaveBeenCalledTimes(1)
    expect(process.env['GIT_TEST_EXEC_PATH']).toBe('/exec')
    expect('GIT_TEST_UNSET' in process.env).toBe(false)
  })

  it('still resolves the binary when environment setup throws', async () => {
    setupEnvironment.mockImplementation(() => { throw new Error('no env') })
    const { gitBinary } = await import('@main/lib/gitBinary')
    expect(gitBinary()).toBe('/bundled/git')
    gitBinary()
    expect(setupEnvironment).toHaveBeenCalledTimes(1)
  })
})
