import { beforeEach, describe, expect, it, vi } from 'vitest'

type ShellModule = typeof import('@renderer/lib/shell')
let useShell: ShellModule['useShell']

beforeEach(async () => {
  vi.resetModules()
  ;({ useShell } = await import('@renderer/lib/shell'))
})

describe('lib/shell', () => {
  it('starts closed on the jobs tab', () => {
    expect(useShell.getState()).toMatchObject({ activityOpen: false, activityTab: 'jobs', focusedJobId: null, titlebarSlot: null })
  })

  it('openActivity keeps the current tab and focused job unless given new ones', () => {
    const shell = () => useShell.getState()
    shell().setActivityTab('problems')
    shell().focusJob('j1')
    shell().openActivity()
    expect(shell()).toMatchObject({ activityOpen: true, activityTab: 'problems', focusedJobId: 'j1' })
    shell().openActivity('notifications', null)
    expect(shell()).toMatchObject({ activityTab: 'notifications', focusedJobId: null })
    shell().openActivity('jobs', 'j2')
    expect(shell().focusedJobId).toBe('j2')
  })

  it('toggles and closes the activity panel', () => {
    useShell.getState().toggleActivity()
    expect(useShell.getState().activityOpen).toBe(true)
    useShell.getState().toggleActivity()
    expect(useShell.getState().activityOpen).toBe(false)
    useShell.getState().openActivity()
    useShell.getState().closeActivity()
    expect(useShell.getState().activityOpen).toBe(false)
  })

  it('stores the title bar slot element', () => {
    const slot = document.createElement('div')
    useShell.getState().setTitlebarSlot(slot)
    expect(useShell.getState().titlebarSlot).toBe(slot)
    useShell.getState().setTitlebarSlot(null)
    expect(useShell.getState().titlebarSlot).toBeNull()
  })
})
