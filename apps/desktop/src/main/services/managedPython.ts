import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { PythonInstallState } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { pythonVersion } from '../lib/python'
import { run } from '../lib/run'
import { getSettings, updateSettings } from './settings'
import { pickPython } from './trainerEnv'

const repository = 'astral-sh/python-build-standalone'
interface Asset {
  name: string
  browser_download_url: string
  size: number
  digest?: string | null
}
let current: PythonInstallState | null = null
let installing: Promise<PythonInstallState> | null = null

export function getPythonInstallState(): PythonInstallState | null {
  return current
}

function publish(patch: Partial<PythonInstallState>): void {
  current = { phase: 'querying', bytes: 0, totalBytes: 0, percent: 0, ...current, ...patch }
  emit(Events.pythonInstall, current)
}

function target(): string {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null
  if (!arch) throw new Error(`内置 Python 暂不支持 ${process.arch}`)
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (process.platform === 'linux') {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    const libc = report?.header?.glibcVersionRuntime ? 'gnu' : 'musl'
    return `${arch}-unknown-linux-${libc}`
  }
  throw new Error(`内置 Python 暂不支持 ${process.platform}`)
}

async function source(): Promise<{ asset: Asset; sha256: string; version: string; stamp: string }> {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'MossStudio' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`查询内置 Python 下载失败：HTTP ${response.status}`)
  const release = (await response.json()) as { tag_name: string; assets: Asset[] }
  if (!/^\d{8}$/.test(release.tag_name)) throw new Error('Python 发布版本格式无效')
  const suffix = `-${target()}-install_only.tar.gz`
  const asset = release.assets
    .filter((item) => /^cpython-3\.12\.\d+\+\d{8}-/.test(item.name) && item.name.endsWith(suffix))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))[0]
  if (!asset) throw new Error('上游没有提供适用于当前系统的 Python 3.12 安装包')
  const prefix = `https://github.com/${repository}/releases/download/${release.tag_name}/`
  if (!asset.browser_download_url.startsWith(prefix)) throw new Error('Python 下载地址无效')
  let sha256 = asset.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1]
  if (!sha256) {
    const sums = await fetch(`${prefix}SHA256SUMS`, { signal: AbortSignal.timeout(30_000) })
    if (sums.ok) {
      const entry = (await sums.text()).split(/\r?\n/).find((line) => line.trim().split(/\s+/)[1]?.replace(/^\*/, '') === asset.name)
      sha256 = entry?.match(/^([a-f0-9]{64})\s/)?.[1]
    }
  }
  if (!sha256) throw new Error('上游未提供 Python 安装包的 SHA256 校验信息，请稍后重试')
  const version = asset.name.match(/^cpython-(3\.12\.\d+)\+/)![1]!
  return { asset, sha256, version, stamp: `cpython-${version}-${release.tag_name}-${target()}` }
}

async function install(): Promise<PythonInstallState> {
  let work: string | undefined
  try {
    const existing = await pickPython(getSettings()).catch(() => null)
    if (existing) {
      publish({ phase: 'done', version: existing.version, path: existing.path, percent: 100 })
      return current!
    }
    const { asset, sha256, version, stamp } = await source()
    const destination = join(paths.managedPython(), stamp)
    const executable = (directory: string): string =>
      process.platform === 'win32' ? join(directory, 'python.exe') : join(directory, 'bin', 'python3')
    if (!(await pythonVersion(executable(destination)))) {
      await mkdir(paths.managedPython(), { recursive: true })
      work = await mkdtemp(join(paths.managedPython(), '.install-'))
      const archive = join(work, 'python.tar.gz')
      publish({ phase: 'downloading', version, totalBytes: asset.size })
      const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(20 * 60_000) })
      if (!response.ok || !response.body) throw new Error(`下载内置 Python 失败：HTTP ${response.status}`)
      const hash = createHash('sha256')
      let bytes = 0,
        last = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk)
          bytes += chunk.length
          if (Date.now() - last >= 250) {
            publish({ bytes, percent: asset.size ? Math.min(99, (bytes / asset.size) * 100) : 0 })
            last = Date.now()
          }
          callback(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(archive))
      publish({ phase: 'verifying', bytes, percent: 100 })
      if (hash.digest('hex') !== sha256) throw new Error('Python 安装包 SHA256 校验失败，请重试')
      publish({ phase: 'extracting' })
      const extracted = join(work, 'extracted')
      await mkdir(extracted)
      const result = await run('tar', ['-xzf', archive, '-C', extracted], { timeoutMs: 180_000 })
      if (result.code !== 0) throw new Error(`解压内置 Python 失败：${result.stderr.trim() || '系统 tar 不可用'}`)
      const directory = join(extracted, 'python')
      const probe = await run(executable(directory), ['-I', '-c', 'import sys, venv, ensurepip, ssl; print(sys.version.split()[0])'], {
        timeoutMs: 15_000,
      })
      if (probe.code !== 0 || probe.stdout.trim() !== version)
        throw new Error(`内置 Python 校验失败：${probe.stderr.trim() || '解释器无法运行'}`)
      if (existsSync(destination)) await rename(destination, `${destination}.broken-${Date.now()}`)
      await rename(directory, destination)
    }
    const path = executable(destination)
    if ((await pythonVersion(path)) !== version) throw new Error('内置 Python 安装后无法运行，请重试')
    const settings = updateSettings({ pythonPath: path })
    emit(Events.settingsChanged, settings)
    publish({ phase: 'done', path, version, percent: 100 })
  } catch (error) {
    publish({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
  return current!
}

export function installManagedPython(): Promise<PythonInstallState> {
  if (installing) return installing
  current = null
  publish({ phase: 'querying' })
  installing = install().finally(() => {
    installing = null
  })
  return installing
}
