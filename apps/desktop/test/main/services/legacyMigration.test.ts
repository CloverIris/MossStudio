import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot } from '@test/helpers/tempDir'

const root = useTempDataRoot()
beforeEach(() => vi.resetModules())
const load = () => import('@main/services/legacyMigration')

describe('archiveLegacyInferenceData', () => {
  it('writes a marker and archives nothing on a clean install', async () => {
    const { archiveLegacyInferenceData } = await load()
    expect(archiveLegacyInferenceData()).toEqual({ archived: false })
    const marker = JSON.parse(readFileSync(join(root(), '.legacy-inference-archived'), 'utf8'))
    expect(marker.archivedAt).toEqual(expect.any(String))
    expect(marker.archive).toBeUndefined()
  })

  it('moves instances/runtimes/git into a dated archive with a README, leaving trainer alone', async () => {
    for (const dir of ['instances/a', 'git/moss-image.git', 'trainer/versions']) mkdirSync(join(root(), dir), { recursive: true })
    writeFileSync(join(root(), 'instances', 'a', 'file.txt'), 'x')
    writeFileSync(join(root(), 'git', 'moss-image.git', 'HEAD'), 'ref: refs/heads/main')
    const { archiveLegacyInferenceData } = await load()
    const result = archiveLegacyInferenceData()
    expect(result.archived).toBe(true)
    expect(result.archive).toMatch(/legacy-inference-\d{4}-\d{2}-\d{2}$/)
    expect(readFileSync(join(result.archive!, 'instances', 'a', 'file.txt'), 'utf8')).toBe('x')
    expect(existsSync(join(result.archive!, 'git', 'moss-image.git'))).toBe(true)
    expect(existsSync(join(result.archive!, 'runtimes'))).toBe(false)
    expect(existsSync(join(result.archive!, 'README.txt'))).toBe(true)
    expect(existsSync(join(root(), 'instances'))).toBe(false)
    expect(existsSync(join(root(), 'trainer', 'versions'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root(), '.legacy-inference-archived'), 'utf8')).archive).toBe(result.archive)
  })

  it('a fresh data root with only the empty skeleton folders gets no archive', async () => {
    for (const dir of ['instances', 'git', 'runtimes/python']) mkdirSync(join(root(), dir), { recursive: true })
    const { archiveLegacyInferenceData } = await load()
    expect(archiveLegacyInferenceData()).toEqual({ archived: false })
    expect(readdirSync(root()).filter((name) => name.startsWith('legacy-inference-'))).toEqual([])
    expect(existsSync(join(root(), 'runtimes', 'python'))).toBe(true)
  })

  it('runs only once', async () => {
    const { archiveLegacyInferenceData } = await load()
    archiveLegacyInferenceData()
    mkdirSync(join(root(), 'instances'))
    expect(archiveLegacyInferenceData()).toEqual({ archived: false })
    expect(existsSync(join(root(), 'instances'))).toBe(true)
  })
})
