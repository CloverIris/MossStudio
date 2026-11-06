import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot } from '@test/helpers/tempDir'

const instances = new Map<string, { id: string; name: string }>()
vi.mock('@main/services/instances', () => ({ getInstance: async (id: string) => instances.get(id) ?? null }))

const root = useTempDataRoot()
const file = () => join(root(), 'cases.json')

beforeEach(() => {
  vi.resetModules()
  instances.clear()
  instances.set('inst', { id: 'inst', name: 'Instance' })
})
const load = () => import('@main/services/cases')
const input = { name: '', instanceId: 'inst', workspace: 'clover' as const, deviceId: 'cuda:0', profile: 'base' as const }

describe('cases', () => {
  it('migrates stored cases and rewrites retired fields once', async () => {
    writeFileSync(
      file(),
      JSON.stringify([
        { id: 'c1', instanceId: 'inst', name: '  ', backend: 'gradio', port: 1, createdAt: '2026-01-01T00:00:00Z', profile: 'dmd8' },
        {
          id: 'c2',
          instanceId: 'inst',
          name: 'Named',
          workspace: 'official',
          deviceId: 'cuda:1',
          createdAt: '2026-01-02T00:00:00Z',
          lastUsedAt: '2026-05-01T00:00:00Z',
        },
        { id: 'broken' },
      ]),
    )
    const cases = (await load()).listCases()
    expect(cases.map((item) => item.id)).toEqual(['c2', 'c1'])
    expect(cases[1]).toEqual({
      id: 'c1',
      name: 'inst',
      instanceId: 'inst',
      workspace: 'clover',
      deviceId: 'mps',
      profile: 'dmd8',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: undefined,
    })
    expect(cases[0]).toMatchObject({ name: 'Named', workspace: 'clover', deviceId: 'cuda:1', profile: 'base' })
    const stored = JSON.parse(readFileSync(file(), 'utf8')) as Array<Record<string, unknown>>
    expect(stored.some((item) => 'backend' in item || 'port' in item)).toBe(false)
  })

  it('tolerates a corrupt file', async () => {
    writeFileSync(file(), 'nope')
    expect((await load()).listCases()).toEqual([])
  })

  it('creates a case named after the instance and rejects unknown instances', async () => {
    const { saveCase, listCases } = await load()
    const created = await saveCase(input)
    expect(created.id).toMatch(/^case-[0-9a-f]{8}$/)
    expect(created.name).toBe('Instance · MossStudio')
    expect(created.lastUsedAt).toBe(created.createdAt)
    await expect(saveCase({ ...input, instanceId: 'missing' })).rejects.toThrow('实例不存在')
    expect(listCases()).toHaveLength(1)
  })

  it('updates an existing case in place, keeping its name when the new one is blank', async () => {
    const { saveCase, listCases } = await load()
    const created = await saveCase({ ...input, name: '  First  ' })
    expect(created.name).toBe('First')
    const updated = await saveCase({ ...input, id: created.id, name: ' ', profile: 'dmd8', deviceId: 'cpu' })
    expect(updated).toMatchObject({ id: created.id, name: 'First', profile: 'dmd8', deviceId: 'cpu', createdAt: created.createdAt })
    expect(listCases()).toHaveLength(1)
  })

  it('creates a new case when the id does not exist, and removes cases', async () => {
    const { saveCase, removeCase, listCases } = await load()
    const created = await saveCase({ ...input, id: 'ghost' })
    expect(created.id).not.toBe('ghost')
    removeCase(created.id)
    expect(listCases()).toEqual([])
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual([])
  })
})
