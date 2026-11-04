import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '@test/helpers/tempDir'

const state = { smi: { code: 0, stdout: '' }, ldconfig: '', find: '', calls: [] as string[] }
vi.mock('@main/lib/run', () => ({
  run: async (command: string) => {
    state.calls.push(command)
    if (command === 'nvidia-smi') return { ...state.smi, stderr: '', timedOut: false }
    if (command === 'ldconfig') return { code: 0, stdout: state.ldconfig, stderr: '', timedOut: false }
    return { code: 0, stdout: state.find, stderr: '', timedOut: false }
  },
}))

const temp = useTempDir()
const originalPlatform = process.platform
const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true })
const gpu = (driver: string) => ({ code: 0, stdout: `NVIDIA GeForce RTX 4090, ${driver}\n` })

beforeEach(() => {
  vi.resetModules()
  Object.assign(state, { smi: gpu('581.42'), ldconfig: '', find: '', calls: [] })
})
afterEach(() => setPlatform(originalPlatform))
const load = () => import('@main/services/systemCuda')

describe('detectSystemCuda', () => {
  it('is unsupported on macOS without running anything', async () => {
    setPlatform('darwin')
    expect(await (await load()).detectSystemCuda()).toMatchObject({ supported: false, flavours: [], error: expect.stringContaining('macOS') })
    expect(state.calls).toEqual([])
  })

  it('supports Linux with a CUDA 13 cuBLASLt and an R580+ driver', async () => {
    setPlatform('linux')
    state.ldconfig = '\tlibcublasLt.so.13 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libcublasLt.so.13\n\tlibcublasLt.so.12 (libc6,x86-64) => /usr/lib/libcublasLt.so.12\n\tlibfoo.so.1 => /x\n'
    const status = await (await load()).detectSystemCuda()
    expect(status).toMatchObject({ supported: true, flavours: ['cu12', 'cu13'], driverVersion: '581.42', driverCompatible: true, error: undefined })
    expect(status.cublasLt).toHaveLength(2)
    expect(state.calls).not.toContain('find')
  })

  it('falls back to find when ldconfig knows nothing and explains a CUDA 12-only system', async () => {
    setPlatform('linux')
    state.find = '/usr/local/cuda-12.4/lib64/libcublasLt.so.12.4.5\n'
    const status = await (await load()).detectSystemCuda()
    expect(status.flavours).toEqual(['cu12'])
    expect(status.supported).toBe(false)
    expect(status.error).toMatch(/只检测到 CUDA 12/)
  })

  it('rejects an old driver even with CUDA 13 libraries', async () => {
    setPlatform('linux')
    state.smi = gpu('560.94')
    state.ldconfig = 'libcublasLt.so.13 => /usr/lib/libcublasLt.so.13\n'
    const status = await (await load()).detectSystemCuda()
    expect(status).toMatchObject({ supported: false, driverCompatible: false, error: expect.stringContaining('R580') })
  })

  it('reports a missing GPU and missing libraries', async () => {
    setPlatform('linux')
    state.smi = { code: 127, stdout: '' }
    expect(await (await load()).detectSystemCuda()).toMatchObject({ supported: false, driverVersion: undefined, driverCompatible: undefined, error: '未检测到 NVIDIA GPU / nvidia-smi' })
    state.smi = gpu('581.42')
    expect((await (await load()).detectSystemCuda()).error).toMatch(/未找到 CUDA 13/)
  })

  it('finds cublasLt64_13.dll in CUDA_PATH and PATH on Windows', async () => {
    setPlatform('win32')
    mkdirSync(join(temp(), 'cuda', 'bin'), { recursive: true })
    writeFileSync(join(temp(), 'cuda', 'bin', 'cublasLt64_13.dll'), '')
    mkdirSync(join(temp(), 'onpath'), { recursive: true })
    writeFileSync(join(temp(), 'onpath', 'cublasLt64_12.dll'), '')
    vi.stubEnv('CUDA_PATH', join(temp(), 'cuda'))
    vi.stubEnv('ProgramFiles', '')
    vi.stubEnv('SystemRoot', '')
    vi.stubEnv('PATH', join(temp(), 'onpath'))
    const status = await (await load()).detectSystemCuda()
    expect(status.flavours).toEqual(['cu12', 'cu13'])
    expect(status.supported).toBe(true)
    expect(state.calls).not.toContain('ldconfig')
  })
})
