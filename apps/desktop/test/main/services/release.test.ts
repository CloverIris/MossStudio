import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'
import { releaseDocument, releaseMarkdown } from './releaseFixtures'

const state = { settings: settingsFixture({ networkMode: 'direct' }) as Settings }
vi.mock('@main/services/settings', () => ({ getSettings: () => state.settings }))

const dataRoot = useTempDataRoot()
const temp = useTempDir('release-')
const LATEST = 'https://github.com/CloverIris/MossStudio/releases/latest/download/release.md'
const BETA = 'https://github.com/CloverIris/MossStudio/releases/download/beta/release.md'
const RAW = 'https://raw.githubusercontent.com/CloverIris/MossStudio/main/release/release.md'
const JSDELIVR = 'https://cdn.jsdelivr.net/gh/CloverIris/MossStudio@main/release/release.md'
const originalResources = (process as { resourcesPath?: string }).resourcesPath

async function load(options: { packaged?: boolean } = {}) {
  // Electron provides these; Node does not. Point every lookup at the temp dir.
  const electron = await import('electron') as unknown as typeof import('@test/mocks/electron')
  electron.app.isPackaged = options.packaged ?? false
  vi.spyOn(electron.app, 'getAppPath').mockReturnValue(join(temp(), 'app', 'resources', 'app.asar'))
  vi.spyOn(process, 'cwd').mockReturnValue(join(temp(), 'cwd'))
  Object.defineProperty(process, 'resourcesPath', { value: join(temp(), 'resources'), configurable: true, writable: true })
  return import('@main/services/release')
}

function localRelease(markdown = releaseMarkdown()): string {
  const dir = join(temp(), 'app', 'resources', 'app.asar', 'release')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'release.md'), markdown)
  return dir
}

function serve(routes: Record<string, string | number>) {
  const fetch = vi.fn(async (input: string | URL) => {
    const route = routes[String(input)]
    if (route === undefined) throw new Error('unreachable')
    return typeof route === 'number' ? new Response('', { status: route }) : new Response(route)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => {
  vi.resetModules()
  state.settings = settingsFixture({ networkMode: 'direct' })
})
afterEach(() => {
  Object.defineProperty(process, 'resourcesPath', { value: originalResources, configurable: true, writable: true })
})

describe('localReleaseDir', () => {
  it('returns the first candidate with release.md or manifest.json', async () => {
    const { localReleaseDir } = await load()
    expect(localReleaseDir()).toBeNull()
    mkdirSync(join(temp(), 'resources', 'release'), { recursive: true })
    writeFileSync(join(temp(), 'resources', 'release', 'manifest.json'), '{}')
    expect(localReleaseDir()).toBe(join(temp(), 'resources', 'release'))
    // The app path wins over resourcesPath once it has a release.md.
    const appRelease = localRelease()
    expect(localReleaseDir()).toBe(appRelease)
  })
})

describe('loadReleaseDocument', () => {
  it('uses the workspace release.md in development without touching the network', async () => {
    localRelease()
    const fetch = serve({})
    const loaded = await (await load()).loadReleaseDocument()
    expect(loaded.source).toBe('local')
    expect(loaded.document.app.version).toBe('1.2.0')
    expect(loaded.body).toContain('## 发布说明')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('prefers CLOVER_RELEASE_FILE over the release directory', async () => {
    localRelease()
    const override = join(temp(), 'override.md')
    writeFileSync(override, releaseMarkdown(releaseDocument({}, { version: '9.9.9' })))
    vi.stubEnv('CLOVER_RELEASE_FILE', override)
    expect((await (await load()).loadReleaseDocument()).document.app.version).toBe('9.9.9')
  })

  it('fetches the latest release when packaged and caches it on disk', async () => {
    serve({ [LATEST]: releaseMarkdown(releaseDocument({}, { version: '1.3.0' })) })
    const { loadReleaseDocument } = await load({ packaged: true })
    const loaded = await loadReleaseDocument()
    expect(loaded).toMatchObject({ source: 'remote', document: { app: { version: '1.3.0' } } })
    const cache = JSON.parse(readFileSync(join(dataRoot(), 'cache', 'release-v2-stable.json'), 'utf8'))
    expect(cache).toMatchObject({ source: 'remote', url: LATEST })
  })

  it('walks beta, latest, raw and jsDelivr in order and skips invalid documents', async () => {
    const fetch = serve({ [BETA]: 404, [LATEST]: 'no machine block', [RAW]: 500, [JSDELIVR]: releaseMarkdown(releaseDocument({}, { version: '1.3.0-beta.1', channel: 'beta' })) })
    const loaded = await (await load({ packaged: true })).loadReleaseDocument(false, 'beta')
    expect(loaded.document.app.version).toBe('1.3.0-beta.1')
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([BETA, LATEST, RAW, JSDELIVR])
  })

  it('tries GitHub mirrors for GitHub URLs unless the network mode is direct', async () => {
    state.settings = settingsFixture({ networkMode: 'auto' })
    const fetch = serve({ [`https://ghproxy.net/${LATEST}`]: releaseMarkdown() })
    await (await load({ packaged: true })).loadReleaseDocument()
    expect(fetch.mock.calls.map(([input]) => String(input)).slice(0, 2)).toEqual([LATEST, `https://ghproxy.net/${LATEST}`])
  })

  it('falls back to the disk cache, then the local file, then a legacy manifest', async () => {
    serve({ [LATEST]: releaseMarkdown(releaseDocument({}, { version: '1.3.0' })) })
    await (await load({ packaged: true })).loadReleaseDocument()
    vi.resetModules()
    serve({})
    expect(await (await load({ packaged: true })).loadReleaseDocument()).toMatchObject({ source: 'cache', document: { app: { version: '1.3.0' } } })

    writeFileSync(join(dataRoot(), 'cache', 'release-v2-stable.json'), '{}')
    localRelease(releaseMarkdown(releaseDocument({}, { version: '1.1.0' })))
    vi.resetModules()
    expect(await (await load({ packaged: true })).loadReleaseDocument()).toMatchObject({ source: 'local', document: { app: { version: '1.1.0' } } })
  })

  it('converts a legacy manifest.json, keeping only fully specified installers', async () => {
    const dir = join(temp(), 'resources', 'release')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), 'legacy notes')
    writeFileSync(join(dir, 'models.json'), '{"models":[]}')
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      app: { version: '0.9.0', channel: 'weird' },
      assets: [
        { platform: 'win32', arch: 'x64', kind: 'zip', url: 'https://x/a.zip', sha256: 'a'.repeat(64), size_bytes: 10 },
        { platform: 'win32', arch: 'x64', kind: 'zip', url: 'http://x/a.zip', sha256: 'a'.repeat(64), size_bytes: 10 },
        { platform: 'win32', arch: 'x64', kind: 'zip', url: 'https://x/a.zip', sha256: 'short', size_bytes: 10 },
      ],
      announcements: [{ title: 'Hello' }],
      catalog: { models_url: 'https://x/models.json' },
    }))
    serve({})
    const loaded = await (await load({ packaged: true })).loadReleaseDocument()
    expect(loaded.source).toBe('local')
    expect(loaded.document.app).toMatchObject({ name: 'MossStudio', channel: 'stable', version: '0.9.0' })
    expect(loaded.document.installers).toHaveLength(1)
    expect(loaded.document.catalog?.models_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(loaded.document.announcements[0]).toMatchObject({ id: 'legacy-Hello', level: 'info', body_markdown: 'legacy notes', dismissible: true, pinned: false })
  })

  it('throws when no source is available', async () => {
    serve({})
    await expect((await load({ packaged: true })).loadReleaseDocument()).rejects.toThrow('无法读取 release.md')
  })

  it('caches per channel in memory until forced or cleared, and shares in-flight loads', async () => {
    const fetch = serve({ [LATEST]: releaseMarkdown() })
    const { loadReleaseDocument, clearReleaseCache } = await load({ packaged: true })
    const [a, b] = await Promise.all([loadReleaseDocument(), loadReleaseDocument()])
    expect(a).toBe(b)
    expect(await loadReleaseDocument()).toBe(a)
    expect(fetch).toHaveBeenCalledOnce()
    await loadReleaseDocument(true)
    clearReleaseCache()
    await loadReleaseDocument()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
