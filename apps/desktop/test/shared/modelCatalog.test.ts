import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG_SCHEMA_VERSION, catalogProblems, entriesForApp, meetsMinimumVersion } from '@shared/modelCatalog'

/** The file released apps download from main: a change to it is live within minutes. */
const shipped = JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/models.json'), 'utf8')) as Record<string, unknown>

const part = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  provider: 'hf',
  repo: `org/${id}`,
  revision: 'main',
  role,
  precision: 'bf16',
  size_bytes: 10,
  files: ['*.safetensors'],
  license: 'MIT',
  ...extra,
})
const bundle = { id: 'b', name: 'B', description: '', components: { dit: 'd', textEncoder: 't', vae: 'v' }, support: 's' }
const valid = {
  schema_version: CATALOG_SCHEMA_VERSION,
  updated_at: '2026-11-10T00:00:00Z',
  models: [part('d', 'dit'), part('t', 'text_encoder'), part('v', 'vae'), part('s', 'support')],
  bundles: [bundle],
}

describe('models.json', () => {
  it('meets every rule, so released apps use it', () => {
    expect(catalogProblems(shipped)).toEqual([])
    expect(shipped['schema_version']).toBe(CATALOG_SCHEMA_VERSION)
  })
})

describe('catalogProblems', () => {
  it('accepts a complete catalog, with fields this app does not know', () => {
    expect(catalogProblems({ ...valid, future_field: true, models: valid.models.map((m) => ({ ...m, someday: 1 })) })).toEqual([])
  })

  it('names what is wrong', () => {
    const problems = (patch: Record<string, unknown>) => catalogProblems({ ...valid, ...patch })
    expect(problems({ schema_version: CATALOG_SCHEMA_VERSION + 1 })).toEqual([
      `schema_version ${CATALOG_SCHEMA_VERSION + 1} is newer than this app reads (${CATALOG_SCHEMA_VERSION})`,
    ])
    expect(problems({ models: [...valid.models, part('d', 'dit')] })).toEqual(['models: "d" appears twice'])
    expect(problems({ single_file_bundles: [bundle] })).toEqual(['bundles: "b" appears twice'])
    expect(problems({ bundles: [{ ...bundle, components: { ...bundle.components, vae: 'x' } }] })).toEqual([
      'bundle "b": vae "x" is not in models',
    ])
    expect(problems({ bundles: [{ ...bundle, components: { ...bundle.components, vae: 't' } }] })).toEqual([
      'bundle "b": vae "t" has role text_encoder, not vae',
    ])
    expect(problems({ bundles: [{ ...bundle, support: 'v' }] })).toEqual(['bundle "b": support "v" has role vae, not support'])
    expect(problems({ models: [part('d', 'dit', { revision: 'v1.0' }), ...valid.models.slice(1)] })).toEqual([
      'models.0.revision: not a 40-character commit hash or "main"',
    ])
    expect(problems({ models: [part('d', 'dit', { size_bytes: 0 }), ...valid.models.slice(1)] })[0]).toMatch(/^models\.0\.size_bytes: /)
    expect(problems({ models: [part('d', 'dit', { min_app_version: '2.1' }), ...valid.models.slice(1)] })).toEqual([
      'models.0.min_app_version: not a version like 2.1.0 or 2.1.0-beta.2',
    ])
    expect(problems({ models: [part('d', 'dit', { repo: 'https://huggingface.co/org/d' }), ...valid.models.slice(1)] })).toEqual([
      'models.0.repo: not an owner/name repository',
    ])
  })

  it('accepts a pinned commit', () => {
    expect(catalogProblems({ ...valid, models: [part('d', 'dit', { revision: 'a'.repeat(40) }), ...valid.models.slice(1)] })).toEqual([])
  })
})

describe('meetsMinimumVersion', () => {
  it.each([
    ['2.1.0', undefined, true],
    ['2.1.0', '2.1.0', true],
    ['2.0.9', '2.1.0', false],
    ['2.2.0', '2.1.0', true],
    // A prerelease of 2.1.0 has the code 2.1.0 ships…
    ['2.1.0-nightly.20261110', '2.1.0', true],
    ['2.1.0-beta.1', '2.1.0', true],
    // …unless the minimum names a prerelease itself.
    ['2.1.0-beta.1', '2.1.0-beta.2', false],
    ['2.1.0-beta.3', '2.1.0-beta.2', true],
    ['2.1.0', '2.1.0-beta.2', true],
    ['not a version', '2.1.0', false],
  ])('app %s, minimum %s → %s', (app, minimum, expected) => {
    expect(meetsMinimumVersion(app, minimum)).toBe(expected)
  })
})

describe('entriesForApp', () => {
  it('returns the catalog as it is when everything fits', () => {
    expect(entriesForApp(valid, '1.0.0')).toBe(valid)
  })

  it('leaves out a bundle whose part needs a newer app, in either bundle list', () => {
    const catalog = {
      models: [...valid.models, part('d2', 'dit', { min_app_version: '3.0.0' }), part('s2', 'support', { min_app_version: '3.0.0' })],
      bundles: [bundle, { ...bundle, id: 'b2', components: { ...bundle.components, dit: 'd2' } }],
      single_file_bundles: [{ ...bundle, id: 'b3', support: 's2' }],
      adapters: [{ id: 'a', min_app_version: '2.0.0' }],
    }
    const result = entriesForApp(catalog, '2.0.0')
    expect(result.models.map((m) => m.id)).toEqual(['d', 't', 'v', 's'])
    expect(result.bundles.map((b) => b.id)).toEqual(['b'])
    expect(result.single_file_bundles.map((b) => b.id)).toEqual([])
    expect(result.adapters.map((a) => a.id)).toEqual(['a'])
  })
})
