import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

/** Minimal stored (uncompressed) ZIP writer, enough for yauzl. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text)
    const fileName = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, fileName, data)
    centrals.push(central, fileName)
    offset += 30 + fileName.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const state = {
  settings: settingsFixture(),
  runtimeCudaVersion: 13000 as number,
  probeError: null as Error | null,
}
const shutdownMossInfer = vi.fn(async () => undefined)
vi.mock('@main/services/settings', () => ({ getSettings: () => state.settings }))
vi.mock('@main/services/mossInfer', () => ({ shutdownMossInfer: () => shutdownMossInfer() }))
vi.mock('@main/lib/probeEngine', () => ({
  probeEngine: async () => {
    if (state.probeError) throw state.probeError
    return { probe: { runtimeCudaVersion: state.runtimeCudaVersion } }
  },
}))

const temp = useTempDir()
const originalPlatform = process.platform
const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true })
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')

const wheels: Record<string, Buffer> = {
  'nvidia-cublas': zip({ 'nvidia/cu13/lib/': '', 'nvidia/cu13/lib/libcublasLt.so.13': 'lt', 'nvidia/cu13/lib/libcublas.so.13': 'blas', 'nvidia/__init__.py': '' }),
  'nvidia-cuda-runtime': zip({ 'nvidia/cu13/lib/libcudart.so.13': 'rt', 'METADATA': 'x' }),
  'nvidia-cublas-cu12': zip({ 'nvidia/cublas/lib/libcublasLt.so.12': 'lt12' }),
  'nvidia-cuda-runtime-cu12': zip({ 'nvidia/cuda_runtime/lib/libcudart.so.12': 'rt12' }),
}
const options = { badDigest: '' as string, noWheel: '' as string, http: 200 }

function stubPyPi() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input)
    const json = /https:\/\/pypi\.org\/pypi\/([^/]+)\/json/.exec(url)
    if (json) {
      const pkg = decodeURIComponent(json[1]!)
      const wheel = wheels[pkg]!
      return Response.json({ urls: [
        { filename: `${pkg}-1.0-py3-none-win_amd64.whl`, url: `https://files.test/${pkg}-win.whl`, digests: { sha256: sha(wheel) } },
        ...(options.noWheel === pkg ? [] : [{ filename: `${pkg}-1.0-py3-none-manylinux_2_27_x86_64.whl`, url: `https://files.test/${pkg}.whl`, digests: { sha256: options.badDigest === pkg ? '0'.repeat(64) : sha(wheel) } }]),
      ] })
    }
    const pkg = /files\.test\/(.+?)(?:-win)?\.whl$/.exec(url)?.[1]
    if (pkg && wheels[pkg]) return new Response(new Uint8Array(wheels[pkg]), { status: options.http })
    return new Response('', { status: 404 })
  }))
}

beforeEach(() => {
  vi.resetModules()
  setPlatform('linux')
  Object.assign(options, { badDigest: '', noWheel: '', http: 200 })
  Object.assign(state, { settings: settingsFixture(), runtimeCudaVersion: 13000, probeError: null })
  shutdownMossInfer.mockClear()
  stubPyPi()
})
afterEach(() => setPlatform(originalPlatform))
const load = () => import('@main/services/cudaWheels')

describe('installCudaWheels', () => {
  it('extracts only shared libraries from the platform wheels into lib/', async () => {
    const result = await (await load()).installCudaWheels(temp(), 'cu13')
    expect(result.packages).toEqual(['nvidia-cublas-1.0-py3-none-manylinux_2_27_x86_64.whl', 'nvidia-cuda-runtime-1.0-py3-none-manylinux_2_27_x86_64.whl'])
    expect(result.installed.sort()).toEqual(['libcublas.so.13', 'libcublasLt.so.13', 'libcudart.so.13'])
    expect(readdirSync(join(temp(), 'lib')).sort()).toEqual(['libcublas.so.13', 'libcublasLt.so.13', 'libcudart.so.13'])
    expect(readFileSync(join(temp(), 'lib', 'libcublasLt.so.13'), 'utf8')).toBe('lt')
  })

  it('uses the cu12 package set', async () => {
    const result = await (await load()).installCudaWheels(temp(), 'cu12')
    expect(result.installed.sort()).toEqual(['libcublasLt.so.12', 'libcudart.so.12'])
  })

  it('rejects checksum mismatches, missing wheels and HTTP errors', async () => {
    const { installCudaWheels } = await load()
    options.badDigest = 'nvidia-cublas'
    await expect(installCudaWheels(temp(), 'cu13')).rejects.toThrow('sha256 校验失败')
    options.badDigest = ''
    options.noWheel = 'nvidia-cublas'
    await expect(installCudaWheels(temp(), 'cu13')).rejects.toThrow('PyPI 没有 nvidia-cublas 的当前平台 wheel')
    options.noWheel = ''
    options.http = 503
    await expect(installCudaWheels(temp(), 'cu13')).rejects.toThrow(/HTTP 503/)
  })

  it('fails when no cublasLt came out of the wheels', async () => {
    wheels['nvidia-cublas-cu12-backup'] = wheels['nvidia-cublas-cu12']!
    wheels['nvidia-cublas-cu12'] = zip({ 'readme.txt': 'x' })
    try {
      await expect((await load()).installCudaWheels(temp(), 'cu12')).rejects.toThrow('wheel 解压后没有找到 cublasLt')
    } finally {
      wheels['nvidia-cublas-cu12'] = wheels['nvidia-cublas-cu12-backup']!
      delete wheels['nvidia-cublas-cu12-backup']
    }
  })

  it('refuses unsupported platforms and writes Windows DLLs to bin/', async () => {
    setPlatform('darwin')
    await expect((await load()).installCudaWheels(temp(), 'cu13')).rejects.toThrow('仅支持 Windows/Linux')
    vi.resetModules()
    setPlatform('win32')
    await (await load()).installCudaWheels(temp(), 'cu13')
    expect(existsSync(join(temp(), 'bin', 'libcublasLt.so.13'))).toBe(true)
  })
})

describe('installMossInferCudaLibs', () => {
  function engine(): string {
    const server = join(temp(), 'v1', 'bin', 'moss-server')
    mkdirSync(join(temp(), 'v1', 'bin'), { recursive: true })
    writeFileSync(server, '')
    state.settings = settingsFixture({ mossInferServerPath: server })
    return server
  }

  it('installs the wheels matching the engine CUDA major next to the engine and restarts it', async () => {
    engine()
    state.runtimeCudaVersion = 12080
    const result = await (await load()).installMossInferCudaLibs()
    expect(result.installed).toContain('libcublasLt.so.12')
    expect(existsSync(join(temp(), 'v1', 'lib', 'libcudart.so.12'))).toBe(true)
    expect(shutdownMossInfer).toHaveBeenCalledOnce()
  })

  it('requires an installed engine with a recognisable CUDA major', async () => {
    const { installMossInferCudaLibs } = await load()
    await expect(installMossInferCudaLibs()).rejects.toThrow('还没有安装 moss-server')
    engine()
    state.runtimeCudaVersion = 11080
    await expect(installMossInferCudaLibs()).rejects.toThrow('无法识别引擎 CUDA 主版本（11080）')
    state.probeError = new Error('exec format error')
    await expect(installMossInferCudaLibs()).rejects.toThrow('无法探测引擎 CUDA 版本：exec format error')
    expect(shutdownMossInfer).not.toHaveBeenCalled()
  })
})

describe('listEngineLibs', () => {
  it('lists lib/ or returns [] when missing', async () => {
    const { listEngineLibs } = await load()
    expect(listEngineLibs(temp())).toEqual([])
    mkdirSync(join(temp(), 'lib'))
    writeFileSync(join(temp(), 'lib', 'a.so'), '')
    expect(listEngineLibs(temp())).toEqual(['a.so'])
  })
})
