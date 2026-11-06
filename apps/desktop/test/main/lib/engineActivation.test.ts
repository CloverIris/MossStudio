import { describe, expect, it, vi } from 'vitest'
import {
  ActivationTimeoutError,
  activateWhenAllowed,
  engineActivationInProgress,
  waitForEngineActivation,
  withEngineActivation,
} from '@main/lib/engineActivation'

describe('engine activation lock', () => {
  it('makes new jobs wait until the switch is finished', async () => {
    const order: string[] = []
    let finish!: () => void
    const activation = withEngineActivation(async () => {
      order.push('activate:start')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      order.push('activate:end')
    })
    expect(engineActivationInProgress()).toBe(true)
    const job = waitForEngineActivation().then(() => order.push('job'))
    await Promise.resolve()
    expect(order).toEqual(['activate:start'])
    finish()
    await Promise.all([activation, job])
    expect(order).toEqual(['activate:start', 'activate:end', 'job'])
    expect(engineActivationInProgress()).toBe(false)
  })

  it('activates right away without a gate (an install the person asked for)', async () => {
    await expect(activateWhenAllowed(async () => 'path')).resolves.toBe('path')
  })

  it('waits while jobs run and switches once they are done', async () => {
    let busy = true
    const sleep = vi.fn(async () => {
      busy = false
    })
    const onWaiting = vi.fn()
    const activate = vi.fn(async () => 'new-engine')
    await expect(activateWhenAllowed(activate, { canActivate: async () => !busy, sleep, onWaiting })).resolves.toBe('new-engine')
    expect(activate).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(onWaiting).toHaveBeenCalledTimes(1)
  })

  it('never activates while the gate says no, and gives up at the deadline', async () => {
    let time = 0
    const activate = vi.fn(async () => 'x')
    const result = activateWhenAllowed(activate, {
      canActivate: async () => false,
      retryMs: 1000,
      timeoutMs: 5000,
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    })
    await expect(result).rejects.toBeInstanceOf(ActivationTimeoutError)
    expect(activate).not.toHaveBeenCalled()
    expect(engineActivationInProgress()).toBe(false)
  })

  it('stops waiting when the install is canceled', async () => {
    const controller = new AbortController()
    const result = activateWhenAllowed(async () => 'x', {
      canActivate: async () => false,
      signal: controller.signal,
      sleep: async () => {
        controller.abort()
      },
    })
    await expect(result).rejects.toThrow('已取消')
  })
})

describe('engine activation lock ordering', () => {
  it('lets only one activation hold the lock at a time', async () => {
    let inside = 0
    let most = 0
    const run = () =>
      withEngineActivation(async () => {
        inside += 1
        most = Math.max(most, inside)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inside -= 1
      })
    await Promise.all([run(), run(), run()])
    expect(most).toBe(1)
  })
})
