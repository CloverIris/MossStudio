import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updateStateFixture, settingsFixture } from '@test/mocks/backend/fixtures'

// The shared electron mock's app has no `off`; use an EventEmitter that does.
const app = new EventEmitter()
const checkUpdates = vi.fn(async (..._args: unknown[]) => updateStateFixture())
const emitted: unknown[] = []
vi.mock('electron', () => ({ app }))
vi.mock('@main/services/updates', () => ({ checkUpdates: (...args: unknown[]) => checkUpdates(...args) }))
vi.mock('@main/services/settings', () => ({ getSettings: () => settingsFixture() }))
vi.mock('@main/lib/events', () => ({ emit: (_channel: string, payload: unknown) => emitted.push(payload) }))

let api: typeof import('@main/services/updateWatcher')
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  app.removeAllListeners()
  checkUpdates.mockClear()
  emitted.length = 0
  api = await import('@main/services/updateWatcher')
})
afterEach(() => {
  api.stopUpdateWatcher()
  vi.useRealTimers()
})

describe('update watcher', () => {
  it('re-checks on the 45 minute interval with a forced read and pushes the state', async () => {
    api.startUpdateWatcher()
    await vi.advanceTimersByTimeAsync(45 * 60_000 - 1)
    expect(checkUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(checkUpdates).toHaveBeenCalledWith(expect.anything(), { force: true })
    expect(emitted).toHaveLength(1)
  })

  it('honours CLOVER_UPDATE_WATCH_MS but ignores values under one second', async () => {
    vi.stubEnv('CLOVER_UPDATE_WATCH_MS', '2000')
    api.startUpdateWatcher()
    await vi.advanceTimersByTimeAsync(4000)
    expect(checkUpdates).toHaveBeenCalledTimes(2)
    api.stopUpdateWatcher()
    checkUpdates.mockClear()
    vi.stubEnv('CLOVER_UPDATE_WATCH_MS', '10')
    api.startUpdateWatcher()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(checkUpdates).not.toHaveBeenCalled()
  })

  it('re-checks on window focus only after the throttle gap, counting manual checks', async () => {
    api.startUpdateWatcher()
    app.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(checkUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    api.markUpdateCheck()
    app.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(checkUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    app.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(checkUpdates).toHaveBeenCalledOnce()
  })

  it('does not overlap refreshes and survives a failing check', async () => {
    let finish: () => void = () => undefined
    checkUpdates.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(updateStateFixture()) }))
    api.refreshUpdatesNow()
    api.refreshUpdatesNow()
    expect(checkUpdates).toHaveBeenCalledOnce()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    checkUpdates.mockRejectedValueOnce(new Error('boom'))
    api.refreshUpdatesNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(error).toHaveBeenCalled()
    api.refreshUpdatesNow()
    expect(checkUpdates).toHaveBeenCalledTimes(3)
  })

  it('starts once and stops cleanly', async () => {
    api.startUpdateWatcher()
    api.startUpdateWatcher()
    expect(app.listenerCount('browser-window-focus')).toBe(1)
    api.stopUpdateWatcher()
    expect(app.listenerCount('browser-window-focus')).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * 45 * 60_000)
    expect(checkUpdates).not.toHaveBeenCalled()
  })
})
