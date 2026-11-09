import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { busyReasons } from '@main/update/busy'
import { updateContext, type UpdateContextInput } from '@main/update/context'
import { armAppHealth, armHealthConfirm, type HealthWindow } from '@main/update/health'
import { UpdateScheduler, CHECK_INTERVAL_MS, FOCUS_THROTTLE_MS } from '@main/update/schedule'
import { transportUrls } from '@main/update/transport'

const GH = 'https://github.com/ShallowElec/MossStudio/releases/download/updates/update-stable.json'

describe('transportUrls', () => {
  it('tries GitHub first, then the mirrors', () => {
    const urls = transportUrls(GH, { networkMode: 'auto', gitMirror: null })
    expect(urls[0]).toBe(GH)
    expect(urls.length).toBeGreaterThan(1)
    expect(
      urls.slice(1).every((url) => url.endsWith('github.com/ShallowElec/MossStudio/releases/download/updates/update-stable.json')),
    ).toBe(true)
  })

  it('puts the mirror the user chose first and keeps GitHub as the last resort', () => {
    const urls = transportUrls(GH, { networkMode: 'auto', gitMirror: 'https://ghproxy.net/' })
    expect(urls[0]).toBe(`https://ghproxy.net/${GH}`)
    expect(urls.at(-1)).toBe(GH)
    expect(transportUrls(GH, { networkMode: 'mirror', gitMirror: null }).at(-1)).toBe(GH)
  })

  it('uses GitHub only in direct mode, and non-GitHub URLs as they are', () => {
    expect(transportUrls(GH, { networkMode: 'direct', gitMirror: 'https://ghproxy.net/' })).toEqual([GH])
    expect(transportUrls('http://127.0.0.1:9/update-stable.json', { networkMode: 'auto', gitMirror: 'https://ghproxy.net/' })).toEqual([
      'http://127.0.0.1:9/update-stable.json',
    ])
  })
})

describe('busyReasons', () => {
  it('reports active inference, training, model and engine downloads with counts', () => {
    expect(
      busyReasons({
        jobs: [
          { state: 'running' },
          { state: 'queued', kind: 'inference' },
          { state: 'starting', kind: 'training' },
          { state: 'succeeded' },
          { state: 'failed', kind: 'training' },
        ],
        downloads: [{ state: 'running' }, { state: 'verifying' }, { state: 'paused' }, { state: 'done' }],
        engineDownloadPhase: 'downloading',
        engineInstalling: false,
      }),
    ).toEqual([
      { kind: 'inference', count: 2, label: '2 个生成任务' },
      { kind: 'training', count: 1, label: '1 个训练任务' },
      { kind: 'model-download', count: 2, label: '2 个模型下载' },
      { kind: 'engine-download', count: 1, label: '推理引擎下载或安装' },
    ])
  })

  it('is empty when idle', () => {
    expect(
      busyReasons({ jobs: [{ state: 'canceled' }], downloads: [{ state: 'error' }], engineDownloadPhase: 'done', engineInstalling: false }),
    ).toEqual([])
    expect(busyReasons({ jobs: [], downloads: [], engineDownloadPhase: null, engineInstalling: true })).toHaveLength(1)
  })
})

describe('UpdateScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup() {
    const check = vi.fn(async () => undefined)
    const focus = new EventEmitter()
    const scheduler = new UpdateScheduler({
      check,
      onFocus: (listener) => {
        focus.on('focus', listener)
        return () => focus.off('focus', listener)
      },
      now: () => Date.now(),
    })
    return { check, focus, scheduler }
  }

  it('checks on start and every 6 hours', async () => {
    const { check, scheduler } = setup()
    scheduler.start()
    expect(check).toHaveBeenCalledWith('start')
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(check).toHaveBeenLastCalledWith('interval')
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(check).toHaveBeenCalledTimes(3)
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(check).toHaveBeenCalledTimes(3)
  })

  it('checks on focus at most every 10 minutes, counting manual checks', async () => {
    const { check, focus, scheduler } = setup()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(1)
    focus.emit('focus')
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(FOCUS_THROTTLE_MS)
    focus.emit('focus')
    expect(check).toHaveBeenLastCalledWith('focus')
    expect(check).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(FOCUS_THROTTLE_MS - 1000)
    scheduler.markChecked()
    await vi.advanceTimersByTimeAsync(2000)
    focus.emit('focus')
    expect(check).toHaveBeenCalledTimes(2)
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(FOCUS_THROTTLE_MS)
    focus.emit('focus')
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('runs one check at a time and survives a failing check', async () => {
    let release!: () => void
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const scheduler = new UpdateScheduler({ check, onFocus: () => () => undefined })
    const first = scheduler.run('manual')
    expect(scheduler.run('manual')).toBe(first)
    release()
    await first
    const failing = new UpdateScheduler({ check: () => Promise.reject(new Error('offline')), onFocus: () => () => undefined })
    await expect(failing.run('manual')).resolves.toBeUndefined()
  })
})

class FakeWindow extends EventEmitter implements HealthWindow {
  visible = false
  destroyed = false
  webContents = new EventEmitter()
  isVisible(): boolean {
    return this.visible
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  show(): void {
    this.visible = true
    this.emit('show')
  }
  close(): void {
    this.visible = false
    this.destroyed = true
    this.emit('closed')
  }
}

describe('armHealthConfirm', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('confirms once the window has been shown for the delay', async () => {
    const win = new FakeWindow()
    const confirm = vi.fn()
    armHealthConfirm(win, confirm, 8000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(confirm).not.toHaveBeenCalled()
    win.show()
    await vi.advanceTimersByTimeAsync(7999)
    expect(confirm).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(confirm).toHaveBeenCalledTimes(1)
    win.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('does not confirm through a renderer crash, and re-arms after a successful reload', async () => {
    const win = new FakeWindow()
    const confirm = vi.fn()
    win.visible = true
    armHealthConfirm(win, confirm, 8000)
    await vi.advanceTimersByTimeAsync(5000)
    win.webContents.emit('render-process-gone')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(confirm).not.toHaveBeenCalled()
    win.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(8000)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('can be disarmed', async () => {
    const win = new FakeWindow()
    win.visible = true
    const confirm = vi.fn()
    const disarm = armHealthConfirm(win, confirm, 8000)
    disarm()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('updateContext', () => {
  const record = { current: '1.0.3' } as never
  const input = (run: Partial<UpdateContextInput['run']>, patch: Partial<UpdateContextInput> = {}): UpdateContextInput => ({
    run: {
      mode: 'installed',
      platform: 'linux',
      platformKey: 'linux-x64',
      packaged: true,
      root: '/opt/moss',
      launcher: '/opt/moss/mossstudio',
      appPath: '/opt/moss/app-1.0.3',
      recordPath: '/opt/moss/install.json',
      record,
      ...run,
    },
    hasKeys: true,
    exists: () => true,
    writable: () => true,
    ...patch,
  })
  const reason = (value: UpdateContextInput) => updateContext(value).unsupportedReason

  it('supports an installed or portable copy started with its launcher', () => {
    expect(reason(input({}))).toBeNull()
    expect(reason(input({ mode: 'portable' }))).toBeNull()
    expect(reason(input({ mode: 'installed', platform: 'darwin', platformKey: 'darwin-arm64', launcher: null }))).toBeNull()
  })

  it('explains why a copy cannot update itself', () => {
    expect(reason(input({ mode: 'dev', packaged: false }))).toContain('开发版本')
    expect(reason(input({ mode: 'setup' }))).toContain('安装程序')
    expect(reason(input({ mode: 'loose' }))).toContain('不是通过安装程序')
    expect(reason(input({ platformKey: null }))).toContain('此平台')
    expect(reason(input({}, { hasKeys: false }))).toContain('签名密钥')
    expect(reason(input({ record: null }))).toContain('install.json')
    expect(reason(input({ mode: 'portable', launcher: null }))).toContain('便携版')
    expect(reason(input({ launcher: '/gone' }, { exists: () => false }))).toContain('启动器')
    expect(reason(input({ platform: 'darwin', platformKey: 'darwin-x64', launcher: null }, { writable: () => false }))).toContain('不可写')
  })
})

describe('armAppHealth', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup() {
    const created = new EventEmitter()
    const confirm = vi.fn()
    const onCreated = (listener: (win: HealthWindow) => void) => {
      created.on('win', listener)
      return () => created.off('win', listener)
    }
    return { created, confirm, onCreated }
  }

  it('confirms once from any window, including one created later (activate)', async () => {
    const { created, confirm, onCreated } = setup()
    const first = new FakeWindow()
    armAppHealth([first], onCreated, confirm, 8000)
    first.show()
    await vi.advanceTimersByTimeAsync(3000)
    first.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(confirm).not.toHaveBeenCalled()
    const second = new FakeWindow()
    created.emit('win', second)
    second.show()
    await vi.advanceTimersByTimeAsync(8000)
    expect(confirm).toHaveBeenCalledTimes(1)
    // Closing it afterwards does not undo anything, and nothing confirms twice.
    second.close()
    const third = new FakeWindow()
    created.emit('win', third)
    third.show()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('does not confirm while every shown window crashes or hides', async () => {
    const { confirm, onCreated } = setup()
    const win = new FakeWindow()
    armAppHealth([win], onCreated, confirm, 8000)
    win.show()
    await vi.advanceTimersByTimeAsync(4000)
    win.emit('hide')
    win.visible = false
    await vi.advanceTimersByTimeAsync(10_000)
    win.show()
    await vi.advanceTimersByTimeAsync(4000)
    win.webContents.emit('render-process-gone')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('busyReasons (git)', () => {
  it('counts git mirror operations', () => {
    expect(busyReasons({ jobs: [], downloads: [], engineDownloadPhase: null, engineInstalling: false, gitOperations: 1 })).toEqual([
      { kind: 'git-clone', count: 1, label: '代码仓库下载' },
    ])
  })
})
