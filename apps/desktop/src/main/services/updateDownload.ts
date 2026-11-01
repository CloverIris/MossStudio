import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import * as yauzl from 'yauzl'
import type { ReleaseInstaller, UpdateDownloadState } from '@shared/release'
import { Events } from '@shared/channels'
import { assertFreeSpace } from '../lib/disk'
import { emit } from '../lib/events'
import { isInside, paths } from '../lib/paths'
import { getLastNetwork, githubMirrorChain } from './network'
import { getSettings } from './settings'

const states = new Map<string, UpdateDownloadState>()
const controllers = new Map<string, AbortController>()
const MAX_ZIP_ENTRIES = 50_000
const MAX_UNPACKED_BYTES = 8 * 1024 ** 3

function now(): string {
  return new Date().toISOString()
}

function publish(state: UpdateDownloadState): UpdateDownloadState {
  states.set(state.version, state)
  emit(Events.updateDownload, state)
  return state
}

function safeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'unknown'
}

function installerPath(version: string, installer: ReleaseInstaller): string {
  let name = `MossStudio-${safeVersion(version)}.${installer.kind}`
  try {
    const candidate = basename(new URL(installer.url).pathname)
    if (candidate && candidate !== '/') name = candidate.replace(/[^A-Za-z0-9._-]/g, '-')
  } catch {
    // Keep a safe fallback name for invalid URLs so validation can report the actual problem.
  }
  const dir = join(paths.downloads(), 'updates', safeVersion(version))
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

function validate(version: string, installer: ReleaseInstaller): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error('更新版本号不是有效的 SemVer')
  }
  const parsed = new URL(installer.url)
  const testHttp =
    process.env['CLOVER_UPDATE_TEST'] === '1' &&
    parsed.protocol === 'http:' &&
    parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !testHttp) {
    throw new Error('安装包地址必须使用 HTTPS')
  }
  if (!/^[a-f0-9]{64}$/i.test(installer.sha256)) throw new Error('安装包缺少有效的 sha256')
  if (!Number.isSafeInteger(installer.size_bytes) || installer.size_bytes <= 0) {
    throw new Error('安装包大小无效')
  }
  if (installer.platform !== process.platform) throw new Error('安装包平台与当前设备不匹配')
  if (installer.arch !== process.arch) throw new Error('安装包架构与当前设备不匹配')
}

function downloadCandidates(url: string): string[] {
  const settings = getSettings()
  const hostname = new URL(url).hostname
  if (
    settings.networkMode === 'direct' ||
    (hostname !== 'github.com' && hostname !== 'raw.githubusercontent.com')
  ) {
    return [url]
  }
  const preferred = Boolean(settings.gitMirror?.trim() || getLastNetwork()?.selected.git)
  const mirrors = githubMirrorChain(settings).map((mirror) => `${mirror.replace(/\/$/, '')}/${url}`)
  return [...new Set(preferred ? [...mirrors, url] : [url, ...mirrors])]
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '下载源'
  }
}

function updateProgress(
  base: UpdateDownloadState,
  received: number,
  total: number,
  lastSample: { time: number; bytes: number },
): void {
  const timestamp = Date.now()
  if (timestamp - lastSample.time < 250) return
  const elapsed = Math.max(0.001, (timestamp - lastSample.time) / 1000)
  publish({
    ...base,
    phase: 'downloading',
    bytes: received,
    totalBytes: total,
    percent: Math.min(99.9, (received / total) * 100),
    speedBps: Math.max(0, (received - lastSample.bytes) / elapsed),
    updatedAt: now(),
  })
  lastSample.time = timestamp
  lastSample.bytes = received
}

async function downloadArchive(
  version: string,
  installer: ReleaseInstaller,
  target: string,
  controller: AbortController,
  base: UpdateDownloadState,
): Promise<number> {
  const part = `${target}.part`
  const candidates = downloadCandidates(installer.url)
  const failures: string[] = []

  for (const candidate of candidates) {
    if (controller.signal.aborted) throw new Error('已取消下载')
    rmSync(part, { force: true })
    let stream: ReturnType<typeof createWriteStream> | null = null
    try {
      const response = await fetch(candidate, {
        headers: { 'user-agent': `MossStudio-Launcher/${app.getVersion()}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.body) throw new Error('下载响应没有 body')

      const hash = createHash('sha256')
      stream = createWriteStream(part)
      const reader = response.body.getReader()
      let received = 0
      const startedAt = Date.now()
      const sample = { time: startedAt, bytes: 0 }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (controller.signal.aborted) throw new Error('已取消下载')
        const chunk = Buffer.from(value)
        hash.update(chunk)
        received += chunk.length
        if (!stream.write(chunk)) await once(stream, 'drain')
        updateProgress(base, received, installer.size_bytes, sample)
      }
      stream.end()
      await once(stream, 'finish')

      publish({
        ...base,
        phase: 'verifying',
        bytes: received,
        totalBytes: installer.size_bytes,
        percent: 100,
        speedBps: 0,
        updatedAt: now(),
      })
      if (received !== installer.size_bytes) {
        throw new Error(`下载大小不匹配（收到 ${received} 字节，预期 ${installer.size_bytes} 字节）`)
      }
      if (hash.digest('hex').toLowerCase() !== installer.sha256.toLowerCase()) {
        throw new Error('安装包 sha256 校验失败')
      }
      if (existsSync(target)) rmSync(target, { force: true })
      await rename(part, target)
      return received
    } catch (error) {
      stream?.destroy()
      rmSync(part, { force: true })
      if (controller.signal.aborted) throw new Error('已取消下载')
      failures.push(`${hostLabel(candidate)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(`所有下载源均失败：${failures.join('；')}`)
}

async function extractUpdateZip(zipPath: string, destination: string, signal: AbortSignal): Promise<void> {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  const root = resolve(destination)

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false
    let entries = 0
    let unpackedBytes = 0
    let zipfile: yauzl.ZipFile | undefined

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      zipfile?.close()
      rejectPromise(error)
    }

    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, opened) => {
      if (error || !opened) {
        fail(new Error(`无法打开更新 ZIP：${error?.message ?? '未知错误'}`))
        return
      }
      zipfile = opened
      opened.on('error', fail)
      opened.on('end', () => {
        if (settled) return
        settled = true
        opened.close()
        resolvePromise()
      })
      opened.on('entry', (entry: yauzl.Entry) => {
        try {
          if (signal.aborted) {
            fail(new Error('更新解压已取消'))
            return
          }
          entries += 1
          unpackedBytes += entry.uncompressedSize
          if (entries > MAX_ZIP_ENTRIES || unpackedBytes > MAX_UNPACKED_BYTES) {
            fail(new Error('更新 ZIP 超出允许的文件数量或解压大小'))
            return
          }
          const name = entry.fileName.replace(/\\/g, '/')
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff
          if (
            !name ||
            name.includes('\0') ||
            name.startsWith('/') ||
            name.split('/').some((part) => part === '..' || part === '.' || part.includes(':')) ||
            (mode & 0xf000) === 0xa000
          ) {
            fail(new Error(`更新 ZIP 包含不安全路径：${entry.fileName}`))
            return
          }
          const target = resolve(root, ...name.split('/'))
          const relative = target.slice(root.length)
          if (target !== root && (!relative.startsWith(sep) || !isInside(root, target))) {
            fail(new Error(`更新 ZIP 路径越界：${entry.fileName}`))
            return
          }
          if (entry.fileName.endsWith('/') || (mode & 0xf000) === 0x4000) {
            mkdirSync(target, { recursive: true })
            opened.readEntry()
            return
          }
          mkdirSync(dirname(target), { recursive: true })
          opened.openReadStream(entry, (streamError, input) => {
            if (streamError || !input) {
              fail(new Error(`无法读取更新文件 ${entry.fileName}：${streamError?.message ?? '未知错误'}`))
              return
            }
            const output = createWriteStream(target, { flags: 'wx' })
            void pipeline(input, output, { signal }).then(
              () => opened.readEntry(),
              (pipelineError: unknown) =>
                fail(
                  new Error(
                    `更新 ZIP 解压失败 ${entry.fileName}：${pipelineError instanceof Error ? pipelineError.message : String(pipelineError)}`,
                  ),
                ),
            )
          })
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      })
      opened.readEntry()
    })
  })
}

function launchUpdater(stage: string, version: string): Promise<void> {
  const installDir = dirname(process.execPath)
  const updater = join(stage, 'resources', 'release', 'updater.ps1')
  const executable = join(installDir, 'MossStudio.exe')
  const log = join(paths.logs(), `update-${safeVersion(version)}.log`)
  if (basename(process.execPath).toLowerCase() !== 'mossstudio.exe') {
    throw new Error('当前应用目录不支持原位更新；请从 MossStudio.exe 启动')
  }
  if (!existsSync(updater)) throw new Error('更新包缺少 updater.ps1')

  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        updater,
        '-ParentPid',
        String(process.pid),
        '-SourceDir',
        stage,
        '-InstallDir',
        installDir,
        '-Executable',
        executable,
        '-LogPath',
        log,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.once('error', rejectPromise)
    child.once('spawn', () => {
      child.unref()
      resolvePromise()
    })
  })
}

export function getUpdateDownloadState(version: string): UpdateDownloadState | null {
  return states.get(version) ?? null
}

export function cancelUpdateDownload(version: string): UpdateDownloadState | null {
  const controller = controllers.get(version)
  if (controller) controller.abort()
  const state = states.get(version)
  return state ? { ...state } : null
}

export async function downloadUpdate(
  version: string,
  installer: ReleaseInstaller,
): Promise<UpdateDownloadState> {
  validate(version, installer)
  const active = states.get(version)
  if (
    active?.phase === 'downloading' ||
    active?.phase === 'verifying' ||
    active?.phase === 'extracting' ||
    active?.phase === 'installing'
  ) {
    return active
  }

  const controller = new AbortController()
  controllers.set(version, controller)
  const target = installerPath(version, installer)
  const baseState: UpdateDownloadState = {
    version,
    phase: 'downloading',
    bytes: 0,
    totalBytes: installer.size_bytes,
    percent: 0,
    speedBps: 0,
    path: target,
    updatedAt: now(),
  }
  publish(baseState)

  try {
    await assertFreeSpace(target, installer.size_bytes * 3, '更新下载与解压')
    const received = await downloadArchive(version, installer, target, controller, baseState)
    const ready: UpdateDownloadState = {
      ...baseState,
      phase: 'ready',
      bytes: received,
      totalBytes: installer.size_bytes,
      percent: 100,
      speedBps: 0,
      path: target,
      updatedAt: now(),
    }

    if (installer.platform === 'win32' && installer.kind === 'zip') {
      const stage = `${target}.stage`
      publish({ ...ready, phase: 'extracting', updatedAt: now() })
      await extractUpdateZip(target, stage, controller.signal)
      if (
        !existsSync(join(stage, 'MossStudio.exe')) ||
        !existsSync(join(stage, 'resources', 'app.asar')) ||
        !existsSync(join(stage, 'resources', 'release', 'updater.ps1'))
      ) {
        throw new Error('更新 ZIP 缺少 MossStudio 可执行文件、应用包或 updater')
      }
      if (process.env['CLOVER_UPDATE_TEST'] === '1') {
        return publish({ ...ready, path: stage, updatedAt: now() })
      }
      if (!app.isPackaged) throw new Error('开发模式不能就地更新；请从已打包的 MossStudio 启动')

      publish({ ...ready, phase: 'installing', path: stage, updatedAt: now() })
      await launchUpdater(stage, version)
      const opened = publish({
        ...ready,
        phase: 'opened',
        path: stage,
        updatedAt: now(),
      })
      setTimeout(() => app.quit(), 750)
      return opened
    }

    if (process.env['CLOVER_UPDATE_TEST'] === '1') return publish(ready)
    const openError = await shell.openPath(target)
    if (openError) {
      return publish({
        ...ready,
        error: `安装包已下载，但无法自动打开：${openError}`,
      })
    }
    return publish({ ...ready, phase: 'opened', updatedAt: now() })
  } catch (error) {
    rmSync(`${target}.part`, { force: true })
    const canceled = controller.signal.aborted
    return publish({
      ...baseState,
      phase: canceled ? 'canceled' : 'error',
      error: canceled
        ? '下载或解压已取消'
        : error instanceof Error
          ? error.message
          : String(error),
      updatedAt: now(),
    })
  } finally {
    controllers.delete(version)
  }
}
