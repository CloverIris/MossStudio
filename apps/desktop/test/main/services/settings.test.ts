import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

const root = useTempDataRoot()

async function load() {
  return import('@main/services/settings')
}

function writeSettings(value: unknown): void {
  writeFileSync(join(root(), 'settings.json'), typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

beforeEach(() => {
  vi.resetModules()
})

describe('DEFAULT_SETTINGS', () => {
  it('matches the mock backend fixture so renderer tests use real defaults', async () => {
    const { DEFAULT_SETTINGS } = await load()
    expect(DEFAULT_SETTINGS).toEqual(settingsFixture())
  })
})

describe('getSettings', () => {
  it('returns defaults when no settings file exists', async () => {
    const { getSettings, DEFAULT_SETTINGS } = await load()
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('returns defaults when the file is corrupt JSON', async () => {
    writeSettings('{ not json')
    const { getSettings, DEFAULT_SETTINGS } = await load()
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('merges a partial file over defaults, including nested modelDirectories', async () => {
    writeSettings({ theme: 'dark', modelDirectories: { vae: '/vae' }, modelDownloadConcurrency: 2 })
    const { getSettings, DEFAULT_SETTINGS } = await load()
    const settings = getSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.modelDownloadConcurrency).toBe(2)
    expect(settings.modelDirectories).toEqual({ ...DEFAULT_SETTINGS.modelDirectories, vae: '/vae' })
    expect(settings.language).toBe(DEFAULT_SETTINGS.language)
  })

  it('caches the first read until the module is reloaded', async () => {
    writeSettings({ theme: 'dark' })
    const { getSettings } = await load()
    expect(getSettings().theme).toBe('dark')
    writeSettings({ theme: 'light' })
    expect(getSettings().theme).toBe('dark')
  })

  it.each([
    ['legacy cuda index uuid', { uuid: 'cuda:0' }],
    ['non-object', 'GPU-123'],
    ['missing uuid', {}],
    ['null', null],
  ])('resets an invalid gpuSelection (%s) to auto', async (_label, gpuSelection) => {
    writeSettings({ gpuSelection })
    const { getSettings } = await load()
    expect(getSettings().gpuSelection).toBe('auto')
  })

  it('keeps a valid GPU uuid selection', async () => {
    writeSettings({ gpuSelection: { uuid: 'GPU-1234' } })
    const { getSettings } = await load()
    expect(getSettings().gpuSelection).toEqual({ uuid: 'GPU-1234' })
  })

  it('migrates the retired sm75 variant to system-cuda + sm75 architecture', async () => {
    writeSettings({ mossInferVariant: 'sm75', mossInferArchitecture: 'auto' })
    const { getSettings } = await load()
    const settings = getSettings()
    expect(settings.mossInferVariant).toBe('system-cuda')
    expect(settings.mossInferArchitecture).toBe('sm75')
  })

  it('maps the removed auto tier to high and keeps valid tiers', async () => {
    writeSettings({ mossInferTier: 'auto' })
    expect((await load()).getSettings().mossInferTier).toBe('high')
    vi.resetModules()
    writeSettings({ mossInferTier: 'turbo' })
    expect((await load()).getSettings().mossInferTier).toBe('turbo')
  })

  it('replaces a non-array dismissedAnnouncements with an empty list', async () => {
    writeSettings({ dismissedAnnouncements: 'abc' })
    expect((await load()).getSettings().dismissedAnnouncements).toEqual([])
  })

  it('derives hasHfToken from the credential store, ignoring the stored flag', async () => {
    writeSettings({ hasHfToken: true })
    expect((await load()).getSettings().hasHfToken).toBe(false)
    vi.resetModules()
    writeFileSync(join(root(), 'hf-credentials.json'), JSON.stringify({ local: 'abc' }))
    writeSettings({ hasHfToken: false })
    expect((await load()).getSettings().hasHfToken).toBe(true)
  })

  it('turns on remote hosts / training for existing users who already configured them', async () => {
    writeSettings({ theme: 'dark' })
    let settings = (await load()).getSettings()
    expect(settings.remoteHostsEnabled).toBe(false)
    expect(settings.trainingEnabled).toBe(false)
    vi.resetModules()
    writeFileSync(join(root(), 'training-hosts.json'), JSON.stringify([{ id: 'ssh-a' }]))
    mkdirSync(join(root(), 'trainer', 'versions', 'main-abc1234'), { recursive: true })
    writeFileSync(join(root(), 'trainer', 'versions', 'main-abc1234', 'trainer.json'), '{}')
    settings = (await load()).getSettings()
    expect(settings.remoteHostsEnabled).toBe(true)
    expect(settings.trainingEnabled).toBe(true)
  })

  it('does not turn training on for the empty folders created at every launch', async () => {
    for (const dir of ['git', 'versions', 'runtimes']) mkdirSync(join(root(), 'trainer', dir), { recursive: true })
    mkdirSync(join(root(), 'trainer', 'versions', 'empty'), { recursive: true })
    writeSettings({ theme: 'dark' })
    expect((await load()).getSettings().trainingEnabled).toBe(false)
  })

  it('turns training on for users with past training jobs', async () => {
    mkdirSync(join(root(), 'jobs'), { recursive: true })
    writeFileSync(join(root(), 'jobs', 'jobs.json'), JSON.stringify([{ id: 'j1', kind: 'inference' }, { id: 'j2', kind: 'training' }]))
    writeSettings({ theme: 'dark' })
    expect((await load()).getSettings().trainingEnabled).toBe(true)
    vi.resetModules()
    writeFileSync(join(root(), 'jobs', 'jobs.json'), JSON.stringify([{ id: 'j1', kind: 'inference' }]))
    expect((await load()).getSettings().trainingEnabled).toBe(false)
  })

  it('keeps an explicit remote hosts / training choice', async () => {
    writeFileSync(join(root(), 'hosts.json'), JSON.stringify([{ id: 'ssh-a' }]))
    writeSettings({ remoteHostsEnabled: false, trainingEnabled: false })
    const settings = (await load()).getSettings()
    expect(settings.remoteHostsEnabled).toBe(false)
    expect(settings.trainingEnabled).toBe(false)
  })

  it('applies engineRoot to the engine path resolver', async () => {
    writeSettings({ engineRoot: join(root(), 'custom-engine') })
    const { getSettings } = await load()
    getSettings()
    const { paths } = await import('@main/lib/paths')
    expect(paths.mossinfer()).toBe(join(root(), 'custom-engine'))
  })
})

describe('updateSettings', () => {
  it('persists a patch, merging modelDirectories, and refreshes the cache', async () => {
    writeSettings({ modelDirectories: { dit: '/dit' } })
    const { updateSettings, getSettings } = await load()
    const next = updateSettings({ theme: 'light', modelDirectories: { vae: '/vae' } as never })
    expect(next.modelDirectories.dit).toBe('/dit')
    expect(next.modelDirectories.vae).toBe('/vae')
    expect(getSettings()).toBe(next)
    const stored = JSON.parse(readFileSync(join(root(), 'settings.json'), 'utf8'))
    expect(stored.theme).toBe('light')
    expect(stored.modelDirectories.dit).toBe('/dit')
    expect(existsSync(join(root(), 'settings.json.tmp'))).toBe(false)
  })

  it('deduplicates dismissed announcements and keeps only the newest 200', async () => {
    const { updateSettings } = await load()
    expect(updateSettings({ dismissedAnnouncements: ['a', 'b', 'a', 'c', 'b'] }).dismissedAnnouncements).toEqual(['a', 'b', 'c'])
    const many = Array.from({ length: 250 }, (_, index) => `id-${index}`)
    const capped = updateSettings({ dismissedAnnouncements: many }).dismissedAnnouncements
    expect(capped).toHaveLength(200)
    expect(capped[0]).toBe('id-50')
    expect(capped.at(-1)).toBe('id-249')
  })

  it('leaves dismissedAnnouncements alone when not in the patch', async () => {
    writeSettings({ dismissedAnnouncements: ['x', 'x'] })
    const { updateSettings } = await load()
    expect(updateSettings({ theme: 'dark' }).dismissedAnnouncements).toEqual(['x', 'x'])
  })

  it('updates the engine root override when engineRoot changes', async () => {
    const { updateSettings } = await load()
    const { paths } = await import('@main/lib/paths')
    updateSettings({ engineRoot: join(root(), 'e2') })
    expect(paths.mossinfer()).toBe(join(root(), 'e2'))
    updateSettings({ engineRoot: null })
    expect(paths.mossinfer()).toBe(join(root(), 'mossinfer'))
  })
})

describe('atomicWriteJson / readJson', () => {
  it('writes pretty JSON via a temp file that does not linger', async () => {
    const { atomicWriteJson } = await load()
    const file = join(root(), 'x.json')
    atomicWriteJson(file, { a: 1 })
    expect(readFileSync(file, 'utf8')).toBe('{\n  "a": 1\n}')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('overwrites an existing file', async () => {
    const { atomicWriteJson, readJson } = await load()
    const file = join(root(), 'x.json')
    atomicWriteJson(file, { a: 1 })
    atomicWriteJson(file, { b: 2 })
    expect(readJson(file, null)).toEqual({ b: 2 })
  })

  it('throws when the target directory does not exist', async () => {
    const { atomicWriteJson } = await load()
    expect(() => atomicWriteJson(join(root(), 'missing', 'x.json'), {})).toThrow()
  })

  it('returns the fallback for missing or corrupt files', async () => {
    const { readJson } = await load()
    const fallback = { fallback: true }
    expect(readJson(join(root(), 'nope.json'), fallback)).toBe(fallback)
    writeFileSync(join(root(), 'bad.json'), '{')
    expect(readJson(join(root(), 'bad.json'), fallback)).toBe(fallback)
    writeFileSync(join(root(), 'ok.json'), '[1,2]')
    expect(readJson(join(root(), 'ok.json'), fallback)).toEqual([1, 2])
  })
})
