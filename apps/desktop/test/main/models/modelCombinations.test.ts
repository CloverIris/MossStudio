import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelEntry } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'

const dataRoot = useTempDataRoot()
type Store = typeof import('@main/services/modelCombinations')
let store: Store

const own = (id: string, role: ModelEntry['role']): ModelEntry => ({
  id,
  name: id,
  provider: 'local',
  repo: id,
  revision: 'local',
  role,
  format: 'comfyui',
  family: 'local',
  precision: 'local',
  license: 'local',
  tags: [],
  installed: true,
  installedBytes: 1,
  sizeBytes: 1,
})
const file = (): string => join(dataRoot(), 'model-combinations.json')
const parts = { dit: 'd', textEncoder: 't', vae: 'v' }

beforeEach(async () => {
  vi.resetModules()
  store = await import('@main/services/modelCombinations')
})

describe('model combinations', () => {
  it('saves, renames and deletes a combination', () => {
    const saved = store.saveCombination({ name: '  我的组合 ', components: parts })
    expect(saved).toMatchObject({ id: expect.stringMatching(/^combo-[a-f0-9]{8}$/), name: '我的组合', components: parts })
    const renamed = store.saveCombination({ id: saved.id, name: '新名字', components: { ...parts, vae: 'v2' } })
    expect(renamed).toEqual({ ...saved, name: '新名字', components: { ...parts, vae: 'v2' } })
    expect(store.listCombinations()).toEqual([renamed])
    store.deleteCombination(saved.id)
    expect(store.listCombinations()).toEqual([])
  })

  it('ignores a damaged file and malformed entries', () => {
    writeFileSync(file(), '{nope')
    expect(store.listCombinations()).toEqual([])
    writeFileSync(file(), JSON.stringify([{ id: 'x' }, { id: 'ok', name: 'ok', createdAt: '', components: parts }]))
    expect(store.listCombinations().map((entry) => entry.id)).toEqual(['ok'])
  })

  it('keeps the old scanned-files model once, and never brings it back after it is deleted', () => {
    const trio = [own('d', 'dit'), own('t', 'text_encoder'), own('v', 'vae')]
    expect(store.catalogCombinations(trio).map((entry) => entry.id)).toEqual(['local-files'])
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toHaveLength(1)
    store.deleteCombination('local-files')
    expect(store.catalogCombinations(trio)).toEqual([])
  })

  it('writes nothing when there is nothing to keep', () => {
    expect(store.catalogCombinations([own('d', 'dit')])).toEqual([])
    expect(() => readFileSync(file())).toThrow()
  })
})
