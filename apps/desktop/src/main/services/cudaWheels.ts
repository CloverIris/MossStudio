import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as yauzl from 'yauzl'
import { getSettings } from './settings'
import { deviceEngines } from './engineInstalls'
import { shutdownMossInfer } from './mossInfer'
import { probeEngine } from '../lib/probeEngine'
import type { EngineHello } from '@shared/engineProtocol'

interface PyPiFile {
  filename?: string
  url?: string
  digests?: { sha256?: string }
}

interface PyPiJson {
  info?: { version?: string }
  urls?: PyPiFile[]
}

const PACKAGES = {
  cu12: ['nvidia-cublas-cu12', 'nvidia-cuda-runtime-cu12'],
  cu13: ['nvidia-cublas', 'nvidia-cuda-runtime'],
} as const

function platformTag(): RegExp {
  if (process.platform === 'win32') return /win_amd64\.whl$/i
  if (process.platform === 'linux') return /(manylinux|linux_x86_64).*\.whl$/i
  throw new Error('原生 CUDA wheel 安装仅支持 Windows/Linux')
}

async function fetchJson(url: string): Promise<PyPiJson> {
  const response = await fetch(url, { headers: { 'user-agent': 'MossStudio' }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`PyPI ${response.status}: ${url}`)
  return (await response.json()) as PyPiJson
}

async function downloadWheel(pkg: string): Promise<{ name: string; buffer: Buffer }> {
  const data = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`)
  const file = (data.urls ?? []).find((item) => item.url && item.filename && platformTag().test(item.filename))
  if (!file?.url || !file.filename) throw new Error(`PyPI 没有 ${pkg} 的当前平台 wheel`)
  const response = await fetch(file.url, { headers: { 'user-agent': 'MossStudio' }, signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`下载 ${file.filename} 失败：HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(buffer).digest('hex')
  const expected = file.digests?.sha256
  if (expected && digest !== expected) throw new Error(`${file.filename} sha256 校验失败`)
  return { name: file.filename, buffer }
}

function extractLibs(buffer: Buffer, dest: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('无法打开 wheel'))
        return
      }
      const libs: string[] = []
      const fail = (cause: unknown): void => {
        zip.close()
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
      zip.on('error', fail)
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry()
          return
        }
        const name = basename(entry.fileName)
        if (!/\.(so(\.\d+)*|dll|dylib)$/i.test(name)) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error('无法读取 wheel 条目'))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('error', fail)
          stream.on('end', () => {
            try {
              writeFileSync(join(dest, name), Buffer.concat(chunks))
              libs.push(name)
              zip.readEntry()
            } catch (writeError) {
              fail(writeError)
            }
          })
        })
      })
      zip.on('end', () => resolve([...new Set(libs)]))
      zip.readEntry()
    })
  })
}

export async function installCudaWheels(installDir: string, flavour: 'cu12' | 'cu13'): Promise<{ installed: string[]; packages: string[] }> {
  const dest = join(installDir, process.platform === 'win32' ? 'bin' : 'lib')
  mkdirSync(dest, { recursive: true })
  const installed: string[] = []
  const packages: string[] = []
  for (const pkg of PACKAGES[flavour]) {
    const wheel = await downloadWheel(pkg)
    packages.push(wheel.name)
    installed.push(...(await extractLibs(wheel.buffer, dest)))
  }
  const all = [...new Set(installed)]
  if (!all.some((name) => /cublasLt/i.test(name))) throw new Error('wheel 解压后没有找到 cublasLt')
  return { installed: all, packages }
}

/** The moss-server a GPU runs from a system-CUDA package (the pinned one first), else any CUDA one. */
function systemCudaServerPath(): string | null {
  const pinned = getSettings().mossInferServerPath
  if (pinned && existsSync(pinned)) return pinned
  const cuda = deviceEngines().flatMap(({ engine }) => (engine?.package.kind === 'cuda' ? [engine] : []))
  const systemCuda = cuda.find((engine) => engine.package.kind === 'cuda' && engine.package.runtime === 'system-cuda')
  return (systemCuda ?? cuda[0])?.binaryPath ?? null
}

/** Download and extract NVIDIA wheels into the installed engine tree, no Python/uv/pip. */
export async function installMossInferCudaLibs(): Promise<{ installed: string[]; packages: string[] }> {
  const serverPath = systemCudaServerPath()
  if (!serverPath || !existsSync(serverPath)) throw new Error('还没有安装 moss-server，请先下载引擎')
  let probe: EngineHello
  try {
    probe = await probeEngine(serverPath, { env: { MOSSINFER_CUDA_LIBS: 'bundled' } })
  } catch (error) {
    throw new Error(`无法探测引擎 CUDA 版本：${error instanceof Error ? error.message : String(error)}`)
  }
  const runtime = probe.probe?.runtimeCudaVersion ?? 0
  const major = Math.floor(runtime / 1000)
  if (major !== 12 && major !== 13) throw new Error(`无法识别引擎 CUDA 主版本（${runtime}）`)
  const installDir = join(serverPath, '..', '..')
  const result = await installCudaWheels(installDir, major === 12 ? 'cu12' : 'cu13')
  await shutdownMossInfer()
  return result
}

export function listEngineLibs(installDir: string): string[] {
  const dir = join(installDir, process.platform === 'win32' ? 'bin' : 'lib')
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
