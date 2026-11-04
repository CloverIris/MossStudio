import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseReleaseMarkdown } from '@shared/release'
import type { Settings } from '@shared/types'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'
import { releaseDocument, releaseMarkdown } from './releaseFixtures'

const state = {
  settings: settingsFixture({ networkMode: 'direct' }) as Settings,
  markdown: releaseMarkdown(),
  loadError: null as Error | null,
  localDir: null as string | null,
  notified: [] as Array<{ title: string }>,
  notificationShown: true,
  loadCalls: [] as unknown[][],
}
vi.mock('@main/services/release', () => ({
  loadReleaseDocument: async (...args: unknown[]) => {
    state.loadCalls.push(args)
    if (state.loadError) throw state.loadError
    return { ...parseReleaseMarkdown(state.markdown), source: 'remote', fetchedAt: 'now' }
  },
  localReleaseDir: () => state.localDir,
}))
vi.mock('@main/services/settings', () => ({
  getSettings: () => state.settings,
  updateSettings: (patch: Partial<Settings>) => (state.settings = { ...state.settings, ...patch }),
}))
vi.mock('@main/services/desktopNotifications', () => ({
  pushLocalNotification: (input: { title: string }) => { state.notified.push(input); return state.notificationShown },
}))

const dataRoot = useTempDataRoot()
const temp = useTempDir()
const API = 'https://api.github.com/repos/CloverIris/MossStudio/releases/latest'

function github(body: Record<string, unknown> | number, extra: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (input: string | URL) => {
    const url = String(input)
    if (url in extra) return typeof extra[url] === 'number' ? new Response('', { status: extra[url] as number }) : new Response(String(extra[url]))
    if (url === API) return typeof body === 'number' ? new Response('', { status: body }) : Response.json(body)
    throw new Error(`unexpected ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('MOSSSTUDIO_TEST_APP_VERSION', '1.2.0')
  Object.assign(state, {
    settings: settingsFixture({ networkMode: 'direct' }), markdown: releaseMarkdown(), loadError: null, localDir: null,
    notified: [], notificationShown: true, loadCalls: [],
  })
  github(404)
})
const load = () => import('@main/services/updates')

describe('checkUpdates versions', () => {
  it('reports no update when the manifest and GitHub match the running version', async () => {
    const state_ = await (await load()).checkUpdates()
    expect(state_).toMatchObject({ currentVersion: '1.2.0', latestVersion: '1.2.0', updateAvailable: false, channel: 'stable', manifestSource: 'remote', releaseNotes: '- Faster' })
    expect(state.notified).toEqual([])
  })

  it('announces a newer manifest once and skips the GitHub API', async () => {
    state.markdown = releaseMarkdown(releaseDocument({}, { version: '1.3.0' }))
    const fetch = github(404)
    const { checkUpdates } = await load()
    expect(await checkUpdates(undefined, { force: true })).toMatchObject({ latestVersion: '1.3.0', updateAvailable: true, releaseUrl: 'https://example.test/notes' })
    await checkUpdates()
    expect(fetch).not.toHaveBeenCalled()
    expect(state.notified).toEqual([expect.objectContaining({ title: '发现新版本 1.3.0' })])
    expect(state.loadCalls[0]).toEqual([true, 'stable'])
    expect(state.loadCalls[1]).toEqual([false, 'stable'])
  })

  it('retries the notification when it was not shown and respects a dismissed version', async () => {
    state.markdown = releaseMarkdown(releaseDocument({}, { version: '1.3.0' }))
    state.notificationShown = false
    const { checkUpdates } = await load()
    await checkUpdates()
    await checkUpdates()
    expect(state.notified).toHaveLength(2)
    state.notified = []
    await checkUpdates(settingsFixture({ dismissedUpdateVersion: '1.3.0' }))
    expect(state.notified).toEqual([])
  })

  it('takes a newer GitHub release, its notes and URL when the manifest lags', async () => {
    github({ tag_name: 'v0.1.0', name: 'MossStudio 1.2.1', html_url: 'https://github.com/r/1.2.1', body: '  hotfix  ', published_at: '2026-10-05', assets: [{ name: 'MossStudio-1.2.1-win32-x64.zip' }] })
    expect(await (await load()).checkUpdates()).toMatchObject({ latestVersion: '1.2.1', updateAvailable: true, releaseNotes: 'hotfix', releaseUrl: 'https://github.com/r/1.2.1', publishedAt: '2026-10-05' })
  })

  it('ignores drafts, unrecognisable tags and prereleases outside the beta channel', async () => {
    const { checkUpdates } = await load()
    github({ tag_name: 'v1.3.0', draft: true })
    expect((await checkUpdates()).updateAvailable).toBe(false)
    github({ tag_name: 'nightly' })
    expect((await checkUpdates()).updateAvailable).toBe(false)
    github({ tag_name: 'v1.3.0-beta.1', prerelease: true })
    expect((await checkUpdates()).updateAvailable).toBe(false)
    expect(await checkUpdates(settingsFixture({ networkMode: 'direct', updateChannel: 'beta' }))).toMatchObject({ latestVersion: '1.3.0-beta.1', updateAvailable: true })
  })

  it('asks GitHub mirrors when the API is unreachable', async () => {
    state.settings = settingsFixture({ networkMode: 'auto' })
    const fetch = github(403, { [`https://ghproxy.net/${API}`]: JSON.stringify({ tag_name: 'v1.2.5' }) })
    expect((await (await load()).checkUpdates()).latestVersion).toBe('1.2.5')
    expect(fetch.mock.calls.map(([input]) => String(input)).slice(0, 2)).toEqual([API, `https://ghproxy.net/${API}`])
  })

  it('picks the installer for this platform', async () => {
    state.markdown = releaseMarkdown(releaseDocument({ installers: [
      { platform: process.platform, arch: process.arch, kind: 'zip', url: 'https://x/a.zip', sha256: 'a'.repeat(64), size_bytes: 1 },
      { platform: process.platform, arch: process.arch, kind: 'exe', url: 'https://x/a.exe', sha256: 'b'.repeat(64), size_bytes: 1 },
    ] }, { mandatory: true }))
    expect(await (await load()).checkUpdates()).toMatchObject({ installer: { kind: 'exe' }, mandatory: true })
  })

  it('returns an error state instead of throwing when the release cannot load', async () => {
    state.loadError = new Error('无法读取 release.md')
    expect(await (await load()).checkUpdates()).toMatchObject({ latestVersion: null, updateAvailable: false, manifestSource: 'none', announcements: [], error: '无法读取 release.md' })
  })
})

describe('checkUpdates announcements', () => {
  const at = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString()

  it('filters dismissed, future and expired announcements and pins first', async () => {
    state.markdown = releaseMarkdown(releaseDocument({ announcements: [
      { id: 'plain', level: 'info', title: 'Plain', body_markdown: 'a' },
      { id: 'pinned', level: 'warning', title: 'Pinned', body_markdown: 'b', pinned: true, ends_at: at(1) },
      { id: 'dismissed', level: 'info', title: 'D', body_markdown: 'c' },
      { id: 'future', level: 'info', title: 'F', body_markdown: 'd', starts_at: at(1) },
      { id: 'expired', level: 'info', title: 'E', body_markdown: 'e', ends_at: at(-1) },
    ] }))
    const result = await (await load()).checkUpdates(settingsFixture({ networkMode: 'direct', dismissedAnnouncements: ['dismissed'] }))
    expect(result.announcements.map((item) => item.id)).toEqual(['pinned', 'plain'])
    expect(result.announcements[1]).toMatchObject({ body: 'a', dismissible: true, pinned: false, endsAt: null })
  })

  it('loads remote bodies, reads the local README for repo links and falls back on failure', async () => {
    state.localDir = temp()
    writeFileSync(join(temp(), 'README.md'), 'local readme')
    state.markdown = releaseMarkdown(releaseDocument({ announcements: [
      { id: 'repo', level: 'info', title: 'Repo', body_url: 'https://github.com/CloverIris/MossStudio/blob/main/README.md' },
      { id: 'remote', level: 'info', title: 'Remote', body_url: 'https://example.test/body.md' },
      { id: 'broken', level: 'info', title: 'Broken', body_url: 'https://example.test/broken.md' },
    ] }))
    github(404, { 'https://example.test/body.md': 'remote body', 'https://example.test/broken.md': 500 })
    const bodies = (await (await load()).checkUpdates()).announcements.map((item) => item.body)
    expect(bodies[0]).toBe('local readme')
    expect(bodies[1]).toBe('remote body')
    expect(bodies[2]).toContain('## 发布说明')
  })

  it('dismissAnnouncement appends to the dismissed list', async () => {
    state.settings = settingsFixture({ dismissedAnnouncements: ['a'] })
    ;(await load()).dismissAnnouncement('b')
    expect(state.settings.dismissedAnnouncements).toEqual(['a', 'b'])
  })
})

describe('getRecommendedCommit', () => {
  it('reads the local manifest, then the cached manifest, else null', async () => {
    const { getRecommendedCommit } = await load()
    expect(getRecommendedCommit()).toBeNull()
    mkdirSync(join(dataRoot(), 'cache'), { recursive: true })
    writeFileSync(join(dataRoot(), 'cache', 'release.json'), JSON.stringify({ manifest: { sources: { moss: { recommended_commit: 'cached' } } } }))
    expect(getRecommendedCommit()).toBe('cached')
    state.localDir = temp()
    writeFileSync(join(temp(), 'manifest.json'), JSON.stringify({ sources: { moss: { recommended_commit: 'local' } } }))
    expect(getRecommendedCommit()).toBe('local')
    writeFileSync(join(temp(), 'manifest.json'), '{')
    expect(getRecommendedCommit()).toBe('cached')
  })
})
