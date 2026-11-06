import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetworkReport } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

const GB = 1024 ** 3
type Result = { code: number; stdout: string; stderr?: string }
const state = {
  commands: {} as Record<string, Result>,
  realpath: {} as Record<string, string>,
  memory: 32 * GB,
  disk: { free: 200 * GB, total: 500 * GB },
  network: {
    checkedAt: 'x',
    mode: 'auto',
    probes: [],
    selected: { git: 'https://ghproxy.net/', pip: 'https://pypi.tuna.tsinghua.edu.cn/simple', hf: 'https://hf-mirror.com', manifest: null },
  } as NetworkReport,
}
vi.mock('@main/lib/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/lib/run')>()),
  run: async (command: string, args: string[]) => {
    const key = [command, ...args].join(' ')
    return { stderr: '', timedOut: false, ...(state.commands[key] ?? state.commands[command] ?? { code: 1, stdout: '' }) }
  },
}))
vi.mock('@main/lib/gitBinary', () => ({ gitBinary: () => '/bundled/git' }))
vi.mock('@main/services/network', () => ({ probeNetwork: async () => state.network }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const os = { ...actual, totalmem: () => state.memory, freemem: () => state.memory / 2 }
  return { ...os, default: os }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const promises = {
    ...actual.promises,
    realpath: async (path: string) => {
      if (!(path in state.realpath)) throw new Error('ENOENT')
      return state.realpath[path]
    },
    statfs: async () => ({ blocks: state.disk.total / 4096, bavail: state.disk.free / 4096, bsize: 4096 }),
  }
  return { ...actual, promises, default: { ...actual, promises } }
})

const root = useTempDataRoot()
const originalPlatform = process.platform
const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true })

beforeEach(() => {
  vi.resetModules()
  setPlatform('linux')
  state.commands = {
    lspci: {
      code: 0,
      stdout: '00:02.0 Host bridge: Intel\n01:00.0 VGA compatible controller: NVIDIA Corporation AD102 [GeForce RTX 4090] (rev a1)\n',
    },
    '/bundled/git --version': { code: 0, stdout: 'git version 2.47.0\n' },
  }
  state.realpath = {}
  state.memory = 32 * GB
  state.disk = { free: 200 * GB, total: 500 * GB }
})
afterEach(() => setPlatform(originalPlatform))
const scan = async (patch = {}) => (await import('@main/services/env')).scanEnvironment(settingsFixture(patch))
const check = (report: Awaited<ReturnType<typeof scan>>, id: string) => report.checks.find((item) => item.id === id)!

describe('scanEnvironment', () => {
  it('detects an NVIDIA GPU from lspci and recommends by memory', async () => {
    const report = await scan()
    expect(report.gpu).toMatchObject({ kind: 'nvidia', name: 'NVIDIA Corporation AD102 [GeForce RTX 4090] (rev a1)', available: true })
    expect(report.recommendation).toMatchObject({ width: 1024, steps: 8, profile: 'dmd8', quant: 'bf16' })
    expect(report.device).toMatchObject({ memoryTotal: 32 * GB, diskFree: 200 * GB, dataPath: root(), modelsPath: join(root(), 'models') })
    expect(report.tools.git).toEqual({ found: true, path: '/bundled/git', version: 'git version 2.47.0' })
  })

  it.each([
    [64, { steps: 50, quant: 'bf16' }],
    [16, { width: 768, quant: 'int8' }],
    [8, { width: 512, quant: 'int4' }],
  ])('recommends the %s GB tier', async (gb, expected) => {
    state.memory = gb * GB
    expect((await scan()).recommendation).toMatchObject(expected)
  })

  it('falls back to a CPU recommendation when no GPU is found', async () => {
    state.commands['lspci'] = { code: 0, stdout: '00:00.0 Host bridge\n' }
    const report = await scan()
    expect(report.gpu).toEqual({ kind: 'unknown', name: '未知 GPU', available: false })
    expect(report.recommendation).toMatchObject({ profile: 'base', quant: 'int8', estimatedLabel: 'CPU：30 分钟以上' })
    expect(check(report, 'gpu').status).toBe('warn')
  })

  it('collects unique Python 3 interpreters from settings, PATH, uv and the managed runtime', async () => {
    mkdirSync(join(root(), 'runtimes', 'python', 'cpython-3.12', 'bin'), { recursive: true })
    // env.ts appends '/<entry>/bin/python3' to the managed root with forward slashes,
    // so on a Windows host the simulated-Linux candidate has mixed separators.
    const managed = `${join(root(), 'runtimes', 'python')}/cpython-3.12`
    Object.assign(state.commands, {
      'which python3': { code: 0, stdout: '/usr/bin/python3\n' },
      'which python': { code: 0, stdout: '/usr/bin/python\n' },
      'uv python list': {
        code: 0,
        stdout: 'cpython-3.11.9-linux    /home/u/.local/share/uv/python/bin/python3.11\ncpython-3.13 <download available>\n',
      },
      '/usr/bin/python3.12 --version': { code: 0, stdout: 'Python 3.12.3' },
      '/opt/custom/python --version': { code: 0, stdout: '', stderr: 'Python 3.10.1' },
      '/home/u/.local/share/uv/python/bin/python3.11 --version': { code: 0, stdout: 'Python 3.11.9' },
      [`${managed}/bin/python3 --version`]: { code: 0, stdout: 'Python 3.12.14' },
    })
    state.realpath = {
      '/opt/custom/python': '/opt/custom/python',
      '/usr/bin/python3': '/usr/bin/python3.12',
      '/usr/bin/python': '/usr/bin/python3.12',
      '/home/u/.local/share/uv/python/bin/python3.11': '/home/u/.local/share/uv/python/bin/python3.11',
      [`${managed}/bin/python3`]: `${managed}/bin/python3`,
    }
    const report = await scan({ pythonPath: '/opt/custom/python' })
    expect(report.pythons.map((python) => [python.version, python.source])).toEqual([
      ['3.10.1', 'system'],
      ['3.12.3', 'system'],
      ['3.11.9', 'uv'],
      ['3.12.14', 'managed'],
    ])
    expect(check(report, 'python')).toMatchObject({ status: 'ok', value: '3.10.1 / 3.12.3 / 3.11.9 / 3.12.14' })
  })

  it('warns about missing Python and errors on missing git', async () => {
    state.commands['/bundled/git --version'] = { code: 127, stdout: '' }
    const report = await scan()
    expect(check(report, 'python')).toMatchObject({
      status: 'warn',
      value: '未找到 3.10+',
      actions: [expect.objectContaining({ id: 'python' })],
    })
    expect(check(report, 'git')).toMatchObject({ status: 'error', value: '未安装' })
  })

  it('grades disk and memory space', async () => {
    state.disk = { free: 20 * GB, total: 100 * GB }
    state.memory = 8 * GB
    let report = await scan()
    expect(check(report, 'disk')).toMatchObject({
      status: 'error',
      value: '剩余 20.0 GB / 100.0 GB',
      actions: [expect.objectContaining({ payload: 'storage' })],
    })
    expect(check(report, 'memory').status).toBe('warn')
    state.disk = { free: 40 * GB, total: 100 * GB }
    vi.resetModules()
    report = await scan()
    expect(check(report, 'disk').status).toBe('warn')
  })

  it('summarises the selected mirrors and reports progress for every section', async () => {
    const events: string[] = []
    const report = await (
      await import('@main/services/env')
    ).scanEnvironment(settingsFixture(), (event) => events.push(`${event.section}:${event.status}`))
    expect(check(report, 'network')).toMatchObject({
      status: 'ok',
      value: 'git ghproxy.net · pip pypi.tuna.tsinghua.edu.cn · hf hf-mirror.com',
    })
    expect(events.filter((event) => event.endsWith(':done')).sort()).toEqual([
      'accelerator:done',
      'memory:done',
      'network:done',
      'system:done',
      'tools:done',
    ])
    state.network = { ...state.network, selected: { git: null, pip: null, hf: null, manifest: null } }
    vi.resetModules()
    expect(check(await scan(), 'network')).toMatchObject({ status: 'warn', value: 'git 直连 · pip 默认 · hf 直连' })
  })

  it('reads Windows GPUs from PowerShell JSON', async () => {
    setPlatform('win32')
    state.commands['powershell'] = {
      code: 0,
      stdout: JSON.stringify([{ Name: 'Microsoft Basic Display' }, { Name: 'AMD Radeon RX 7900', DriverVersion: '31.0' }]),
    }
    expect((await scan()).gpu).toEqual({ kind: 'amd', name: 'AMD Radeon RX 7900', driver: '31.0', available: true })
  })

  it('reads Apple GPUs from system_profiler on macOS', async () => {
    setPlatform('darwin')
    state.commands['system_profiler'] = {
      code: 0,
      stdout: JSON.stringify({
        SPDisplaysDataType: [
          {
            sppci_model: 'Apple M3 Max',
            sppci_cores: '40',
            spdisplays_mtlgpufamilysupport: 'spdisplays_metal3',
            spdisplays_vram: '1536 MB',
          },
        ],
      }),
    }
    state.commands['vm_stat'] = {
      code: 0,
      stdout: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  1000.\nPages inactive:  1000.\n',
    }
    const report = await scan()
    expect(report.gpu).toEqual({
      kind: 'apple',
      name: 'Apple M3 Max',
      cores: 40,
      memoryBytes: 1536 * 1024 * 1024,
      metal: true,
      available: true,
    })
    expect(report.device.memoryFree).toBe(2000 * 16384)
  })
})
