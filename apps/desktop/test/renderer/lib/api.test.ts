import { afterEach, describe, expect, it } from 'vitest'
import { Events, Ipc } from '@shared/channels'
import { ApiError, call, onEvent, platform } from '@renderer/lib/api'
import { createMockBackend } from '../../mocks/backend'

let uninstall: () => void = () => undefined
afterEach(() => uninstall())

describe('lib/api', () => {
  it('call() unwraps ok results and forwards the payload', async () => {
    const backend = createMockBackend('ready')
    uninstall = backend.install()
    const job = await call(Ipc.jobGet, { id: 'missing' })
    expect(job).toBeNull()
    expect(backend.calls).toEqual([{ channel: Ipc.jobGet, payload: { id: 'missing' } }])
  })

  it('call() throws an ApiError carrying code and message', async () => {
    const backend = createMockBackend('ready')
    uninstall = backend.install()
    backend.fail(Ipc.settingsGet, { code: 'E_DENIED', message: 'nope' })
    const error = await call(Ipc.settingsGet).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ code: 'E_DENIED', message: 'nope' })
  })

  it('call() rejects when the bridge itself throws', async () => {
    const backend = createMockBackend('ready')
    uninstall = backend.install()
    backend.bridge.invoke = () => Promise.reject(new Error('ipc closed'))
    await expect(call(Ipc.settingsGet)).rejects.toThrow('ipc closed')
  })

  it('onEvent() delivers typed payloads and unsubscribes', () => {
    const backend = createMockBackend('ready')
    uninstall = backend.install()
    const seen: unknown[] = []
    const off = onEvent<{ section: string }>(Events.envProgress, (event) => seen.push(event.section))
    backend.emit(Events.envProgress, { section: 'gpu' })
    off()
    backend.emit(Events.envProgress, { section: 'network' })
    expect(seen).toEqual(['gpu'])
    expect(backend.listenerCount(Events.envProgress)).toBe(0)
  })

  it('platform() reports the bridge platform', () => {
    uninstall = createMockBackend('ready', { bridge: { platform: 'linux' } }).install()
    expect(platform()).toBe('linux')
  })
})
