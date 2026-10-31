import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, chmodSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { open, rename } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, join, resolve, sep } from 'node:path'
import * as yauzl from 'yauzl'
import type { MossInferDownloadState, MossInferRelease, Settings } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { isInside, paths } from '../lib/paths'
import { run } from '../lib/run'
import { probeMossInfer, shutdownMossInfer } from './mossInfer'
import { installCudaWheels } from './cudaWheels'
import { getSettings, updateSettings } from './settings'
import { getLastNetwork, githubMirrorChain } from './network'

/**
 * Downloads the MossInfer engine package from the upstream repo xycld/owoinfer:
 * - stable: the latest GitHub Release assets (sha256-verified via SHA256SUMS);
 * - dev: the latest successful `ci` run's Actions artifact (requires a token: GitHub
 *   answers 401 on artifact zips even for public repos).
 * The extracted tree keeps its upstream layout (bin/moss-server + lib/), and the
 * installed server path is written to settings.mossInferServerPath.
 */

const REPO = 'xycld/owoinfer'
const API = `https://api.github.com/repos/${REPO}`

let current: MossInferDownloadState | null = null
let controller: AbortController | null = null
let operationInProgress = false

function publish(patch: Partial<MossInferDownloadState> & { phase: MossInferDownloadState['phase'] }): void {
  if (!current) return
  current = { ...current, ...patch, updatedAt: new Date().toISOString() }
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

function hostLabel(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '镜像 URL'
  }
}

async function fetchGithubFile(
  url: string,
  settings: Settings,
  init: RequestInit,
  description: string,
): Promise<Response> {
  // A cached "direct works" probe result must not disable mirrors. Order: an explicitly
  // configured mirror first, otherwise direct first and the built-ins only as fallback,
  // so a dead mirror costs one failed attempt instead of stalling every download.
  const preferred = settings.gitMirror?.trim() || getLastNetwork()?.selected.git || null
  // gh-proxy family takes the full absolute URL after the prefix; a bare prefix would not
  // resolve, so build it here instead of reusing the git-clone mirror helper.
  const mirrored = githubMirrorChain(settings).map((mirror) => `${mirror.replace(/\/$/, '')}/${url}`)
  const candidates = isGithubFileUrl(url)
    ? [...new Set(preferred ? [...mirrored, url] : [url, ...mirrored])]
    : [url]
  const failures: string[] = []
  for (const candidate of candidates) {
    let response: Response
    try {
      response = await fetch(candidate, init)
    } catch (error) {
      if (controller?.signal.aborted) throw new Error('已取消下载')
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${hostLabel(candidate)}: ${reason}`)
      continue
    }
    if (response.ok) return response
    failures.push(`${hostLabel(candidate)}: HTTP ${response.status}`)
    await response.body?.cancel()
  }
  const hint = settings.networkMode === 'direct'
    ? '当前网络策略是「直连」，请在设置里切到「自动」或填一个 git 镜像前缀。'
    : '直连与内置镜像都失败了：请检查网络，或在设置 › 网络与下载里填写可用的 git 镜像前缀。'
  throw new Error(`${description}请求失败：${failures.join('；')}。${hint}`)
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
}

interface GhArtifact {
  id: number
  name: string
  expired: boolean
  size_in_bytes: number
}

// Archive names: mossinfer-<version>-<os>-cu<N>-x86_64[-system-cuda].<ext>
function osToken(): 'linux' | 'windows' {
  return process.platform === 'win32' ? 'windows' : 'linux'
}

function archiveExt(): 'tar.gz' | 'zip' {
  return process.platform === 'win32' ? 'zip' : 'tar.gz'
}

type Variant = 'system-cuda' | 'bundled'

function archiveBase(version: string, flavour: 'cu12' | 'cu13', variant: Variant): string {
  const suffix = variant === 'system-cuda' ? '-system-cuda' : ''
  return `mossinfer-${version}-${osToken()}-${flavour}-x86_64${suffix}`
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
    publishProgress(written, total, resumed ? `从 ${(written / 1024 / 1024).toFixed(1)} MB 继续` : '开始下载')

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
              publishProgress(written, total)
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

async function extractArchive(archive: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true })
  if (archive.endsWith('.zip')) {
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

async function installTree(
  extractedRoot: string,
  stamp: string,
): Promise<{ serverPath: string; installDir: string }> {
  const top = singleTopDir(extractedRoot)
  const installDir = join(paths.mossinfer(), stamp)
  rmSync(installDir, { recursive: true, force: true })
  mkdirSync(paths.mossinfer(), { recursive: true })
  await rename(top, installDir)
  const serverPath = join(
    installDir,
    'bin',
    process.platform === 'win32' ? 'moss-server.exe' : 'moss-server',
  )
  if (!existsSync(serverPath)) throw new Error(`引擎包里没有 ${serverPath}`)
  if (process.platform !== 'win32') chmodSync(serverPath, 0o755)
  return { serverPath, installDir }
}

/**
 * The system-cuda package variant ships no CUDA libraries; the engine dlopens
 * libcublasLt.so.<major> by soname, and the executable's RUNPATH ($ORIGIN/../lib)
 * is on that search path — so installing the NVIDIA PyPI wheels' libraries into
 * the package's own lib/ satisfies it without root or system-wide changes.
 */
interface Source {
  url: string
  token: string | null
  totalHint: number
  expectedSha: string | null // null = verify after download from a bundled .sha256 (dev artifact)
  stamp: string
  label: string
  effectiveVariant: Variant
  fallbackNote?: string
}

interface GhRelease {
  tag_name: string
  name?: string
  body?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
  assets: GhAsset[]
}

class MissingReleaseAssetError extends Error {}

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

async function queryStable(
  flavour: 'cu12' | 'cu13',
  variant: Variant,
  settings: Settings,
  releaseTag?: string,
): Promise<Source> {
  const release = (await ghJson(
    releaseTag ? `/releases/tags/${encodeURIComponent(releaseTag)}` : '/releases/latest',
    resolveGithubToken(settings),
  )) as {
    tag_name: string
    assets: GhAsset[]
  }
  const version = release.tag_name.replace(/^v/, '')
  const pick = (v: Variant): GhAsset | undefined =>
    release.assets.find((item) => item.name === `${archiveBase(version, flavour, v)}.${archiveExt()}`)
  let effectiveVariant = variant
  let asset = pick(variant)
  let fallbackNote: string | undefined
  if (!asset) {
    const other: Variant = variant === 'system-cuda' ? 'bundled' : 'system-cuda'
    asset = pick(other)
    if (asset) {
      effectiveVariant = other
      fallbackNote = `该 release 没有 ${variant} 变体，已回退到 ${other} 包`
    }
  }
  if (!asset) {
    throw new MissingReleaseAssetError(
      `release ${release.tag_name} 里没有 ${archiveBase(version, flavour, variant)}.${archiveExt()}` +
        (release.assets.length ? `（现有资产：${release.assets.map((a) => a.name).slice(0, 6).join(', ')}…）` : '（该 release 还没有资产）'),
    )
  }
  const name = asset.name
  const sumsAsset = release.assets.find((item) => item.name === 'SHA256SUMS')
  let expected: string | null = null
  if (sumsAsset) {
    const signal = controller
      ? AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000)
    const response = await fetchGithubFile(
      sumsAsset.browser_download_url,
      settings,
      { signal },
      'Release SHA256SUMS 校验文件',
    )
    expected = sha256Of(await response.text(), name)
  }
  return {
    url: asset.browser_download_url,
    token: null,
    totalHint: asset.size,
    expectedSha: expected,
    stamp: `stable-${release.tag_name}-${flavour}${effectiveVariant === 'system-cuda' ? '-system-cuda' : ''}`,
    label: `release ${release.tag_name}`,
    effectiveVariant,
    fallbackNote,
  }
}

async function queryDev(flavour: 'cu12' | 'cu13', variant: Variant, settings: Settings): Promise<Source> {
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
  const artifacts = (await ghJson(`/actions/runs/${runInfo.id}/artifacts`, token)) as {
    artifacts: GhArtifact[]
  }
  const name = `mossinfer-${process.platform === 'win32' ? 'windows-msvc' : 'linux'}-${flavour === 'cu13' ? 'cuda13' : 'cuda12'}`
  const artifact = artifacts.artifacts.find((item) => item.name === name)
  if (!artifact) throw new Error(`ci 运行 ${runInfo.id} 里没有构件 ${name}`)
  if (artifact.expired) throw new Error(`构件 ${name} 已过期（CI 保留 7 天）`)
  return {
    url: `${API}/actions/artifacts/${artifact.id}/zip`,
    token,
    totalHint: artifact.size_in_bytes,
    expectedSha: null,
    stamp: `dev-run${runInfo.id}-${runInfo.head_sha.slice(0, 8)}-${flavour}${variant === 'system-cuda' ? '-system-cuda' : ''}`,
    label: `ci run ${runInfo.id}（${runInfo.head_sha.slice(0, 8)}）`,
    effectiveVariant: variant, // final choice made after the outer zip is extracted
  }
}

async function downloadAndInstall(
  channel: 'stable' | 'dev',
  flavour: 'cu12' | 'cu13',
  variant: Variant,
  settings: Settings,
  cudaWheels = false,
  releaseTag?: string,
): Promise<{ serverPath: string; stamp: string; effectiveVariant: Variant; fallbackNote?: string }> {
  let effectiveChannel: 'stable' | 'dev' = channel
  let source: Source
  if (channel === 'stable') {
    try {
      source = await queryStable(flavour, variant, settings, releaseTag)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const noLatestRelease = !releaseTag && /\/releases\/latest 返回 HTTP 404|Not Found/i.test(message)
      const noMatchingAsset = error instanceof MissingReleaseAssetError
      if (releaseTag || (!noLatestRelease && !noMatchingAsset)) throw error
      publish({ phase: 'querying', version: '上游没有 Release，回退到最新 CI artifact' })
      effectiveChannel = 'dev'
      source = await queryDev(flavour, variant, settings)
    }
  } else {
    source = await queryDev(flavour, variant, settings)
  }
  if (controller?.signal.aborted) throw new Error('已取消下载')
  publish({ phase: 'downloading', version: source.label, bytes: 0, totalBytes: source.totalHint })
  const workDir = join(paths.mossinfer(), 'downloads')
  mkdirSync(workDir, { recursive: true })
  const downloadPath = join(workDir, `${source.stamp}.download`)
  const digest = await downloadTo(source.url, downloadPath, source.token, source.totalHint, settings)

  publish({ phase: 'verifying', bytes: source.totalHint, percent: 100 })
  let archivePath = downloadPath
  let effectiveVariant = source.effectiveVariant
  let fallbackNote = source.fallbackNote
  if (effectiveChannel === 'dev') {
    publish({ phase: 'extracting', percent: 0 })
    // The artifact is an outer zip wrapping the CPack archives + their .sha256 files.
    // Older CI runs predate the system-cuda variant: fall back to the bundled archive
    // from the same artifact (no second download).
    const outerDir = join(workDir, `${source.stamp}-outer`)
    rmSync(outerDir, { recursive: true, force: true })
    await extractZip(downloadPath, outerDir)
    rmSync(downloadPath, { force: true }) // the 800 MB artifact zip is no longer needed
    const pick = (wantSystemCuda: boolean): string | undefined =>
      readdirSync(outerDir).find(
        (name) =>
          name.endsWith(`.${archiveExt()}`) &&
          name.startsWith('mossinfer-') &&
          name.includes(`-${flavour}-`) &&
          (wantSystemCuda ? name.includes('-system-cuda') : !name.includes('-system-cuda')),
      )
    const wanted =
      source.effectiveVariant === 'system-cuda'
        ? (pick(true) ?? pick(false))
        : pick(false)
    if (!wanted) throw new Error('构件 zip 里没有找到引擎归档')
    if (!wanted.includes('-system-cuda') && source.effectiveVariant === 'system-cuda') {
      effectiveVariant = 'bundled'
      fallbackNote = '该 CI 构件没有 system-cuda 变体（上游 workflow 更新前的运行），已回退到完整包'
    }
    // keep the install dir name honest about what actually landed
    source.stamp = `${source.stamp.replace(/-system-cuda$/, '')}${effectiveVariant === 'system-cuda' ? '-system-cuda' : ''}`
    archivePath = join(outerDir, wanted)
    const shaFile = readdirSync(outerDir).find((name) => name === `${wanted}.sha256`)
    if (shaFile) {
      const expected = readFileSync(join(outerDir, shaFile), 'utf8').trim().split(/\s+/)[0]
      const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
      if (expected && actual !== expected) throw new Error(`引擎归档 sha256 校验失败（${wanted}）`)
    }
  } else if (source.expectedSha && digest !== source.expectedSha) {
    rmSync(downloadPath, { force: true })
    throw new Error('引擎包 sha256 校验失败（SHA256SUMS 不匹配）')
  }

  publish({ phase: 'extracting', percent: 0 })
  const extractDir = join(workDir, `${source.stamp}-extract`)
  rmSync(extractDir, { recursive: true, force: true })
  await extractArchive(archivePath, extractDir)
  const { serverPath, installDir } = await installTree(extractDir, source.stamp)
  rmSync(archivePath, { force: true })
  if (effectiveVariant === 'system-cuda' && cudaWheels) {
    publish({ phase: 'cuda_libs' })
    await installCudaWheels(installDir, flavour)
  } // free the archive before the CUDA-libs download
  rmSync(workDir, { recursive: true, force: true })
  return { serverPath, stamp: source.stamp, effectiveVariant, fallbackNote }
}

export async function downloadMossInfer(
  channel: 'stable' | 'dev',
  flavourInput?: 'cu12' | 'cu13',
  variantInput?: Variant,
  cudaWheels = false,
  releaseTag?: string,
): Promise<MossInferDownloadState> {
  if (operationInProgress && current) return current
  if (current && !['done', 'error', 'canceled'].includes(current.phase)) return current
  const settings = getSettings()
  const variant: Variant = variantInput ?? settings.mossInferVariant
  const operationController = new AbortController()
  controller = operationController
  operationInProgress = true
  current = {
    channel,
    phase: 'querying',
    releaseTag,
    bytes: 0,
    totalBytes: 0,
    percent: 0,
    speedBps: 0,
    updatedAt: new Date().toISOString(),
  }
  publish({ phase: 'querying' })
  try {
    let flavour = flavourInput ?? 'cu13'
    let installed = await downloadAndInstall(channel, flavour, variant, settings, cudaWheels, releaseTag)
    // Upstream decision procedure: install cu13 by default, probe, fall back to cu12.
    let probe = await probeMossInfer(installed.serverPath)
    let recommended = String((probe['probe'] as Record<string, unknown> | undefined)?.['recommended_flavour'] ?? '')
    if (flavour === 'cu13' && recommended === 'cu12') {
      publish({ phase: 'querying', version: '驱动只支持 CUDA 12，改下 cu12 包' })
      flavour = 'cu12'
      installed = await downloadAndInstall(channel, flavour, variant, settings, cudaWheels, releaseTag)
      probe = await probeMossInfer(installed.serverPath)
      recommended = String((probe['probe'] as Record<string, unknown> | undefined)?.['recommended_flavour'] ?? '')
    }
    const update = updateSettings({
      mossInferServerPath: installed.serverPath,
      mossInferChannel: channel,
      mossInferVariant: installed.effectiveVariant,
    })
    emit(Events.settingsChanged, update)
    await shutdownMossInfer() // next job spawns the freshly installed binary
    publish({
      phase: 'done',
      percent: 100,
      serverPath: installed.serverPath,
      recommendedFlavour: recommended,
      variant: installed.effectiveVariant,
      note: installed.fallbackNote,
      cublaslt: (probe['probe'] as Record<string, unknown> | undefined)?.['cublaslt'],
    })
  } catch (error) {
    publish({
      phase: operationController.signal.aborted ? 'canceled' : 'error',
      error: operationController.signal.aborted ? undefined : error instanceof Error ? error.message : String(error),
    })
  } finally {
    operationInProgress = false
    if (controller === operationController) controller = null
  }
  return current
}
