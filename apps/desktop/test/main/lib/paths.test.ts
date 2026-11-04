import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'

const root = useTempDataRoot()
const outside = useTempDir('mossstudio-outside-')

async function load() {
  return import('@main/lib/paths')
}

beforeEach(() => {
  vi.resetModules()
})

describe('root', () => {
  it('prefers MOSSSTUDIO_DATA over the data-root override', async () => {
    const { root: dataRoot, setDataRoot } = await load()
    setDataRoot(outside())
    expect(dataRoot()).toBe(resolve(root()))
  })

  it('uses the override, then electron userData when MOSSSTUDIO_DATA is blank', async () => {
    vi.stubEnv('MOSSSTUDIO_DATA', '   ')
    const { root: dataRoot, setDataRoot } = await load()
    expect(dataRoot()).toBe(root())
    setDataRoot(outside())
    expect(dataRoot()).toBe(resolve(outside()))
    setDataRoot(null)
    expect(dataRoot()).toBe(root())
  })
})

describe('engineRoot', () => {
  it('defaults under the data root and honours an override', async () => {
    const { engineRoot, setEngineRoot } = await load()
    expect(engineRoot()).toBe(join(root(), 'mossinfer'))
    setEngineRoot('relative-engine')
    expect(engineRoot()).toBe(resolve('relative-engine'))
    setEngineRoot(null)
    expect(engineRoot()).toBe(join(root(), 'mossinfer'))
  })
})

describe('modelStorageRoot', () => {
  it('maps each role to its default folder under the models root', async () => {
    const { modelStorageRoot } = await load()
    const models = join(root(), 'models')
    expect(modelStorageRoot('dit')).toBe(join(models, 'moss'))
    expect(modelStorageRoot('text_encoder')).toBe(join(models, 'text-encoder'))
    expect(modelStorageRoot('vae')).toBe(join(models, 'vae'))
    expect(modelStorageRoot('support')).toBe(join(models, 'support'))
    expect(modelStorageRoot('full')).toBe(models)
  })

  it('uses a custom models root and per-role directories (trimmed)', async () => {
    const { modelStorageRoot } = await load()
    const custom = outside()
    expect(modelStorageRoot('vae', custom)).toBe(join(custom, 'vae'))
    expect(modelStorageRoot('text_encoder', custom, { textEncoder: `  ${join(custom, 'te')}  ` })).toBe(join(custom, 'te'))
    expect(modelStorageRoot('dit', custom, { dit: '   ' })).toBe(join(custom, 'moss'))
  })

  it('ignores per-role directories for full models', async () => {
    const { modelStorageRoot } = await load()
    expect(modelStorageRoot('full', null, { dit: '/elsewhere' })).toBe(join(root(), 'models'))
  })

  it('places adapters under models/adapters unless a custom directory is set', async () => {
    const { adapterStorageRoot } = await load()
    expect(adapterStorageRoot()).toBe(join(root(), 'models', 'adapters'))
    expect(adapterStorageRoot(null, { adapters: outside() })).toBe(resolve(outside()))
  })
})

describe('paths helpers', () => {
  it('derives a stable, source-specific mirror directory', async () => {
    const { paths } = await load()
    const a = paths.mirrorForSource('https://example.com/a.git')
    expect(a).toBe(paths.mirrorForSource('https://example.com/a.git'))
    expect(a).not.toBe(paths.mirrorForSource('https://example.com/b.git'))
    expect(a).toMatch(/moss-image-[0-9a-f]{12}\.git$/)
  })

  it('resolves a custom trainer root', async () => {
    const { paths } = await load()
    expect(paths.trainerRoot()).toBe(join(root(), 'trainer'))
    expect(paths.trainerRoot(outside())).toBe(resolve(outside()))
  })
})

describe('isInside', () => {
  it.each([
    ['/a/b', '/a/b', true],
    ['/a/b', '/a/b/c', true],
    ['/a/b', '/a/b/../b/c', true],
    ['/a/b', '/a/bc', false],
    ['/a/b', '/a', false],
    ['/a/b', '/x/y', false],
    ['/a/b', '/a/b/..', false],
  ])('isInside(%s, %s) === %s', async (base, target, expected) => {
    const { isInside } = await load()
    expect(isInside(base, target)).toBe(expected)
  })
})

describe('ensureDirs', () => {
  it('creates the core and default model layout inside the data root', async () => {
    const { ensureDirs, paths } = await load()
    ensureDirs()
    for (const dir of [paths.git(), paths.instances(), paths.managedPython(), paths.cache(), paths.logs(), paths.mossinfer(),
      paths.trainerGit(), paths.trainerVersions(), paths.trainerRuntimes(), paths.hub(), paths.roleHub('dit'), paths.roleHub('vae'),
      paths.adapters(), paths.modelImports()]) {
      expect(existsSync(dir), dir).toBe(true)
    }
  })

  it('never creates model directories outside the data root', async () => {
    const { ensureDirs } = await load()
    const custom = join(outside(), 'models')
    const vae = join(outside(), 'vae')
    ensureDirs(custom, { vae })
    expect(existsSync(custom)).toBe(false)
    expect(existsSync(vae)).toBe(false)
    expect(existsSync(join(root(), 'cache'))).toBe(true)
  })

  it('still creates custom model directories that live inside the data root', async () => {
    const { ensureDirs } = await load()
    const custom = join(root(), 'my-models')
    ensureDirs(custom, { vae: join(outside(), 'vae') })
    expect(existsSync(join(custom, 'hf', 'hub'))).toBe(true)
    expect(existsSync(join(custom, 'moss', 'hf', 'hub'))).toBe(true)
    expect(existsSync(join(outside(), 'vae'))).toBe(false)
  })
})
