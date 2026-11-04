import { beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsFixture, sshHostFixture } from '@test/mocks/backend/fixtures'
import type { TrainingHost } from '@shared/types'

const state = {
  token: undefined as string | undefined,
  hosts: [] as TrainingHost[],
  remote: vi.fn<(hostId: string, url: string, endpoint: string) => Promise<{ body: string; headers: Record<string, string> }>>(),
}
vi.mock('@main/services/hfCredentials', () => ({ getHfToken: () => state.token }))
vi.mock('@main/services/trainingHosts', () => ({ listTrainingHosts: () => [{ id: 'local', kind: 'local' }, ...state.hosts] }))
vi.mock('@main/services/remoteDownloads', () => ({ queryRemoteHf: (...args: [string, string, string]) => state.remote(...args) }))

const { fetchHf } = await import('@main/services/hfNetwork')
const url = 'https://huggingface.co/api/models/x'
const endpoint = 'https://huggingface.co'

beforeEach(() => {
  state.token = undefined
  state.hosts = []
  state.remote.mockReset()
})

describe('fetchHf', () => {
  it('returns the local response and sends the token as a bearer header', async () => {
    state.token = 'hf_x'
    const fetch = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    const response = await fetchHf(url, endpoint, settingsFixture())
    expect(await response.text()).toBe('ok')
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ headers: { authorization: 'Bearer hf_x' } }))
  })

  it('omits headers without a token', async () => {
    const fetch = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    await fetchHf(url, endpoint, settingsFixture())
    expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ headers: undefined })
  })

  it('rethrows the local error when no SSH host can help or the user pinned local', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(fetchHf(url, endpoint, settingsFixture())).rejects.toThrow('HF HTTP 503')
    state.hosts = [sshHostFixture({ id: 'ssh-a' })]
    await expect(fetchHf(url, endpoint, settingsFixture({ hfQueryHostId: 'local' }))).rejects.toThrow('HF HTTP 503')
    expect(state.remote).not.toHaveBeenCalled()
  })

  it('falls back to SSH hosts, healthy ones first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    state.hosts = [sshHostFixture({ id: 'bad', status: 'error' }), sshHostFixture({ id: 'good', status: 'ok' })]
    state.remote.mockImplementation(async (hostId) => {
      if (hostId === 'good') throw new Error('remote down')
      return { body: '{"remote":true}', headers: { 'content-type': 'application/json' } }
    })
    const response = await fetchHf(url, endpoint, settingsFixture())
    expect(state.remote.mock.calls.map(([hostId]) => hostId)).toEqual(['good', 'bad'])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ remote: true })
  })

  it('only asks the pinned SSH host and reports both failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    state.hosts = [sshHostFixture({ id: 'a' }), sshHostFixture({ id: 'b' })]
    state.remote.mockRejectedValue(new Error('remote down'))
    await expect(fetchHf(url, endpoint, settingsFixture({ hfQueryHostId: 'b' }))).rejects.toThrow('本机 HF 查询失败（offline）；远端查询失败（remote down）')
    expect(state.remote.mock.calls.map(([hostId]) => hostId)).toEqual(['b'])
  })

  it('stops immediately when the caller aborts', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); throw new Error('aborted') }))
    state.hosts = [sshHostFixture({ id: 'a' })]
    await expect(fetchHf(url, endpoint, settingsFixture(), controller.signal)).rejects.toThrow()
    expect(state.remote).not.toHaveBeenCalled()
  })
})
