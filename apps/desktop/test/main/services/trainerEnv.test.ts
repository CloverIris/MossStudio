import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

const state = {
  which: {} as Record<string, string>,
  versions: {} as Record<string, string>,
  pyExecutable: '',
  uvStatus: 0 as number | null,
}
vi.mock('@main/lib/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/lib/run')>()),
  run: async (command: string, args: string[]) => {
    if (command === 'which' || command === 'where') {
      const path = state.which[args[0]!]
      return { code: path ? 0 : 1, stdout: path ? `${path}\n` : '', stderr: '', timedOut: false }
    }
    if (args[0] === '-3') return { code: 0, stdout: `${state.pyExecutable}\r\n`, stderr: '', timedOut: false }
    return { code: 1, stdout: '', stderr: '', timedOut: false }
  },
}))
vi.mock('@main/lib/python', () => ({ pythonVersion: async (path: string) => state.versions[path] ?? null }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawnSync: () => ({ status: state.uvStatus }),
}))

const temp = useTempDir()
const originalPlatform = process.platform
const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true })

beforeEach(() => {
  vi.resetModules()
  state.which = {}
  state.versions = {}
  state.pyExecutable = ''
  state.uvStatus = 0
})
afterEach(() => setPlatform(originalPlatform))
const load = () => import('@main/services/trainerEnv')

describe('venvPython', () => {
  it('uses Scripts/python.exe on Windows and bin/python3 elsewhere', async () => {
    const { venvPython } = await load()
    setPlatform('linux')
    expect(venvPython('/v')).toBe(join('/v', 'bin', 'python3'))
    setPlatform('win32')
    expect(venvPython('/v')).toBe(join('/v', 'Scripts', 'python.exe'))
  })
})

describe('pickPython', () => {
  it('prefers a working configured interpreter', async () => {
    state.versions['/custom/python'] = '3.11.2'
    state.which['python3'] = '/usr/bin/python3'
    state.versions['/usr/bin/python3'] = '3.12.0'
    const { pickPython } = await load()
    expect(await pickPython(settingsFixture({ pythonPath: '/custom/python' }))).toEqual({ path: '/custom/python', version: '3.11.2' })
  })

  it('falls back to PATH in preference order when the configured one is broken', async () => {
    setPlatform('linux')
    state.which['python3.13'] = '/usr/bin/python3.13'
    state.which['python3.12'] = '/usr/bin/python3.12'
    state.versions['/usr/bin/python3.12'] = '3.12.7'
    const { pickPython } = await load()
    expect(await pickPython(settingsFixture({ pythonPath: '/broken' }))).toEqual({ path: '/usr/bin/python3.12', version: '3.12.7' })
  })

  it('uses the py launcher first on Windows', async () => {
    setPlatform('win32')
    state.which['py'] = 'C:\\Windows\\py.exe'
    state.pyExecutable = 'C:\\Python312\\python.exe'
    state.versions['C:\\Python312\\python.exe'] = '3.12.1'
    const { pickPython } = await load()
    expect(await pickPython(settingsFixture())).toEqual({ path: 'C:\\Python312\\python.exe', version: '3.12.1' })
  })

  it('scans common Windows install roots as a last resort', async () => {
    setPlatform('win32')
    vi.stubEnv('LOCALAPPDATA', temp())
    vi.stubEnv('ProgramFiles', '')
    mkdirSync(join(temp(), 'Programs', 'Python', 'Python311'), { recursive: true })
    mkdirSync(join(temp(), 'Programs', 'Python', 'NotPython'), { recursive: true })
    const expected = join(temp(), 'Programs', 'Python', 'Python311', 'python.exe')
    state.versions[expected] = '3.11.9'
    const { pickPython } = await load()
    expect(await pickPython(settingsFixture())).toEqual({ path: expected, version: '3.11.9' })
  })

  it('throws a guidance error when nothing qualifies', async () => {
    setPlatform('linux')
    const { pickPython } = await load()
    await expect(pickPython(settingsFixture())).rejects.toThrow('Trainer 需要 Python 3.10+')
  })
})

describe('parseTrainerDeps', () => {
  it('reads the [project] dependencies array', async () => {
    writeFileSync(
      join(temp(), 'pyproject.toml'),
      [
        '[build-system]',
        'requires = ["setuptools"]',
        '',
        '[project]',
        'name = "trainer"',
        'dependencies = [',
        '  "torch>=2.4",',
        "  'safetensors',",
        '  "diffusers==0.31",',
        ']',
        '',
        '[tool.ruff]',
        'dependencies = ["not-this"]',
      ].join('\n'),
    )
    const { parseTrainerDeps } = await load()
    expect(parseTrainerDeps(temp())).toEqual(['torch>=2.4', 'safetensors', 'diffusers==0.31'])
  })

  it('returns [] without a project table, dependencies or file', async () => {
    const { parseTrainerDeps } = await load()
    expect(parseTrainerDeps(join(temp(), 'missing'))).toEqual([])
    writeFileSync(join(temp(), 'pyproject.toml'), '[tool.x]\ndependencies = ["a"]\n')
    expect(parseTrainerDeps(temp())).toEqual([])
    writeFileSync(join(temp(), 'pyproject.toml'), '[project]\nname = "x"\n')
    expect(parseTrainerDeps(temp())).toEqual([])
  })

  it('keeps requirements with extras and ignores comments', async () => {
    writeFileSync(
      join(temp(), 'pyproject.toml'),
      [
        '[project]',
        'dependencies = [',
        '  "torch", # the trainer pins CUDA wheels separately',
        '  "diffusers[torch]==0.31",',
        "  'accelerate>=1.0',",
        ']',
        '[tool.uv]',
      ].join('\n'),
    )
    const { parseTrainerDeps } = await load()
    expect(parseTrainerDeps(temp())).toEqual(['torch', 'diffusers[torch]==0.31', 'accelerate>=1.0'])
  })
})

describe('hasUv', () => {
  it('reflects the uv --version exit status', async () => {
    const { hasUv } = await load()
    expect(await hasUv()).toBe(true)
    state.uvStatus = null
    expect(await hasUv()).toBe(false)
  })
})
