import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Announcement, Settings, UpdateState } from '@shared/types'
import { compareSemver, findInstaller, pickLatestVersion, releaseVersionCandidates } from '@shared/release'
import { paths } from '../lib/paths'
import { loadReleaseDocument, localReleaseDir } from './release'
import { applyGitMirror, getLastNetwork, githubMirrorChain } from './network'
import { getSettings, updateSettings } from './settings'
import { pushLocalNotification } from './desktopNotifications'

export { localReleaseDir }

let lastNotifiedUpdateVersion: string | null = null

async function fetchText(url: string, timeoutMs = 6000): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': `MossStudio-Launcher/${app.getVersion()}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}

async function resolveBody(
  docBody: string,
  raw: { body_markdown?: string; body_url?: string },
  localDir: string | null,
): Promise<string> {
  if (raw.body_markdown) return raw.body_markdown
  if (!raw.body_url) return ''
  if (localDir && raw.body_url.includes('CloverIris/MossStudio')) {
    const readme = join(localDir, 'README.md')
    if (existsSync(readme)) return readFileSync(readme, 'utf8')
  }
  try {
    return await fetchText(raw.body_url)
  } catch {
    return docBody || '公告内容暂时无法加载。'
  }
}

function releaseNotes(body: string): string {
  const marker = body.indexOf('## 发布说明')
  if (marker < 0) return body
  return body.slice(marker + '## 发布说明'.length).replace(/^\s+/, '').trim()
}

interface GithubRelease {
  version: string
  url?: string
  notes?: string
  publishedAt?: string
}

/**
 * Newest published GitHub release, straight from the API.
 *
 * `release/manifest.json` is only bumped when someone remembers to; a release
 * published on GitHub without it was invisible to every client. Ask GitHub as a
 * second opinion so a real release never goes unnoticed, and keep the manifest
 * as the source for installers, announcements and the home copy.
 */
async function latestGithubRelease(settings: Settings): Promise<GithubRelease | null> {
  const base = getLastNetwork()?.selected.manifest ?? 'https://raw.githubusercontent.com/CloverIris/MossStudio/main'
  const repo = /raw\.githubusercontent\.com\/([^/]+)\/([^/]+)/.exec(base)
  const slug = repo ? `${repo[1]}/${repo[2]}` : 'CloverIris/MossStudio'
  const api = `https://api.github.com/repos/${slug}/releases/latest`
  const targets = settings.networkMode === 'direct'
    ? [api]
    : [api, ...githubMirrorChain(settings).map((mirror) => applyGitMirror(api, mirror))]
  for (const target of targets) {
    try {
      const response = await fetch(target, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `MossStudio-Launcher/${app.getVersion()}` },
        signal: AbortSignal.timeout(6000),
      })
      if (!response.ok) continue
      const body = await response.json() as {
        tag_name?: string
        name?: string
        html_url?: string
        body?: string
        published_at?: string
        draft?: boolean
        prerelease?: boolean
        assets?: Array<{ name?: string }>
      }
      if (!body.tag_name || body.draft) continue
      if (body.prerelease && settings.updateChannel !== 'beta') continue
      const [version] = releaseVersionCandidates({
        tag: body.tag_name,
        name: body.name,
        assets: (body.assets ?? []).map((asset) => asset.name ?? ''),
        body: body.body,
      })
      if (!version) continue
      return { version, url: body.html_url, notes: body.body?.trim() || undefined, publishedAt: body.published_at }
    } catch {
      // Try the next mirror; a blocked API must never fail the whole check.
    }
  }
  return null
}

/**
 * Read the current release state.
 *
 * `force` bypasses the per-process document cache. Background and manual checks
 * pass it: without a fresh read a long-running app would keep answering from the
 * document it loaded at startup, no matter how often it asked.
 */
export async function checkUpdates(settings?: Settings, options: { force?: boolean } = {}): Promise<UpdateState> {
  const effective = settings ?? getSettings()
  const checkedAt = new Date().toISOString()
  const currentVersion = app.getVersion()

  try {
    const loaded = await loadReleaseDocument(options.force === true, effective.updateChannel)
    const doc = loaded.document
    const localDir = localReleaseDir()
    const now = Date.now()
    const dismissed = new Set(effective.dismissedAnnouncements)
    const announcements: Announcement[] = []

    for (const raw of doc.announcements) {
      if (dismissed.has(raw.id)) continue
      if (raw.starts_at && Date.parse(raw.starts_at) > now) continue
      if (raw.ends_at && Date.parse(raw.ends_at) < now) continue
      announcements.push({
        id: raw.id,
        level: raw.level,
        title: raw.title,
        body: await resolveBody(loaded.body, raw, localDir),
        bodyUrl: raw.body_url,
        startsAt: raw.starts_at,
        endsAt: raw.ends_at ?? null,
        dismissible: raw.dismissible ?? true,
        pinned: raw.pinned ?? false,
        action: raw.action,
      })
    }
    announcements.sort((a, b) => Number(b.pinned) - Number(a.pinned))

    // The manifest only knows what it was built with; GitHub knows what was published.
    const github = compareSemver(doc.app.version, currentVersion) > 0 ? null : await latestGithubRelease(effective)
    const choice = pickLatestVersion({ manifest: doc.app.version, github: github?.version ?? null, current: currentVersion })
    const latestVersion = choice.version ?? doc.app.version
    const notes = choice.from === 'github' && github?.notes ? github.notes : releaseNotes(loaded.body)
    const releaseUrl = choice.from === 'github' && github?.url ? github.url : doc.app.notes_url
    const publishedAt = choice.from === 'github' && github?.publishedAt ? github.publishedAt : doc.app.published_at
    if (choice.from === 'github') {
      console.log(`[updates] github release ${latestVersion} is newer than the manifest (${doc.app.version})`)
    }
    const state: UpdateState = {
      checkedAt,
      currentVersion,
      latestVersion,
      updateAvailable: choice.updateAvailable,
      channel: doc.app.channel,
      manifestSource: loaded.source,
      home: doc.home,
      announcements,
      releaseNotes: notes,
      publishedAt,
      releaseUrl,
      installer: findInstaller(doc.installers, process.platform, process.arch),
      mandatory: doc.app.mandatory ?? false,
    }
    const quiet =
      process.argv.includes('--smoke') ||
      process.argv.includes('--screenshot') ||
      process.argv.some((arg) => arg.startsWith('--scenario='))
    if (
      choice.updateAvailable &&
      latestVersion !== lastNotifiedUpdateVersion &&
      latestVersion !== effective.dismissedUpdateVersion &&
      !quiet
    ) {
      const shown = pushLocalNotification({
        title: `发现新版本 ${latestVersion}`,
        body: '打开启动器查看更新说明并选择是否安装。',
        windowKind: 'studio',
        route: '/settings',
      })
      if (shown) lastNotifiedUpdateVersion = latestVersion
    }
    return state
  } catch (error) {
    return {
      checkedAt,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      channel: 'stable',
      manifestSource: 'none',
      announcements: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Legacy install sources still live in manifest.json. Keep this reader until the
 * recommended commit is moved into a release document of its own.
 */
export function getRecommendedCommit(): string | null {
  const local = localReleaseDir()
  if (local) {
    try {
      const manifest = JSON.parse(readFileSync(join(local, 'manifest.json'), 'utf8')) as {
        sources?: { moss?: { recommended_commit?: string } }
      }
      return manifest.sources?.moss?.recommended_commit ?? null
    } catch {
      // fall through
    }
  }
  try {
    const cached = JSON.parse(readFileSync(join(paths.cache(), 'release.json'), 'utf8')) as {
      manifest?: { sources?: { moss?: { recommended_commit?: string } } }
    }
    return cached.manifest?.sources?.moss?.recommended_commit ?? null
  } catch {
    return null
  }
}

export function dismissAnnouncement(id: string): void {
  const settings = getSettings()
  updateSettings({ dismissedAnnouncements: [...settings.dismissedAnnouncements, id] })
}
