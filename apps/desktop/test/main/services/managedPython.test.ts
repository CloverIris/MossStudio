/**
 * Port of tools/test-managed-python.mjs (python-build-standalone install flow).
 * The pythonVersion half lives in test/main/lib/python.test.ts.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

const version = '3.12.14'
const release = '20261021'
const archive = Buffer.from('test Python archive')
const checksum = createHash('sha256').update(archive).digest('hex')

const state = {
  settings: settingsFixture({ theme: 'dark' }) as Settings,
  existing: false,
  failHash: false,
  failProbe: false,
  noDigest: false,
  tarCalls: 0,
  probeArgs: [] as string[][],
  events: [] as Array<{ name: string; value: { phase: string } }>,
  requests: [] as string[],
}

vi.mock('@main/lib/events', () => ({ emit: (name: string, value: { phase: string }) => state.events.push({ name, value: { ...value } }) }))
vi.mock('@main/lib/python', () => ({ pythonVersion: async (path: string) => (existsSync(path) ? version : null) }))
vi.mock('@main/services/settings', () => ({
  getSettings: () => state.settings,
  updateSettings: (patch: Partial<Settings>) => (state.settings = { ...state.settings, ...patch }),
}))
vi.mock('@main/services/trainerEnv', () => ({
  pickPython: async () => {
    if (state.existing) return { path: '/existing/python', version: '3.13.2' }
    throw new Error('No Python')
  },
}))
vi.mock('@main/lib/run', () => ({
  run: async (command: string, args: string[]) => {
    if (command === 'tar') {
      state.tarCalls += 1
      const directory = join(args[3]!, 'python')
      mkdirSync(join(directory, 'bin'), { recursive: true })
      writeFileSync(process.platform === 'win32' ? join(directory, 'python.exe') : join(directory, 'bin/python3'), 'interpreter')
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    state.probeArgs.push(args)
    return { code: state.failProbe ? 1 : 0, stdout: `${version}\n`, stderr: state.failProbe ? 'broken Python' : '', timedOut: false }
  },
}))

const root = useTempDataRoot()
const originalPlatform = process.platform
const originalArch = process.arch
const triples: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'darwin-arm64': 'aarch64-apple-darwin',
}

function setPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture): { name: string; url: string } {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
  vi.spyOn(process.report, 'getReport').mockReturnValue({ header: { glibcVersionRuntime: '2.36' } } as never)
  const name = `cpython-${version}+${release}-${triples[`${platform}-${arch}`]}-install_only.tar.gz`
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/${name}`
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const request = String(input)
      state.requests.push(request)
      if (request.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: release,
            assets: [
              {
                name: `cpython-3.11.9+${release}-${triples[`${platform}-${arch}`]}-install_only.tar.gz`,
                browser_download_url: url,
                size: 1,
              },
              {
                name,
                browser_download_url: url,
                size: archive.length,
                digest: state.noDigest ? null : `sha256:${state.failHash ? '0'.repeat(64) : checksum}`,
              },
            ],
          }),
        )
      }
      if (request.endsWith('/SHA256SUMS')) return new Response(`${'f'.repeat(64)}  other.tar.gz\n${checksum}  ${name}\n`)
      if (request === url) return new Response(archive)
      return new Response('', { status: 404 })
    }),
  )
  return { name, url }
}

beforeEach(() => {
  vi.resetModules()
  Object.assign(state, {
    settings: settingsFixture({ theme: 'dark' }),
    existing: false,
    failHash: false,
    failProbe: false,
    noDigest: false,
    tarCalls: 0,
    probeArgs: [],
    events: [],
    requests: [],
  })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
})
const load = () => import('@main/services/managedPython')
const phases = () =>
  state.events
    .filter((event) => event.name === 'event:python-install')
    .map((event) => event.value.phase)
    .filter((phase, index, all) => phase !== all[index - 1])

describe('installManagedPython', () => {
  it('reuses an existing Python without downloading or changing settings', async () => {
    setPlatform('darwin', 'arm64')
    state.existing = true
    const { installManagedPython, getPythonInstallState } = await load()
    const result = await installManagedPython()
    expect(result).toMatchObject({ phase: 'done', path: '/existing/python', version: '3.13.2' })
    expect(state.requests).toEqual([])
    expect(state.settings.pythonPath).toBeNull()
    expect(getPythonInstallState()).toBe(result)
  })

  it.each([
    ['darwin', 'arm64'],
    ['win32', 'x64'],
    ['linux', 'x64'],
  ] as const)('installs and verifies app-local Python on %s', async (platform, arch) => {
    setPlatform(platform, arch)
    const { installManagedPython } = await load()
    const first = installManagedPython()
    expect(installManagedPython()).toBe(first)
    const result = await first
    expect(result.phase).toBe('done')
    expect(result.version).toBe(version)
    expect(existsSync(result.path!)).toBe(true)
    expect(
      result.path!.startsWith(join(root(), 'runtimes', 'python', `cpython-${version}-${release}-${triples[`${platform}-${arch}`]}`)),
    ).toBe(true)
    expect(state.settings.pythonPath).toBe(result.path)
    expect(state.settings.theme).toBe('dark')
    expect(state.tarCalls).toBe(1)
    expect(state.probeArgs[0]![0]).toBe('-I')
    expect(state.probeArgs[0]![2]).toMatch(/venv, ensurepip, ssl/)
    expect(phases()).toEqual(['querying', 'downloading', 'verifying', 'extracting', 'done'])
    expect(state.events.some((event) => event.name === 'event:settings-changed')).toBe(true)
    // The temporary work directory is always cleaned up.
    expect(readdirSync(join(root(), 'runtimes', 'python')).filter((entry) => entry.startsWith('.install-'))).toEqual([])
  })

  it('skips the download when the stamped install already works', async () => {
    setPlatform('linux', 'x64')
    const { installManagedPython } = await load()
    await installManagedPython()
    state.requests = []
    const again = await installManagedPython()
    expect(again.phase).toBe('done')
    expect(state.tarCalls).toBe(1)
    expect(state.requests.every((url) => url.endsWith('/releases/latest'))).toBe(true)
  })

  it('never extracts or configures a download that fails its checksum, and can retry', async () => {
    setPlatform('darwin', 'arm64')
    state.failHash = true
    const { installManagedPython } = await load()
    const failed = await installManagedPython()
    expect(failed.phase).toBe('error')
    expect(failed.error).toMatch(/SHA256/)
    expect(state.tarCalls).toBe(0)
    expect(state.settings.pythonPath).toBeNull()
    state.failHash = false
    expect((await installManagedPython()).phase).toBe('done')
  })

  it('never activates a Python that cannot import venv/pip/ssl', async () => {
    setPlatform('darwin', 'arm64')
    state.failProbe = true
    const result = await (await load()).installManagedPython()
    expect(result.phase).toBe('error')
    expect(result.error).toMatch(/校验失败/)
    expect(state.settings.pythonPath).toBeNull()
  })

  it('reads SHA256SUMS when the asset has no digest', async () => {
    setPlatform('darwin', 'arm64')
    state.noDigest = true
    expect((await (await load()).installManagedPython()).phase).toBe('done')
    expect(state.requests.some((url) => url.endsWith('/SHA256SUMS'))).toBe(true)
  })

  it('reports unsupported architectures and API failures', async () => {
    setPlatform('linux', 'ia32' as NodeJS.Architecture)
    const unsupported = await (await load()).installManagedPython()
    expect(unsupported).toMatchObject({ phase: 'error', error: '内置 Python 暂不支持 ia32' })
    vi.resetModules()
    setPlatform('linux', 'x64')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    )
    expect((await (await load()).installManagedPython()).error).toBe('查询内置 Python 下载失败：HTTP 403')
  })
})
