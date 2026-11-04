import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { launchRowFixture } from '@test/mocks/backend/fixtures'

const root = useTempDataRoot()
const file = () => join(root(), 'launch-queue.json')
const stored = () => JSON.parse(readFileSync(file(), 'utf8')) as Array<Record<string, unknown>>

beforeEach(() => vi.resetModules())
const load = () => import('@main/services/launchQueue')

describe('launch queue', () => {
  it('starts empty without a file and tolerates corrupt or non-array JSON', async () => {
    expect((await load()).listLaunchRows()).toEqual([])
    vi.resetModules()
    writeFileSync(file(), '{')
    expect((await load()).listLaunchRows()).toEqual([])
    vi.resetModules()
    writeFileSync(file(), '{"a":1}')
    expect((await load()).listLaunchRows()).toEqual([])
  })

  it('migrates legacy rows, drops invalid ones and rewrites retired fields', async () => {
    writeFileSync(file(), JSON.stringify([
      { id: 'r1', instanceId: 'inst', backend: 'gradio', port: 7860, extraArgs: '--x', state: 'queued', profile: 'dmd8', queuedAt: '2026-01-01T00:00:00Z' },
      { id: 'r2', instanceId: 'inst', state: 'weird', workspace: 'official', queuedAt: '2026-01-02T00:00:00Z', caseName: '' },
      { id: 'missing-instance' },
      { instanceId: 'missing-id' },
    ]))
    const rows = (await load()).listLaunchRows()
    expect(rows.map((row) => row.id)).toEqual(['r2', 'r1'])
    expect(rows.find((row) => row.id === 'r1')).toEqual({
      id: 'r1', caseId: undefined, caseName: 'inst', instanceId: 'inst', instanceName: 'inst', workspace: 'clover', deviceId: 'mps',
      profile: 'dmd8', jobId: undefined, state: 'queued', queuedAt: '2026-01-01T00:00:00Z', startedAt: undefined, error: undefined,
    })
    expect(rows.find((row) => row.id === 'r2')).toMatchObject({ state: 'failed', profile: 'base', workspace: 'clover', caseName: 'inst' })
    const rewritten = stored()
    expect(rewritten).toHaveLength(2)
    expect(rewritten.some((row) => 'backend' in row || 'port' in row || 'extraArgs' in row)).toBe(false)
  })

  it('marks rows interrupted by a restart as failed and persists that', async () => {
    writeFileSync(file(), JSON.stringify([
      launchRowFixture({ id: 'a', state: 'running' }),
      launchRowFixture({ id: 'b', state: 'starting' }),
      launchRowFixture({ id: 'c', state: 'queued' }),
    ]))
    const rows = (await load()).listLaunchRows()
    expect(Object.fromEntries(rows.map((row) => [row.id, row.state]))).toEqual({ a: 'failed', b: 'failed', c: 'queued' })
    expect(rows.find((row) => row.id === 'a')!.error).toBe('应用重启，任务已中断')
    expect(stored().filter((row) => row.state === 'failed')).toHaveLength(2)
  })

  it('sorts by startedAt, falling back to queuedAt, newest first', async () => {
    const { upsertLaunchRow, listLaunchRows } = await load()
    upsertLaunchRow(launchRowFixture({ id: 'old', queuedAt: '2026-01-01T00:00:00Z', startedAt: undefined }))
    upsertLaunchRow(launchRowFixture({ id: 'started', queuedAt: '2025-01-01T00:00:00Z', startedAt: '2026-03-01T00:00:00Z' }))
    upsertLaunchRow(launchRowFixture({ id: 'new', queuedAt: '2026-02-01T00:00:00Z', startedAt: undefined }))
    expect(listLaunchRows().map((row) => row.id)).toEqual(['started', 'new', 'old'])
  })

  it('upserts by id, returns a copy and removes rows', async () => {
    const { upsertLaunchRow, listLaunchRows, removeLaunchRow } = await load()
    const row = launchRowFixture({ id: 'x', state: 'queued' })
    const returned = upsertLaunchRow(row)
    expect(returned).not.toBe(row)
    upsertLaunchRow({ ...row, state: 'stopped' })
    expect(listLaunchRows()).toHaveLength(1)
    expect(listLaunchRows()[0]!.state).toBe('stopped')
    removeLaunchRow('x')
    expect(listLaunchRows()).toEqual([])
    expect(stored()).toEqual([])
  })
})
