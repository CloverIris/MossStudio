import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReleaseDocument, ParsedRelease } from '@shared/release'
import { parseReleaseMarkdown } from '@shared/release'
import { paths } from '../lib/paths'
import { getLastNetwork, githubMirrorChain } from './network'
import { getSettings } from './settings'

const LATEST_RELEASE_URL =
  'https://github.com/CloverIris/MossStudio/releases/latest/download/release.md'
const BETA_RELEASE_URL =
  'https://github.com/CloverIris/MossStudio/releases/download/beta/release.md'
const RAW_RELEASE_URL =
  'https://raw.githubusercontent.com/CloverIris/MossStudio/main/release/release.md'
const JSDELIVR_RELEASE_URL =
  'https://cdn.jsdelivr.net/gh/CloverIris/MossStudio@main/release/release.md'

export type ReleaseSource = 'local' | 'remote' | 'cache'
export type UpdateChannel = 'stable' | 'beta'

export interface LoadedRelease extends ParsedRelease {
  source: ReleaseSource
  fetchedAt: string
}

const cached = new Map<UpdateChannel, LoadedRelease>()
const inflight = new Map<UpdateChannel, Promise<LoadedRelease>>()

export function localReleaseDir(): string | null {
  const candidates = [
    join(app.getAppPath(), 'release'),
    join(app.getAppPath(), '..', '..', 'release'),
    join(process.resourcesPath, 'release'),
    join(process.cwd(), 'release'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'release.md')) || existsSync(join(dir, 'manifest.json'))) return dir
  }
  return null
}

function localReleaseFile(): string | null {
  const override = process.env['CLOVER_RELEASE_FILE']
  if (override && existsSync(override)) return override
  const dir = localReleaseDir()
  return dir ? join(dir, 'release.md') : null
}

function cacheFile(channel: UpdateChannel): string {
  return join(paths.cache(), `release-v2-${channel}.json`)
}

async function fetchText(url: string, timeoutMs = 7000): Promise<string> {
  const parsed = new URL(url)
  const settings = getSettings()
  const githubUrl = parsed.hostname === 'github.com' || parsed.hostname === 'raw.githubusercontent.com'
  const mirrors =
    githubUrl && settings.networkMode !== 'direct'
      ? githubMirrorChain(settings).map((mirror) => `${mirror.replace(/\/$/, '')}/${url}`)
      : []
  const preferred = Boolean(settings.gitMirror?.trim() || getLastNetwork()?.selected.git)
  const candidates = [
    ...new Set(preferred ? [...mirrors, url] : [url, ...mirrors]),
  ]
  const failures: string[] = []
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: { 'user-agent': `MossStudio-Launcher/${app.getVersion()}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        failures.push(`${new URL(candidate).host}: HTTP ${response.status}`)
        await response.body?.cancel()
        continue
      }
      return await response.text()
    } catch (error) {
      failures.push(
        `${new URL(candidate).host}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  throw new Error(`Release 请求失败：${failures.join('；')}`)
}

function readLocal(): LoadedRelease | null {
  const file = localReleaseFile()
  if (!file || !existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf8')
    return { ...parseReleaseMarkdown(raw), source: 'local', fetchedAt: new Date().toISOString() }
  } catch {
    return null
  }
}

function remoteUrls(channel: UpdateChannel): string[] {
  const urls = channel === 'beta' ? [BETA_RELEASE_URL, LATEST_RELEASE_URL] : [LATEST_RELEASE_URL]
  urls.push(RAW_RELEASE_URL, JSDELIVR_RELEASE_URL)
  const selected = getLastNetwork()?.selected.manifest
  if (selected) {
    const base = selected.replace(/\/$/, '')
    const candidate = base.endsWith('/release') ? `${base}/release.md` : `${base}/release/release.md`
    if (!urls.includes(candidate)) urls.push(candidate)
  }
  return urls
}

async function loadRemote(channel: UpdateChannel): Promise<LoadedRelease | null> {
  for (const url of remoteUrls(channel)) {
    try {
      const raw = await fetchText(url)
      const parsed = parseReleaseMarkdown(raw)
      const loaded: LoadedRelease = {
        ...parsed,
        source: 'remote',
        fetchedAt: new Date().toISOString(),
      }
      try {
        mkdirSync(paths.cache(), { recursive: true })
        writeFileSync(
          cacheFile(channel),
          JSON.stringify(
            {
              raw: loaded.raw,
              source: loaded.source,
              fetchedAt: loaded.fetchedAt,
              url,
            },
            null,
            2,
          ),
          'utf8',
        )
      } catch {
        // cache is best effort
      }
      return loaded
    } catch {
      // try next source
    }
  }
  return null
}

function readCache(channel: UpdateChannel): LoadedRelease | null {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(channel), 'utf8')) as { raw?: string; fetchedAt?: string }
    if (!raw.raw) return null
    return {
      ...parseReleaseMarkdown(raw.raw),
      source: 'cache',
      fetchedAt: raw.fetchedAt ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
}

interface LegacyManifest {
  app?: {
    name?: string
    channel?: 'stable' | 'beta'
    version?: string
    min_supported?: string
    published_at?: string
    notes_url?: string
  }
  announcements?: Array<{
    id?: string
    level?: 'info' | 'success' | 'warning' | 'critical'
    title?: string
    body_markdown?: string
    body_url?: string
    starts_at?: string
    ends_at?: string | null
    dismissible?: boolean
    pinned?: boolean
    action?: { label: string; kind: 'open_url' | 'check_update' | 'open_settings'; url?: string }
  }>
  home?: { chapter?: string; title?: string; subtitle?: string }
  assets?: Array<{
    platform?: 'darwin' | 'win32' | 'linux'
    arch?: 'arm64' | 'x64'
    kind?: 'dmg' | 'zip' | 'nsis' | 'appimage'
    url?: string
    sha256?: string
    size_bytes?: number
  }>
  catalog?: { models_url?: string }
}

function legacyRelease(): LoadedRelease | null {
  const dir = localReleaseDir()
  if (!dir) return null
  const manifestFile = join(dir, 'manifest.json')
  if (!existsSync(manifestFile)) return null
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as LegacyManifest
    if (!manifest.app?.version) return null
    const readmeFile = join(dir, 'README.md')
    const notes = existsSync(readmeFile) ? readFileSync(readmeFile, 'utf8') : ''
    const modelsFile = join(dir, 'models.json')
    const modelsSha = existsSync(modelsFile)
      ? createHash('sha256').update(readFileSync(modelsFile)).digest('hex')
      : null
    const installers = (manifest.assets ?? []).filter(
      (asset) =>
        asset.platform &&
        asset.arch &&
        asset.kind &&
        asset.url?.startsWith('https://') &&
        /^[a-f0-9]{64}$/i.test(asset.sha256 ?? '') &&
        (asset.size_bytes ?? 0) > 0,
    ) as NonNullable<LegacyManifest['assets']>
    const document: ReleaseDocument = {
      schema_version: 2,
      app: {
        name: manifest.app.name ?? 'MossStudio',
        channel: manifest.app.channel === 'beta' ? 'beta' : 'stable',
        version: manifest.app.version,
        min_supported: manifest.app.min_supported,
        published_at: manifest.app.published_at ?? new Date().toISOString(),
        notes_url: manifest.app.notes_url,
      },
      installers: installers.map((asset) => ({
        platform: asset.platform!,
        arch: asset.arch!,
        kind: asset.kind!,
        url: asset.url!,
        sha256: asset.sha256!,
        size_bytes: asset.size_bytes!,
      })),
      home: manifest.home,
      catalog:
        manifest.catalog?.models_url && modelsSha
          ? {
              updated_at: new Date().toISOString(),
              models_url: manifest.catalog.models_url,
              models_sha256: modelsSha,
            }
          : undefined,
      announcements: (manifest.announcements ?? []).map((item) => ({
        id: item.id ?? `legacy-${item.title ?? 'announcement'}`,
        level: item.level ?? 'info',
        title: item.title ?? '公告',
        body_markdown: item.body_markdown ?? notes,
        body_url: item.body_url,
        starts_at: item.starts_at,
        ends_at: item.ends_at ?? null,
        dismissible: item.dismissible ?? true,
        pinned: item.pinned ?? false,
        action: item.action,
      })),
    }
    return {
      document,
      body: notes,
      raw: JSON.stringify(document, null, 2),
      source: 'local',
      fetchedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

/**
 * Prefer the workspace copy in dev, the latest release asset in packaged builds.
 * Remote parse failures never prevent the cached or legacy document from loading.
 */
export async function loadReleaseDocument(
  force = false,
  channel: UpdateChannel = 'stable',
): Promise<LoadedRelease> {
  const existing = cached.get(channel)
  if (existing && !force) return existing
  const running = inflight.get(channel)
  if (running && !force) return running
  const promise = (async () => {
    const local = readLocal()
    if (!app.isPackaged && !process.env['CLOVER_RELEASE_REMOTE'] && local) {
      cached.set(channel, local)
      return local
    }
    const remote = await loadRemote(channel)
    if (remote) {
      cached.set(channel, remote)
      return remote
    }
    const cache = readCache(channel)
    if (cache) {
      cached.set(channel, cache)
      return cache
    }
    if (local) {
      cached.set(channel, local)
      return local
    }
    const legacy = legacyRelease()
    if (legacy) {
      cached.set(channel, legacy)
      return legacy
    }
    throw new Error('无法读取 release.md（本地/远程/缓存均不可用）')
  })()
  inflight.set(channel, promise)
  try {
    return await promise
  } finally {
    inflight.delete(channel)
  }
}

export function clearReleaseCache(): void {
  cached.clear()
}
