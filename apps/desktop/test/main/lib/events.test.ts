import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow as BrowserWindowType } from '@test/mocks/electron'

// Reload electron alongside events so both share one fake window registry.
let BrowserWindow: typeof BrowserWindowType

beforeEach(async () => {
  vi.resetModules()
  BrowserWindow = ((await import('electron')) as unknown as typeof import('@test/mocks/electron')).BrowserWindow
  BrowserWindow.reset()
})
afterEach(() => BrowserWindow.reset())

describe('emit', () => {
  it('sends to every live window and skips destroyed ones', async () => {
    const { emit } = await import('@main/lib/events')
    const a = new BrowserWindow()
    const b = new BrowserWindow()
    const gone = new BrowserWindow()
    gone.destroy()
    emit('event:x', { n: 1 })
    expect(a.webContents.sent).toEqual([{ channel: 'event:x', payload: { n: 1 } }])
    expect(b.webContents.sent).toHaveLength(1)
    expect(gone.webContents.sent).toHaveLength(0)
  })

  it('skips a window whose isDestroyed reports true even if still listed', async () => {
    const { emit } = await import('@main/lib/events')
    const win = new BrowserWindow()
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([win])
    vi.spyOn(win, 'isDestroyed').mockReturnValue(true)
    emit('event:x', 1)
    expect(win.webContents.sent).toHaveLength(0)
  })

  it('notifies listeners, swallows listener errors and supports unsubscribe', async () => {
    const { emit, onEmit } = await import('@main/lib/events')
    const calls: Array<[string, unknown]> = []
    onEmit(() => {
      throw new Error('boom')
    })
    const off = onEmit((channel, payload) => calls.push([channel, payload]))
    expect(() => emit('event:a', 1)).not.toThrow()
    expect(calls).toEqual([['event:a', 1]])
    off()
    emit('event:b', 2)
    expect(calls).toHaveLength(1)
  })

  it('still delivers to later listeners after one throws', async () => {
    const { emit, onEmit } = await import('@main/lib/events')
    const later = vi.fn()
    onEmit(() => {
      throw new Error('first fails')
    })
    onEmit(later)
    emit('event:c', 'x')
    expect(later).toHaveBeenCalledWith('event:c', 'x')
  })
})
