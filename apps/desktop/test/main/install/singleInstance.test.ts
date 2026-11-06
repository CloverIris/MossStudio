import { describe, expect, it, vi } from 'vitest'
import { app, BrowserWindow } from 'electron'
import { focusOnSecondInstance, secondInstanceAction } from '@main/install/singleInstance'

describe('secondInstanceAction', () => {
  it('focuses for a plain second start (the launcher forwarding args)', () => {
    expect(secondInstanceAction(undefined)).toBe('focus')
    expect(secondInstanceAction({})).toBe('focus')
    expect(secondInstanceAction({ moss: 'something-else' })).toBe('focus')
  })

  it('offers to close for setup and uninstall, stays quiet for silent runs', () => {
    expect(secondInstanceAction({ moss: 'setup' })).toBe('ask-close-for-setup')
    expect(secondInstanceAction({ moss: 'uninstall' })).toBe('ask-close-for-uninstall')
    expect(secondInstanceAction({ moss: 'silent' })).toBe('ignore')
  })
})

describe('focusOnSecondInstance', () => {
  it('brings the setup/uninstall window forward when a normal start hits the lock', () => {
    const win = new BrowserWindow()
    const show = vi.spyOn(win, 'show')
    const focus = vi.spyOn(win, 'focus')
    focusOnSecondInstance(() => win)
    ;(app as unknown as { emit(event: string, ...args: unknown[]): void }).emit('second-instance', {}, ['MossStudio'], '/', {})
    expect(show).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
    win.destroy()
    ;(app as unknown as { emit(event: string, ...args: unknown[]): void }).emit('second-instance', {}, [], '/', {})
    expect(focus).toHaveBeenCalledTimes(1)
  })
})
