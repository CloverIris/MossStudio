import { beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsFixture } from '@test/mocks/backend/fixtures'

type FakeNotification = (typeof import('@test/mocks/electron'))['Notification']

const state = { enabled: true }
const openWindow = vi.fn(() => ({ show: vi.fn(), focus: vi.fn() }))
vi.mock('@main/services/settings', () => ({ getSettings: () => settingsFixture({ desktopNotifications: state.enabled }) }))
vi.mock('@main/windows', () => ({ openWindow: (...args: unknown[]) => openWindow(...(args as [])) }))

const Notification = (await import('electron')).Notification as unknown as FakeNotification
const { pushLocalNotification, pushTestNotification, localNotificationsSupported } = await import('@main/services/desktopNotifications')

beforeEach(() => {
  state.enabled = true
  Notification.shown.length = 0
  openWindow.mockClear()
})

describe('desktop notifications', () => {
  it('shows a notification and focuses the requested window on click', async () => {
    const created: InstanceType<FakeNotification>[] = []
    const show = vi.spyOn(Notification.prototype, 'show').mockImplementation(function (this: InstanceType<FakeNotification>) {
      created.push(this)
      Notification.shown.push(this.options)
    })
    expect(pushLocalNotification({ title: 'T', body: 'B', windowKind: 'trainer', route: '/jobs' })).toBe(true)
    expect(show).toHaveBeenCalledOnce()
    expect(Notification.shown).toEqual([{ title: 'T', body: 'B', silent: false }])
    created[0]!.emit('click')
    expect(openWindow).toHaveBeenCalledWith('trainer', '/jobs')
    const win = openWindow.mock.results[0]!.value
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('defaults to the studio window', () => {
    const created: InstanceType<FakeNotification>[] = []
    vi.spyOn(Notification.prototype, 'show').mockImplementation(function (this: InstanceType<FakeNotification>) {
      created.push(this)
    })
    pushLocalNotification({ title: 'T', body: 'B' })
    created[0]!.emit('click')
    expect(openWindow).toHaveBeenCalledWith('studio', undefined)
  })

  it('respects the setting and platform support', () => {
    state.enabled = false
    expect(pushLocalNotification({ title: 'T', body: 'B' })).toBe(false)
    state.enabled = true
    vi.spyOn(Notification, 'isSupported').mockReturnValue(false)
    expect(localNotificationsSupported()).toBe(false)
    expect(pushLocalNotification({ title: 'T', body: 'B' })).toBe(false)
    expect(Notification.shown).toEqual([])
  })

  it('returns false when showing throws', () => {
    vi.spyOn(Notification.prototype, 'show').mockImplementation(() => {
      throw new Error('dbus')
    })
    expect(pushLocalNotification({ title: 'T', body: 'B' })).toBe(false)
  })

  it('sends a settings-route test notification', () => {
    expect(pushTestNotification()).toBe(true)
    expect(Notification.shown[0]!.title).toBe('MossStudio 通知测试')
  })
})
