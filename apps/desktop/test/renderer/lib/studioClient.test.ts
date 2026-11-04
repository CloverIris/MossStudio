import { afterEach, describe, expect, it, vi } from 'vitest'
import { Ipc } from '@shared/channels'
import { WebStudioClient, electronStudioClient } from '@renderer/lib/studioClient'
import { canvasFixture, createMockBackend, projectFixture, scenario } from '../../mocks/backend'

let uninstall: () => void = () => undefined
afterEach(() => uninstall())

describe('electronStudioClient', () => {
  it('lists, saves and reloads projects through IPC', async () => {
    const backend = createMockBackend(scenario('ready', { projects: [projectFixture()] }))
    uninstall = backend.install()
    expect(await electronStudioClient.listProjects()).toEqual([
      { id: 'project-1', name: 'Project 1', width: 1024, height: 1024, layerCount: 0, seriesId: undefined, page: undefined, updatedAt: '2026-11-01T00:00:00.000Z' },
    ])
    const saved = await electronStudioClient.saveProject({ name: 'New', canvases: [canvasFixture({ id: 'c2' })] })
    expect(saved).toMatchObject({ schemaVersion: 3, name: 'New', id: 'project-2' })
    expect(await electronStudioClient.getProject(saved.id)).toEqual(saved)
    expect(await electronStudioClient.getProject('missing')).toBeNull()
    expect(backend.callsTo(Ipc.projectGet)).toEqual([{ id: 'project-2' }, { id: 'missing' }])
    expect(await electronStudioClient.backendInfo()).toEqual({ ready: true, url: 'http://studio-fixture', token: 'fixture' })
  })
})

describe('WebStudioClient', () => {
  function stubFetch(response: Response | (() => Response)) {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (typeof response === 'function' ? response() : response))
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('sends the bearer token and JSON content type to the trimmed base URL', async () => {
    const fetch = stubFetch(() => new Response(JSON.stringify([]), { status: 200 }))
    const client = new WebStudioClient('http://192.168.1.5:7860/', 'tok')
    expect(await client.listProjects()).toEqual([])
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://192.168.1.5:7860/api/projects')
    expect(init!.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' })
  })

  it('encodes project ids and POSTs saves as JSON', async () => {
    const fetch = stubFetch(() => new Response(JSON.stringify(projectFixture()), { status: 200 }))
    const client = new WebStudioClient('http://host', 't')
    await client.getProject('a/b c')
    await client.saveProject({ name: 'n', canvases: [] })
    expect(fetch.mock.calls[0]![0]).toBe('http://host/api/projects/a%2Fb%20c')
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ name: 'n', canvases: [] }) })
  })

  it('surfaces the server error message, or the HTTP status when the body is not JSON', async () => {
    const client = new WebStudioClient('http://host', 't')
    stubFetch(new Response(JSON.stringify({ error: 'token expired' }), { status: 401 }))
    await expect(client.listProjects()).rejects.toThrow('token expired')
    stubFetch(new Response('<html>', { status: 502 }))
    await expect(client.listProjects()).rejects.toThrow('HTTP 502')
    stubFetch(new Response(JSON.stringify({}), { status: 500 }))
    await expect(client.listProjects()).rejects.toThrow('HTTP 500')
  })

  it('reports its own connection as backend info without a request', async () => {
    const fetch = stubFetch(new Response('{}'))
    expect(await new WebStudioClient('http://host', 't').backendInfo()).toEqual({ ready: true, url: 'http://host', token: 't' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
