import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, chmodSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { open, rename } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, join, resolve, sep } from 'node:path'
import * as yauzl from 'yauzl'
import type { GpuInventoryDevice, MossInferDownloadState, MossInferRelease, Settings } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { isInside, paths } from '../lib/paths'
import { run } from '../lib/run'
import { releaseStaleMossInferRuntimes, shutdownMossInfer } from './mossInfer'
import { shutdownCliEngines } from './cliEngine'
import { probeEngine } from '../lib/probeEngine'
import {
  cleanupPromotedInstall,
  engineBinaryPath,
  promoteInstall,
  recoverEngineInstall,
  setEngineInstallProgress,
  writeEngineLastAttempt,
} from '../lib/engineStore'
import { invalidateEngineReadiness } from './engineReadiness'
import { installCudaWheels } from './cudaWheels'
import { getSettings, updateSettings } from './settings'
import { getLastNetwork, githubMirrorChain } from './network'
import { assertFreeSpace } from '../lib/disk'
import { MOSSINFER_REPO } from '../lib/engineAssets'
import { judgeEngineSupport, protocolCompatible } from '@shared/engineProtocol'
import {
  driverMinimumLabel,
  driverSupports,
  engineAssetName,
  enginePackageId,
  enginePackageOptionLabel,
  packageExistsFor,
  releaseAssetVersion,
  type EnginePackage,
  type EnginePackageKind,
} from '@shared/enginePackages'
import { engineStampName, parseEngineStamp } from '@shared/engineUpdate'
import { refreshGpuInventory } from './devices'
import { activateWhenAllowed, type ActivationGate } from '../lib/engineActivation'

/**
 * Downloads the MossInfer engine package from the upstream repo mossimage-cpp/mossimage.cpp
 * (formerly xycld/owoinfer; GitHub redirects the old slug):
 * - stable: the latest GitHub Release assets (sha256-verified via SHA256SUMS);
 * - dev: the latest successful `ci` run's Actions artifact (requires a token: GitHub
 *   answers 401 on artifact zips even for public repos).
 * Every package (a CUDA flavour/arch/runtime, Vulkan, HIP) installs side by
 * side as `<root>/<channel>-<tag>-<packageId>` keeping its upstream layout
 * (bin/moss-server + lib/, bin/moss-infer-vulkan, bin/moss-infer-hip); which GPU
 * runs which install is decided in engineInstalls.ts.
 */

const REPO = MOSSINFER_REPO
const API = `https://api.github.com/repos/${REPO}`

let current: MossInferDownloadState | null = null
let controller: AbortController | null = null
let operationInProgress = false

function publish(patch: Partial<MossInferDownloadState> & { phase: MossInferDownloadState['phase'] }): void {
  if (!current) return
  current = { ...current, ...patch, updatedAt: new Date().toISOString() }
  const terminal = ['done', 'error', 'canceled'].includes(current.phase)
  setEngineInstallProgress(terminal ? null : {
    phase: current.phase,
    percent: current.percent,
    version: current.version,
  })
  if (current.phase === 'done' || current.phase === 'error') {
    try {
      writeEngineLastAttempt(paths.mossinfer(), {
        at: current.updatedAt,
        version: current.version,
        error: current.phase === 'error' ? current.error ?? '安装失败' : undefined,
      })
    } catch (error) {
      console.error('[engine] persist last attempt', error)
    }
  }
  if (terminal) invalidateEngineReadiness()
  emit(Events.mossInferDownload, current)
}

export function getMossInferDownloadState(): MossInferDownloadState | null {
  return current
}

export function cancelMossInferDownload(): MossInferDownloadState | null {
  if (!controller || !current || current.phase === 'done' || current.phase === 'error' || current.phase === 'canceled') {
    return current
  }
  controller?.abort()
  publish({ phase: 'canceled', error: undefined })
  return current
}

export function resolveGithubToken(settings: Settings): string | null {
  if (settings.githubToken) return settings.githubToken
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  try {
    const probe = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 3000 })
    const token = (probe.stdout ?? '').trim()
    if (probe.status === 0 && token) return token
  } catch {
    // gh CLI not installed
  }
  return null
}

function isGithubFileUrl(url: string): boolean {
  const hostname = new URL(url).hostname
  return hostname === 'github.com' || hostname === 'raw.githubusercontent.com'
}

async function ghJson(path: string, token: string | null): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `MossStudio-Launcher/${app.getVersion()}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: controller
      ? AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
    })
  } catch (error) {
    if (controller?.signal.aborted) throw new Error('已取消下载')
    throw new Error(`GitHub API 网络请求失败（${path}）：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error(
        `GitHub API 请求限流（403）：${path}。请在引擎页保存 GitHub Token 后重试，或等待限流重置。`,
      )
    }
    if (response.status === 403 && !token) {
      throw new Error(`GitHub API ${path} 返回 HTTP 403；可能是匿名请求限流，请在引擎页保存 GitHub Token 后重试。`)
    }
    throw new Error(`GitHub API ${path} 返回 HTTP ${response.status}`)
  }
  return response.json()
}

interface GhAsset {
  name: string
  browser_download_url: string
  size: number
  /** `sha256:<hex>`, set by GitHub on newer uploads. */
  digest?: string | null
}

interface GhArtifact {
  id: number
  name: string
  expired: boolean
  size_in_bytes: number
}

// Archive names (the v2.2.0 contract): see engineAssetName in shared/enginePackages.ts.
function osToken(): 'linux' | 'windows' {
  return process.platform === 'win32' ? 'windows' : 'linux'
}

function archiveExt(): 'tar.gz' | 'zip' {
  return process.platform === 'win32' ? 'zip' : 'tar.gz'
}

const DOWNLOAD_ATTEMPTS = 6

/** Transient proxy/undici failures are worth resuming; HTTP 4xx and checksum errors are not. */
function isRetryable(error: Error): boolean {
  const message = error.message.toLowerCase()
  if (message.includes('http 4')) return false
  if (message.includes('sha256')) return false
  if (message.includes('已取消')) return false
  return true
}


const MIRROR_CHUNK = 16 * 1024 * 1024
const CHUNK_CONCURRENCY = 3
const CHUNK_ATTEMPTS = 5

interface PartMeta {
  url: string
  total: number
  chunk: number
  done: number[]
}

function metaPath(part: string): string {
  return `${part}.json`
}

function readMeta(part: string, url: string, total: number): PartMeta | null {
  try {
    const raw = JSON.parse(readFileSync(metaPath(part), 'utf8')) as PartMeta
    if (raw.url !== url || raw.chunk !== MIRROR_CHUNK) return null
    if (total > 0 && raw.total > 0 && raw.total !== total) return null
    return raw
  } catch {
    return null
  }
}

function writeMeta(part: string, meta: PartMeta): void {
  try {
    writeFileSync(metaPath(part), JSON.stringify(meta))
  } catch {
    // best effort: losing the map only costs a re-download, not correctness
  }
}

/** Candidate URLs for one GitHub file, honouring an explicitly configured mirror first. */
function candidateUrls(url: string, settings: Settings): string[] {
  if (!isGithubFileUrl(url)) return [url]
  const preferred = settings.gitMirror?.trim() || getLastNetwork()?.selected.git || null
  // gh-proxy family takes the full absolute URL after the prefix.
  const mirrored = githubMirrorChain(settings).map((mirror) => `${mirror.replace(/\/$/, '')}/${url}`)
  return [...new Set(preferred ? [...mirrored, url] : [url, ...mirrored])]
}

let lastPublish = 0

function publishProgress(bytes: number, total: number, note?: string): void {
  const now = Date.now()
  if (note === undefined && now - lastPublish < 250) return
  lastPublish = now
  publish({
    phase: 'downloading',
    bytes,
    totalBytes: total,
    percent: total > 0 ? Math.min(99.9, (bytes / total) * 100) : 0,
  })
}

/**
 * Chunked, resumable, multi-mirror download.
 *
 * The map of finished 16 MB chunks lives next to the partial file, so an interrupted
 * install (proxy drop, app quit, power loss) continues where it stopped instead of
 * restarting a 700 MB archive. Chunks are pulled from rotating mirrors, which also
 * spreads the load and lets one dead mirror cost a single chunk retry.
 */
async function downloadTo(
  url: string,
  target: string,
  token: string | null,
  totalHint: number,
  settings: Settings,
  onProgress: (bytes: number, total: number, note?: string) => void = publishProgress,
): Promise<string> {
  const part = `${target}.part`
  const candidates = candidateUrls(url, settings)
  const headers: Record<string, string> = {
    'user-agent': `MossStudio-Launcher/${app.getVersion()}`,
    // undici strips this header on the cross-origin redirect to the artifact blob store.
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }

  let total = totalHint
  if (!(total > 0)) {
    const head = await fetch(candidates[0]!, { method: 'HEAD', headers, redirect: 'follow', signal: controller?.signal })
    const size = Number(head.headers.get('content-length') ?? 0)
    await head.body?.cancel()
    if (size > 0) total = size
  }
  if (!(total > 0)) throw new Error('无法确定引擎包大小；请稍后重试')
  const partialBytes = existsSync(part) ? Math.min(statSync(part).size, total) : 0
  await assertFreeSpace(part, total - partialBytes + total, '引擎下载及解压')

  const meta = readMeta(part, url, total) ?? { url, total, chunk: MIRROR_CHUNK, done: [] as number[] }
  const chunks = Math.ceil(total / MIRROR_CHUNK)
  const done = new Set(meta.done.filter((index) => index >= 0 && index < chunks))
  let received = 0
  for (const index of done) received += Math.min(MIRROR_CHUNK, total - index * MIRROR_CHUNK)

  // A missing partial file invalidates the map; start over rather than fail on open().
  const resumed = done.size > 0 && existsSync(part)
  if (!resumed) done.clear()
  const handle = await open(part, resumed ? 'r+' : 'w+')
  let written = received
  try {
    const queue: number[] = []
    for (let index = 0; index < chunks; index += 1) if (!done.has(index)) queue.push(index)
    onProgress(written, total, resumed ? `从 ${(written / 1024 / 1024).toFixed(1)} MB 继续` : '开始下载')

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = queue.shift()
        if (index === undefined) return
        const start = index * MIRROR_CHUNK
        const end = Math.min(total, start + MIRROR_CHUNK) - 1
        const expected = end - start + 1
        let lastError: Error | null = null
        for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt += 1) {
          if (controller?.signal.aborted) throw new Error('已取消下载')
          try {
            const response = await fetch(candidates[attempt % candidates.length]!, {
              headers: { ...headers, range: `bytes=${start}-${end}` },
              redirect: 'follow',
              signal: controller?.signal,
            })
            if (response.status !== 206) {
              await response.body?.cancel()
              throw new Error(`HTTP ${response.status}`)
            }
            if (!response.body) throw new Error('响应没有 body')
            const reader = response.body.getReader()
            let position = start
            while (true) {
              const { done: finished, value } = await reader.read()
              if (finished) break
              const chunk = Buffer.from(value)
              await handle.write(chunk, 0, chunk.length, position)
              position += chunk.length
              written += chunk.length
              onProgress(written, total)
            }
            if (position !== end + 1) throw new Error(`分段不完整（${position - start}/${expected}）`)
            done.add(index)
            meta.done = [...done]
            writeMeta(part, meta)
            lastError = null
            break
          } catch (error) {
            if (controller?.signal.aborted) throw new Error('已取消下载')
            lastError = error instanceof Error ? error : new Error(String(error))
          }
        }
        if (lastError) throw lastError
      }
    }

    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, Math.max(1, queue.length)) }, () => worker()))
  } finally {
    await handle.close()
  }

  const size = statSync(part).size
  if (size !== total) throw new Error(`文件不完整（${size}/${total} 字节），请重试`)

  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    createReadStream(part)
      .on('data', (chunk: string | Buffer) => hash.update(chunk))
      .on('end', () => resolvePromise())
      .on('error', rejectPromise)
  })
  await rename(part, target)
  rmSync(metaPath(part), { force: true })
  return hash.digest('hex')
}


function sha256Of(sumsText: string, name: string): string | null {
  for (const line of sumsText.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+(\S+)$/)
    if (!match) continue
    const file = match[2]!.replace(/^\*/, '')
    if (file === name || file.endsWith(`/${name}`)) return match[1]!
  }
  return null
}

async function extractZip(zip: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true })
  const root = resolve(dest)
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      zipfile?.close()
      rejectPromise(error)
    }
    let zipfile: yauzl.ZipFile | undefined
    yauzl.open(zip, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, opened) => {
      if (error || !opened) {
        fail(new Error(`无法打开 ZIP 引擎包：${error?.message ?? '未知错误'}`))
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
          const name = entry.fileName.replace(/\\/g, '/')
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff
          if (
            !name ||
            name.startsWith('/') ||
            name.split('/').some((part) => part === '..' || part === '.' || part.includes(':')) ||
            (mode & 0xf000) === 0xa000
          ) {
            fail(new Error(`ZIP 引擎包包含不安全路径：${entry.fileName}`))
            return
          }
          const target = resolve(root, ...name.split('/'))
          const relative = target.slice(root.length)
          if (target !== root && (!relative.startsWith(sep) || !isInside(root, target))) {
            fail(new Error(`ZIP 引擎包路径越界：${entry.fileName}`))
            return
          }
          if (entry.fileName.endsWith('/') || (mode & 0xf000) === 0x4000) {
            mkdirSync(target, { recursive: true })
            opened.readEntry()
            return
          }
          mkdirSync(dirname(target), { recursive: true })
          opened.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(new Error(`无法读取 ZIP 文件 ${entry.fileName}：${streamError?.message ?? '未知错误'}`))
              return
            }
            const output = createWriteStream(target, { flags: 'wx' })
            void pipeline(stream, output).then(
              () => opened.readEntry(),
              (pipelineError: unknown) =>
                fail(new Error(`ZIP 解压失败 ${entry.fileName}：${pipelineError instanceof Error ? pipelineError.message : String(pipelineError)}`)),
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

/** ZIP local-file-header signature "PK\x03\x04". */
function isZipFile(file: string): boolean {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && head.readUInt32LE(0) === 0x04034b50
  } finally {
    closeSync(fd)
  }
}

async function extractArchive(archive: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true })
  // Release downloads are saved as `<stamp>.download`, so the name does not say
  // whether this is the Windows .zip or the Linux .tar.gz: check the content.
  if (archive.endsWith('.zip') || isZipFile(archive)) {
    await extractZip(archive, dest)
    return
  }
  const result = await run('tar', ['-xf', archive, '-C', dest], { timeoutMs: 300_000 })
  if (result.code !== 0) throw new Error(`引擎包解压失败：${result.stderr.slice(0, 300) || '系统 tar 执行失败'}`)
}

function singleTopDir(dir: string): string {
  const entries = readdirSync(dir, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0]!.isDirectory()) {
    throw new Error(`引擎包结构不符合预期（${dir} 下应有单一顶层目录）`)
  }
  return join(dir, entries[0]!.name)
}


async function stageTree(
  extractedRoot: string,
  stamp: string,
  kind: EnginePackageKind,
): Promise<{ binaryPath: string; stagingDir: string }> {
  const top = singleTopDir(extractedRoot)
  const stagingRoot = join(paths.mossinfer(), '.staging')
  const stagingDir = join(stagingRoot, `${stamp}-${Date.now()}`)
  mkdirSync(stagingRoot, { recursive: true })
  try {
    await rename(top, stagingDir)
    const binaryPath = engineBinaryPath(stagingDir, kind)
    if (!existsSync(binaryPath)) throw new Error(`引擎包里没有 ${binaryPath}`)
    if (process.platform !== 'win32') chmodSync(binaryPath, 0o755)
    return { binaryPath, stagingDir }
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* Releases                                                            */
/* ------------------------------------------------------------------ */

interface GhRelease {
  tag_name: string
  name?: string
  body?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
  assets: GhAsset[]
}

/** One release with everything an install needs: asset URLs and the SHA256SUMS text. */
export interface EngineRelease {
  tag: string
  /** `2.2.0` */
  version: string
  /** `sha256`: GitHub's own digest of the asset, when the API gives one. */
  assets: Array<{ name: string; size: number; url: string; sha256?: string }>
  /** Contents of SHA256SUMS; null when the release has none. */
  sums: string | null
}

class MissingReleaseAssetError extends Error {}

/** A release plus whether the person asked for this exact tag (then a missing asset is an error, not a CI fallback). */
type ReleaseContext = EngineRelease & { pinned?: boolean }

export async function listMossInferReleases(): Promise<MossInferRelease[]> {
  const settings = getSettings()
  const releases = (await ghJson('/releases?per_page=20', resolveGithubToken(settings))) as GhRelease[]
  return releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({
      tag: release.tag_name,
      name: release.name?.trim() || release.tag_name,
      publishedAt: release.published_at ?? null,
      body: release.body ?? '',
      assets: release.assets.map(({ name, size }) => ({ name, size })),
    }))
}

/** The latest release (or a given tag), with its SHA256SUMS. */
export async function fetchEngineRelease(releaseTag?: string): Promise<EngineRelease> {
  const settings = getSettings()
  const release = (await ghJson(
    releaseTag ? `/releases/tags/${encodeURIComponent(releaseTag)}` : '/releases/latest',
    resolveGithubToken(settings),
  )) as GhRelease
  const sumsAsset = release.assets.find((item) => item.name === 'SHA256SUMS')
  // The hashes never come through a mirror (a mirror could swap archive and hash together):
  // GitHub's own per-asset digest from api.github.com, else SHA256SUMS straight from github.com.
  const everyDigest = release.assets.filter((item) => item.name !== 'SHA256SUMS').every((item) => digestOf(item))
  let sums: string | null = null
  if (sumsAsset && !everyDigest) {
    const signal = controller
      ? AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000)
    let response: Response
    try {
      response = await fetch(sumsAsset.browser_download_url, { headers: { 'user-agent': `MossStudio-Launcher/${app.getVersion()}` }, signal })
    } catch (error) {
      if (controller?.signal.aborted) throw new Error('已取消下载')
      throw new Error(`无法从 github.com 读取 SHA256SUMS（校验值不经过镜像）：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`无法从 github.com 读取 SHA256SUMS：HTTP ${response.status}`)
    sums = await response.text()
  }
  return {
    tag: release.tag_name,
    version: releaseAssetVersion(release.tag_name, release.assets.map((item) => item.name)),
    assets: release.assets.map((item) => ({
      name: item.name, size: item.size, url: item.browser_download_url,
      ...(digestOf(item) ? { sha256: digestOf(item)! } : {}),
    })),
    sums,
  }
}

function digestOf(asset: GhAsset): string | null {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '')
  return match ? match[1]!.toLowerCase() : null
}

/** The SHA-256 SHA256SUMS lists for this asset; every release download is checked against it. */
function expectedSha(release: EngineRelease, name: string): string {
  const expected = release.assets.find((asset) => asset.name === name)?.sha256 ?? (release.sums ? sha256Of(release.sums, name) : null)
  if (!expected) {
    throw new Error(`release ${release.tag} 的 SHA256SUMS 里没有 ${name}，无法校验，未安装`)
  }
  return expected
}

/* ------------------------------------------------------------------ */
/* Vulkan probe package                                                */
/* ------------------------------------------------------------------ */

let probeInFlight: Promise<string> | null = null

/**
 * A moss-infer-vulkan to run `--list-devices` with: an installed Vulkan
 * package, or the release's 1–2 MB Vulkan package unpacked under
 * `<engine root>/.probe/<tag>` (cached per release, SHA-256 checked).
 */
export async function ensureVulkanProbe(release: EngineRelease): Promise<string> {
  const name = engineAssetName(release.version, osToken(), { kind: 'vulkan' })
  const probeRoot = join(paths.mossinfer(), '.probe')
  const dir = join(probeRoot, release.tag)
  const binary = engineBinaryPath(dir, 'vulkan')
  if (existsSync(binary)) return binary
  if (probeInFlight) return probeInFlight
  probeInFlight = (async () => {
    const asset = release.assets.find((item) => item.name === name)
    if (!asset) throw new MissingReleaseAssetError(`release ${release.tag} 里没有 ${name}`)
    const expected = expectedSha(release, name)
    mkdirSync(probeRoot, { recursive: true })
    const download = join(probeRoot, `${release.tag}.download`)
    const extract = join(probeRoot, `${release.tag}-extract`)
    try {
      const digest = await downloadTo(asset.url, download, null, asset.size, getSettings(), () => undefined)
      if (digest !== expected) throw new Error('Vulkan 探测包 sha256 校验失败（SHA256SUMS 不匹配）')
      rmSync(extract, { recursive: true, force: true })
      await extractArchive(download, extract)
      rmSync(dir, { recursive: true, force: true })
      await rename(singleTopDir(extract), dir)
      if (!existsSync(binary)) throw new Error(`Vulkan 探测包里没有 ${binary}`)
      if (process.platform !== 'win32') chmodSync(binary, 0o755)
      // Only the newest release's probe is kept.
      for (const entry of readdirSync(probeRoot)) if (entry !== release.tag) rmSync(join(probeRoot, entry), { recursive: true, force: true })
      return binary
    } finally {
      rmSync(download, { force: true })
      rmSync(`${download}.part`, { force: true })
      rmSync(`${download}.part.json`, { force: true })
      rmSync(extract, { recursive: true, force: true })
    }
  })()
  try {
    return await probeInFlight
  } finally {
    probeInFlight = null
  }
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

interface Source {
  url: string
  token: string | null
  totalHint: number
  /** null for a CI artifact: the inner archive's .sha256 is checked after the outer zip is extracted. */
  expectedSha: string | null
  stamp: string
  label: string
  /** The package that will land (a CUDA runtime variant may fall back to the other one). */
  package: EnginePackage
  fallbackNote?: string
}

function otherRuntime(pkg: EnginePackage): EnginePackage | null {
  if (pkg.kind !== 'cuda') return null
  return { ...pkg, runtime: pkg.runtime === 'system-cuda' ? 'bundled' : 'system-cuda' }
}

function stableSource(pkg: EnginePackage, release: EngineRelease): Source {
  if (!packageExistsFor(pkg, osToken())) {
    throw new Error(`上游没有 ${osToken() === 'windows' ? 'Windows' : 'Linux'} 版的 ${enginePackageOptionLabel(pkg)} 引擎包`)
  }
  const pick = (candidate: EnginePackage) => release.assets.find((item) => item.name === engineAssetName(release.version, osToken(), candidate))
  let effective = pkg
  let asset = pick(pkg)
  let fallbackNote: string | undefined
  const other = otherRuntime(pkg)
  if (!asset && other) {
    asset = pick(other)
    if (asset) {
      effective = other
      fallbackNote = `该 release 没有 ${pkg.kind === 'cuda' ? pkg.runtime : ''} 变体，已回退到 ${other.kind === 'cuda' ? other.runtime : ''} 包`
    }
  }
  if (!asset) {
    throw new MissingReleaseAssetError(
      `release ${release.tag} 里没有 ${engineAssetName(release.version, osToken(), pkg)}` +
        (release.assets.length ? `（现有资产：${release.assets.map((a) => a.name).slice(0, 6).join(', ')}…）` : '（该 release 还没有资产）'),
    )
  }
  return {
    url: asset.url,
    token: null,
    totalHint: asset.size,
    expectedSha: expectedSha(release, asset.name),
    stamp: engineStampName('stable', release.tag, effective),
    label: `release ${release.tag}`,
    package: effective,
    fallbackNote,
  }
}

/** CI artifact names: mossinfer-<linux|windows-msvc>-<cuda13|cuda12|cuda13-sm75|cuda12-sm70>, mossinfer-vulkan-<os>, mossinfer-hip-linux. */
function devArtifactName(pkg: EnginePackage): string {
  if (pkg.kind === 'vulkan') return `mossinfer-vulkan-${osToken()}`
  if (pkg.kind === 'hip') return 'mossinfer-hip-linux'
  const platform = process.platform === 'win32' ? 'windows-msvc' : 'linux'
  return `mossinfer-${platform}-${pkg.flavour === 'cu13' ? 'cuda13' : 'cuda12'}${pkg.arch === 'standard' ? '' : `-${pkg.arch}`}`
}

/** The archive inside a CI artifact for this package, any version. */
function devInnerArchive(pkg: EnginePackage): RegExp {
  const ext = archiveExt().replace('.', '\\.')
  const name = engineAssetName('VERSION', osToken(), pkg).replace(/\./g, '\\.').replace('VERSION', '[^-]+')
  return new RegExp(`^${name.replace(/\\\.(zip|tar\\\.gz)$/, '')}\\.${ext}$`)
}

async function devSource(pkg: EnginePackage, settings: Settings): Promise<Source> {
  if (!packageExistsFor(pkg, osToken())) {
    throw new Error(`上游 CI 没有 ${osToken() === 'windows' ? 'Windows' : 'Linux'} 版的 ${enginePackageOptionLabel(pkg)} 构建`)
  }
  const token = resolveGithubToken(settings)
  if (!token) {
    throw new Error(
      'GitHub Actions 构件下载需要 token（public 仓库也一样）：请设置 githubToken，或配置 GH_TOKEN 环境变量 / gh CLI 登录',
    )
  }
  const runs = (await ghJson('/actions/runs?branch=main&status=success&per_page=1&name=ci', token)) as {
    workflow_runs: Array<{ id: number; head_sha: string }>
  }
  const runInfo = runs.workflow_runs[0]
  if (!runInfo) throw new Error('main 分支上还没有成功的 ci 运行')
  const artifacts = (await ghJson(`/actions/runs/${runInfo.id}/artifacts`, token)) as { artifacts: GhArtifact[] }
  const name = devArtifactName(pkg)
  const artifact = artifacts.artifacts.find((item) => item.name === name)
  if (!artifact) throw new Error(`ci 运行 ${runInfo.id} 里没有构件 ${name}`)
  if (artifact.expired) throw new Error(`构件 ${name} 已过期（CI 保留 7 天）`)
  const tag = `run${runInfo.id}-${runInfo.head_sha.slice(0, 8)}`
  return {
    url: `${API}/actions/artifacts/${artifact.id}/zip`,
    token,
    totalHint: artifact.size_in_bytes,
    expectedSha: null,
    stamp: engineStampName('dev', tag, pkg),
    label: `ci run ${runInfo.id}（${runInfo.head_sha.slice(0, 8)}）`,
    package: pkg, // final choice made after the outer zip is extracted
  }
}

/* ------------------------------------------------------------------ */
/* Install one package                                                 */
/* ------------------------------------------------------------------ */

interface StagedPackage {
  binaryPath: string
  stagingDir: string
  stamp: string
  package: EnginePackage
  label: string
  fallbackNote?: string
}

async function downloadAndStage(
  channel: 'stable' | 'dev',
  pkg: EnginePackage,
  settings: Settings,
  release: ReleaseContext | null,
  cudaWheels: boolean,
): Promise<StagedPackage> {
  await recoverEngineInstall(paths.mossinfer())
  let effectiveChannel = channel
  let source: Source
  if (channel === 'stable' && release) {
    try {
      source = stableSource(pkg, release)
    } catch (error) {
      if (!(error instanceof MissingReleaseAssetError) || release.pinned) throw error
      publish({ phase: 'querying', version: '上游没有 Release，回退到最新 CI artifact' })
      effectiveChannel = 'dev'
      source = await devSource(pkg, settings)
    }
  } else {
    if (channel === 'stable') publish({ phase: 'querying', version: '上游没有 Release，回退到最新 CI artifact' })
    effectiveChannel = 'dev'
    source = await devSource(pkg, settings)
  }
  if (controller?.signal.aborted) throw new Error('已取消下载')
  publish({ phase: 'downloading', version: source.label, bytes: 0, totalBytes: source.totalHint })
  const workDir = join(paths.mossinfer(), 'downloads')
  mkdirSync(workDir, { recursive: true })
  const downloadPath = join(workDir, `${source.stamp}.download`)
  const digest = await downloadTo(source.url, downloadPath, source.token, source.totalHint, settings)

  publish({ phase: 'verifying', bytes: source.totalHint, percent: 100 })
  let archivePath = downloadPath
  let effective = source.package
  let fallbackNote = source.fallbackNote
  if (effectiveChannel === 'dev') {
    publish({ phase: 'extracting', percent: 0 })
    // The artifact is an outer zip wrapping the CPack archives + their .sha256 files.
    const outerDir = join(workDir, `${source.stamp}-outer`)
    rmSync(outerDir, { recursive: true, force: true })
    await extractZip(downloadPath, outerDir)
    rmSync(downloadPath, { force: true }) // the artifact zip is no longer needed
    const names = readdirSync(outerDir)
    const find = (candidate: EnginePackage): string | undefined => names.find((name) => devInnerArchive(candidate).test(name))
    let wanted = find(pkg)
    const other = otherRuntime(pkg)
    if (!wanted && other && (wanted = find(other))) {
      effective = other
      fallbackNote = `该 CI 构件没有 ${pkg.kind === 'cuda' ? pkg.runtime : ''} 变体，已回退到 ${other.kind === 'cuda' ? other.runtime : ''} 包`
    }
    if (!wanted) throw new Error('构件 zip 里没有找到引擎归档')
    source.stamp = engineStampName('dev', parseEngineStamp(source.stamp)?.tag ?? 'run', effective)
    archivePath = join(outerDir, wanted)
    const shaFile = names.find((name) => name === `${wanted}.sha256`)
    if (!shaFile) throw new Error(`构件里没有 ${wanted}.sha256，无法校验，未安装`)
    const expected = readFileSync(join(outerDir, shaFile), 'utf8').trim().split(/\s+/)[0]
    const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
    if (!expected || actual !== expected) throw new Error(`引擎归档 sha256 校验失败（${wanted}）`)
  } else if (digest !== source.expectedSha) {
    rmSync(downloadPath, { force: true })
    throw new Error('引擎包 sha256 校验失败（SHA256SUMS 不匹配）')
  }

  publish({ phase: 'extracting', percent: 0 })
  const extractDir = join(workDir, `${source.stamp}-extract`)
  rmSync(extractDir, { recursive: true, force: true })
  await extractArchive(archivePath, extractDir)
  const { binaryPath, stagingDir } = await stageTree(extractDir, source.stamp, effective.kind)
  try {
    rmSync(archivePath, { force: true })
    if (effective.kind === 'cuda' && effective.runtime === 'system-cuda' && cudaWheels) {
      publish({ phase: 'cuda_libs' })
      await installCudaWheels(stagingDir, effective.flavour)
    }
    rmSync(workDir, { recursive: true, force: true })
    return { binaryPath, stagingDir, stamp: source.stamp, package: effective, label: source.label, fallbackNote }
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw error
  }
}

/** A NVIDIA GPU this CUDA package is meant for, to check the build against. */
function verificationGpu(devices: GpuInventoryDevice[], gpuIds: string[] | undefined): GpuInventoryDevice | undefined {
  const nvidia = devices.filter((device) => (device.vendor ?? 'nvidia') === 'nvidia')
  return nvidia.find((device) => gpuIds?.includes(device.uuid)) ?? (gpuIds?.length ? undefined : nvidia[0])
}

/** Checks a staged build before it may replace anything; returns notes for the done state. */
async function verifyStaged(
  staged: StagedPackage,
  gpuIds: string[] | undefined,
  env: Record<string, string> | undefined,
): Promise<{ notes: string[]; recommendedFlavour?: string; cublaslt?: unknown }> {
  const pkg = staged.package
  if (pkg.kind !== 'cuda') {
    // The CLIs answer --version without a GPU; a missing runtime library (ROCm) fails here.
    const result = await run(staged.binaryPath, ['--version'], { timeoutMs: 20_000, env })
    if (result.code !== 0) {
      throw new Error(`${enginePackageOptionLabel(pkg)} 引擎无法启动（退出码 ${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 300)}；未激活该构建`)
    }
    return { notes: [] }
  }
  const probe = await probeEngine(staged.binaryPath)
  if (!protocolCompatible(probe)) {
    throw new Error(`新引擎协议为 ${probe.protocol}，需要 protocol 2；未激活该构建`)
  }
  const notes: string[] = []
  const recommended = probe.probe?.recommendedFlavour ?? ''
  if (recommended && recommended !== pkg.flavour) {
    notes.push(`引擎建议 CUDA ${recommended.slice(2)}，当前安装的是 CUDA ${pkg.flavour.slice(2)}；请按 GPU 兼容性结果更新驱动`)
  }
  const inventory = await refreshGpuInventory()
  const target = verificationGpu(inventory.devices, gpuIds)
  if (!target) throw new Error('没有可用于验证新引擎的 NVIDIA GPU；未激活该构建')
  const verdict = judgeEngineSupport(
    probe,
    { index: target.index, name: target.name },
    { expectedArchitecture: pkg.arch, inventoryCapability: target.computeCapability },
  )
  notes.push(...verdict.warnings)
  if (!verdict.ok) {
    const os = osToken()
    const driver = target.driverVersion && !driverSupports(pkg.flavour, os, target.driverVersion)
      ? `当前 NVIDIA 驱动为 ${target.driverVersion}，CUDA ${pkg.flavour.slice(2)} 引擎需要 ${driverMinimumLabel(pkg.flavour, os)} 或更新版本。`
      : null
    throw new Error(
      [driver, verdict.reason, `新引擎未能验证 ${target.name} 对 ${enginePackageOptionLabel(pkg)} 构建的支持；未激活该构建并保留当前引擎。`]
        .filter(Boolean).join(' '),
    )
  }
  return { notes, recommendedFlavour: recommended, cublaslt: probe.probe?.cublasLt }
}

/* ------------------------------------------------------------------ */
/* Public entry                                                        */
/* ------------------------------------------------------------------ */

export interface EngineDownloadRequest {
  channel: 'stable' | 'dev'
  /** Packages to install, each side by side with the others. */
  packages: EnginePackage[]
  releaseTag?: string
  /** The release, when the caller already fetched it (the plan does). */
  release?: EngineRelease | null
  /** Download the NVIDIA CUDA runtime next to a system-CUDA package. */
  cudaWheels?: boolean
  /** packageId → the GPUs it is for, to verify CUDA builds against the right card. */
  targets?: Record<string, string[]>
  /** Extra environment per package kind for the --version check (HIP: LD_LIBRARY_PATH). */
  env?: Partial<Record<EnginePackageKind, Record<string, string>>>
  /** Background updates pass a gate so a new build is only activated while no job runs. */
  activation?: Omit<ActivationGate, 'signal'>
  /** Shown while querying, e.g. what the plan detected. */
  note?: string
}

export async function downloadMossInfer(request: EngineDownloadRequest): Promise<MossInferDownloadState> {
  if (operationInProgress && current) return current
  if (current && !['done', 'error', 'canceled'].includes(current.phase)) return current
  const { channel, releaseTag, activation } = request
  const settings = getSettings()
  const operationController = new AbortController()
  controller = operationController
  operationInProgress = true
  const packageIds = request.packages.map(enginePackageId)
  current = {
    channel,
    phase: 'querying',
    releaseTag,
    bytes: 0,
    totalBytes: 0,
    percent: 0,
    speedBps: 0,
    packages: packageIds,
    updatedAt: new Date().toISOString(),
  }
  publish({ phase: 'querying', ...(request.note ? { note: request.note } : {}) })
  let pendingStagingDir: string | undefined
  const installed: string[] = []
  const landed: EnginePackage[] = []
  const notes: string[] = []
  let lastBinary: string | undefined
  let recommendedFlavour: string | undefined
  let cublaslt: unknown
  try {
    if (request.packages.length === 0) throw new Error('没有需要安装的引擎包')
    let release: EngineRelease | null = request.release ?? null
    if (channel === 'stable' && !release) {
      try {
        release = await fetchEngineRelease(releaseTag)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (releaseTag || !/\/releases\/latest 返回 HTTP 404|Not Found/i.test(message)) throw error
        release = null
      }
    }
    const pinnedRelease: ReleaseContext | null = release ? { ...release, pinned: Boolean(releaseTag) } : null
    for (const [index, pkg] of request.packages.entries()) {
      const id = enginePackageId(pkg)
      publish({ phase: 'querying', step: { index, count: request.packages.length, packageId: id }, bytes: 0, totalBytes: 0, percent: 0 })
      const staged = await downloadAndStage(channel, pkg, settings, pinnedRelease, request.cudaWheels === true)
      pendingStagingDir = staged.stagingDir
      const verified = await verifyStaged(staged, request.targets?.[id], request.env?.[staged.package.kind])
      notes.push(...[staged.fallbackNote, ...verified.notes].filter((note): note is string => Boolean(note)))
      if (verified.recommendedFlavour) recommendedFlavour = verified.recommendedFlavour
      if (verified.cublaslt !== undefined) cublaslt = verified.cublaslt
      // Activation restarts the engine: run it under the activation lock so new
      // jobs wait for it, and (for background updates) only while no job runs.
      const binaryPath = await activateWhenAllowed(async () => {
        const installDir = join(paths.mossinfer(), staged.stamp)
        const inPlace = engineBinaryPath(installDir, staged.package.kind)
        const promotion = await promoteInstall({
          root: paths.mossinfer(),
          stagingDir: staged.stagingDir,
          stamp: staged.stamp,
          currentServerPath: existsSync(inPlace) ? inPlace : null,
          // Replacing an install that is running: stop its processes first (moss-server, or the Vulkan / HIP CLI jobs).
          // Only the CLI jobs that run the install being replaced.
          beforeReplace: staged.package.kind === 'cuda'
            ? shutdownMossInfer
            : () => shutdownCliEngines({ kind: staged.package.kind as 'vulkan' | 'hip', binary: installDir }),
        })
        pendingStagingDir = undefined
        const promotedPath = engineBinaryPath(promotion.installDir, staged.package.kind)
        if (staged.package.kind === 'cuda') {
          // Each GPU now runs the newest install of its own package: a pin to one moss-server is released.
          const update = updateSettings({ mossInferServerPath: null, mossInferChannel: channel })
          emit(Events.settingsChanged, update)
          await shutdownMossInfer() // 激活其他版本后，下一次任务也不能复用旧二进制 runtime。
        } else if (getSettings().mossInferChannel !== channel) {
          emit(Events.settingsChanged, updateSettings({ mossInferChannel: channel }))
        }
        await cleanupPromotedInstall(promotion)
        return promotedPath
      }, activation ? {
        ...activation,
        signal: operationController.signal,
        onWaiting: () => {
          publish({ phase: 'verifying', note: '新版本已准备好，等正在运行的任务结束后切换' })
          activation.onWaiting?.()
        },
      } : undefined)
      installed.push(enginePackageId(staged.package))
      landed.push(staged.package)
      lastBinary = binaryPath
      if (staged.package.kind === 'cuda' || !current.serverPath) current = { ...current, serverPath: binaryPath }
    }
    const lastCuda = [...landed].reverse().find((pkg): pkg is Extract<EnginePackage, { kind: 'cuda' }> => pkg.kind === 'cuda')
    publish({
      phase: 'done',
      percent: 100,
      serverPath: current.serverPath ?? lastBinary,
      packages: installed,
      ...(recommendedFlavour ? { recommendedFlavour } : {}),
      ...(lastCuda ? { variant: lastCuda.runtime, architecture: lastCuda.arch } : {}),
      note: notes.join('；') || undefined,
      cublaslt,
    })
  } catch (error) {
    if (pendingStagingDir) {
      rmSync(pendingStagingDir, { recursive: true, force: true })
      pendingStagingDir = undefined
    }
    publish({
      phase: operationController.signal.aborted ? 'canceled' : 'error',
      ...(installed.length ? { packages: installed } : {}),
      error: operationController.signal.aborted ? undefined : error instanceof Error ? error.message : String(error),
    })
  } finally {
    operationInProgress = false
    if (controller === operationController) controller = null
    // A GPU that now runs another package (e.g. its new Vulkan install) frees its old moss-server's memory now.
    if (installed.length) void releaseStaleMossInferRuntimes().catch(() => undefined)
  }
  return current
}
