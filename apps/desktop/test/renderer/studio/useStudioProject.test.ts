import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { JobRecord, ProjectDocument, ProjectSummary } from '@shared/types'
import type { StudioClient, StudioProjectInput } from '@renderer/lib/studioClient'
import { useStudioProject, type StudioProject } from '@renderer/pages/studio/useStudioProject'
import { canvas } from './fixtures'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

function doc(id: string, patch: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    schemaVersion: 3, id, name: id, canvases: [canvas({ id: `${id}-c`, prompt: id, seedLocked: false })],
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...patch,
  }
}

/** In-memory projects; `saveProject` can be made to fail or to wait. */
function fakeClient(initial: ProjectDocument[]) {
  const projects = new Map(initial.map((item) => [item.id, item]))
  const log: string[] = []
  let next = 1
  const control = { fail: false, hold: null as null | Promise<void> }
  const client: StudioClient = {
    listProjects: async () => [...projects.values()].map((item): ProjectSummary => ({
      id: item.id, name: item.name, width: 1024, height: 1024, layerCount: 0, updatedAt: item.updatedAt,
    })),
    getProject: async (id) => projects.get(id) ?? null,
    saveProject: async (input: StudioProjectInput) => {
      log.push(`save:${input.id ?? 'new'}`)
      if (control.hold) await control.hold
      if (control.fail) throw new Error('disk full')
      const id = input.id && projects.has(input.id) ? input.id : `project-new-${next++}`
      const saved = doc(id, { name: input.name, canvases: input.canvases, selectedCanvasId: input.selectedCanvasId, updatedAt: `2026-11-02T00:00:${String(next++).padStart(2, '0')}.000Z` })
      projects.set(id, saved)
      return saved
    },
    deleteProject: async (id) => {
      log.push(`delete:${id}`)
      projects.delete(id)
    },
    backendInfo: async () => ({ ready: true, url: 'http://x', token: 't' }),
  }
  return { client, projects, log, control }
}

const NO_JOBS: JobRecord[] = []
let root: Root | null = null

async function mount(client: StudioClient): Promise<{ get: () => StudioProject; errors: string[]; unmount: () => void; setJobs: (jobs: JobRecord[]) => Promise<void> }> {
  const errors: string[] = []
  let current: StudioProject | null = null
  function Probe({ jobs }: { jobs: JobRecord[] }): null {
    current = useStudioProject({ jobs, onError: (message) => errors.push(message), client })
    return null
  }
  root = createRoot(document.createElement('div'))
  await act(async () => { root!.render(createElement(Probe, { jobs: NO_JOBS })) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return {
    get: () => current!,
    errors,
    unmount: () => act(() => root!.unmount()),
    setJobs: async (jobs) => { await act(async () => { root!.render(createElement(Probe, { jobs })) }) },
  }
}

/** Unmount and let the flush (which reads the file first) finish. */
async function unmountAndSettle(unmount: () => void): Promise<void> {
  unmount()
  root = null
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.useRealTimers()
})

describe('useStudioProject', () => {
  it('opens the most recent project and migrates old seeds', async () => {
    const old = doc('a', { canvases: [canvas({ id: 'kept', seed: 1234 }), canvas({ id: 'default', seed: 42 })] })
    const { client } = fakeClient([old])
    const { get } = await mount(client)
    expect(get().projectId).toBe('a')
    expect(get().canvases.map((item) => [item.id, item.seedLocked])).toEqual([['kept', true], ['default', false]])
  })

  it('stays on the project, edits intact, when saving before a switch fails', async () => {
    const fake = fakeClient([doc('a'), doc('b')])
    const { get, errors } = await mount(fake.client)
    const openId = get().projectId!
    const otherId = openId === 'a' ? 'b' : 'a'
    await act(async () => { get().updateCanvas(`${openId}-c`, { prompt: 'unsaved edit' }) })
    fake.control.fail = true
    await act(async () => { await get().openProject(otherId) })
    expect(get().projectId).toBe(openId)
    expect(get().canvases[0]!.prompt).toBe('unsaved edit')
    expect(errors.some((message) => message.includes('还没保存'))).toBe(true)

    await act(async () => { await get().newProject() })
    expect(get().projectId).toBe(openId)
    expect(get().canvases[0]!.prompt).toBe('unsaved edit')
  })

  it('switches after a successful save of pending edits', async () => {
    const fake = fakeClient([doc('a'), doc('b')])
    const { get } = await mount(fake.client)
    const openId = get().projectId!
    const otherId = openId === 'a' ? 'b' : 'a'
    await act(async () => { get().updateCanvas(`${openId}-c`, { prompt: 'kept' }) })
    await act(async () => { await get().openProject(otherId) })
    expect(get().projectId).toBe(otherId)
    expect(fake.projects.get(openId)!.canvases[0]!.prompt).toBe('kept')
  })

  it('never writes a deleted project back, whether a save is pending, queued or in flight', async () => {
    const fake = fakeClient([doc('a')])
    const { get } = await mount(fake.client)
    // Only the autosave timer is faked; promises still resolve normally.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => { get().updateCanvas('a-c', { prompt: 'edit 1' }) })
    // One save in flight, one queued behind it, and the autosave timer pending.
    let release!: () => void
    fake.control.hold = new Promise<void>((resolve) => { release = resolve })
    let deleting!: Promise<void>
    await act(async () => {
      void get().saveNow()
      // Let the first save reach the client, so it is truly in flight.
      for (let tick = 0; tick < 5 && !fake.log.includes('save:a'); tick += 1) await Promise.resolve()
      void get().saveNow()
      get().updateCanvas('a-c', { prompt: 'edit 2' })
      deleting = get().deleteProject('a')
    })
    fake.control.hold = null
    await act(async () => { release(); await deleting })
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(fake.log.filter((entry) => entry.startsWith('save:a'))).toEqual(['save:a'])
    expect(fake.log.indexOf('delete:a')).toBeGreaterThan(fake.log.indexOf('save:a'))
    expect(fake.projects.has('a')).toBe(false)
    expect([...fake.projects.keys()]).toEqual([])
    expect(get().projectId).toBeNull()
  })

  it('saves a pending edit when the Studio unmounts', async () => {
    const fake = fakeClient([doc('a')])
    const { get, unmount } = await mount(fake.client)
    await act(async () => { get().updateCanvas('a-c', { prompt: 'before leaving' }) })
    await unmountAndSettle(unmount)
    expect(fake.projects.get('a')!.canvases[0]!.prompt).toBe('before leaving')
  })

  it('does not write on unmount when only job progress changed the canvases', async () => {
    const fake = fakeClient([doc('a', { canvases: [canvas({ id: 'a-c', prompt: 'a', jobId: 'j1', jobState: 'running', seedLocked: false })] })])
    const { get, unmount, setJobs } = await mount(fake.client)
    await setJobs([{ id: 'j1', state: 'canceled' } as JobRecord])
    expect(get().canvases[0]!.jobState).toBe('canceled')
    await unmountAndSettle(unmount)
    expect(fake.log.filter((entry) => entry.startsWith('save'))).toEqual([])
  })

  it('never writes an older copy over a file that changed on disk since it was read', async () => {
    const fake = fakeClient([doc('a')])
    const { get, unmount } = await mount(fake.client)
    await act(async () => { get().updateCanvas('a-c', { prompt: 'local edit' }) })
    // Someone else (another window, the LAN web UI, a test) writes the project.
    const newer = doc('a', { name: 'a', updatedAt: '2026-11-03T00:00:00.000Z', canvases: [canvas({ id: 'a-c', prompt: 'written elsewhere' }), canvas({ id: 'extra' })] })
    fake.projects.set('a', newer)
    await unmountAndSettle(unmount)
    expect(fake.log.filter((entry) => entry.startsWith('save'))).toEqual([])
    expect(fake.projects.get('a')).toBe(newer)
  })
})
