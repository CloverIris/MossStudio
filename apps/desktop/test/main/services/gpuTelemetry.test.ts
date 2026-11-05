import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GpuInventorySnapshot, GpuTelemetrySnapshot } from '@shared/types'
import { gpuDeviceFixture, gpuInventoryFixture, GPU_RTX_3060 } from '@test/mocks/backend/fixtures'

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void
const state = {
  inventory: gpuInventoryFixture([gpuDeviceFixture(), GPU_RTX_3060()]) as GpuInventorySnapshot,
  counts: {} as Record<string, { runningTasks: number; queuedTasks: number }>,
  smi: { stdout: '', error: null as Error | null, stderr: '' },
  emitted: [] as GpuTelemetrySnapshot[],
  windows: [] as Array<EventEmitter & { isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean; isFocused(): boolean }>,
}
// The shared electron mock lacks powerMonitor/app removeListener and BrowserWindow.isVisible.
const powerMonitor = new EventEmitter()
const app = new EventEmitter()
vi.mock('electron', () => ({ app, powerMonitor, BrowserWindow: { getAllWindows: () => state.windows } }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  execFile: (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
    callback(state.smi.error, state.smi.stdout, state.smi.stderr)
  },
}))
vi.mock('@main/services/devices', () => ({ getGpuInventory: async () => state.inventory }))
vi.mock('@main/services/supervisor', () => ({ getGpuJobCounts: async () => state.counts }))
vi.mock('@main/lib/events', () => ({ emit: (_channel: string, payload: GpuTelemetrySnapshot) => state.emitted.push(payload) }))

const [rtx4090, rtx3060] = [gpuDeviceFixture(), GPU_RTX_3060()]
const MiB = 1024 * 1024
const window = (visible: boolean, focused = visible) => Object.assign(new EventEmitter(), { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false, isFocused: () => focused })
const flush = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve() }
let stop: (() => void) | undefined

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  powerMonitor.removeAllListeners()
  app.removeAllListeners()
  Object.assign(state, {
    inventory: gpuInventoryFixture([rtx4090, rtx3060]), counts: {}, smi: { stdout: '', error: null, stderr: '' }, emitted: [], windows: [],
  })
})
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
})
async function start() {
  const { startGpuTelemetry } = await import('@main/services/gpuTelemetry')
  stop = startGpuTelemetry()
  await flush()
}

describe('startGpuTelemetry', () => {
  it('merges live memory samples and per-GPU task counts into the inventory', async () => {
    state.smi.stdout = `${rtx4090.uuid}, 2048, 20000, 37\n${rtx3060.uuid}, [N/A], 1e3, \n, 1, 2, 3\n`
    state.counts = { [rtx4090.uuid]: { runningTasks: 1, queuedTasks: 2 } }
    await start()
    const [snapshot] = state.emitted
    expect(snapshot!.status).toBe('ok')
    expect(snapshot!.recommendedGpuUuid).toBe(state.inventory.recommendedGpuUuid)
    expect(snapshot!.devices[0]).toMatchObject({ uuid: rtx4090.uuid, memoryUsedBytes: 2048 * MiB, memoryFreeBytes: 20000 * MiB, utilizationPercent: 37, runningTasks: 1, queuedTasks: 2 })
    // Unparseable values keep the inventory numbers instead of becoming NaN.
    expect(snapshot!.devices[1]).toMatchObject({ memoryUsedBytes: undefined, memoryFreeBytes: rtx3060.memoryFreeBytes, utilizationPercent: rtx3060.utilizationPercent, runningTasks: 0, queuedTasks: 0 })
  })

  it('passes through an unavailable inventory', async () => {
    state.inventory = { scannedAt: 'x', status: 'unavailable', devices: [], error: 'no driver' }
    await start()
    expect(state.emitted[0]).toMatchObject({ status: 'unavailable', devices: [], error: 'no driver' })
  })

  it('keeps inventory devices with counts when the telemetry query fails', async () => {
    state.smi = { stdout: '', error: new Error('exit 1'), stderr: 'GPU is lost' }
    state.counts = { [rtx3060.uuid]: { runningTasks: 0, queuedTasks: 1 } }
    await start()
    expect(state.emitted[0]).toMatchObject({ status: 'error', error: 'GPU is lost' })
    expect(state.emitted[0]!.devices.map((device) => device.queuedTasks)).toEqual([0, 1])
  })

  it('polls slowest with no visible window, faster when visible and fastest while GPUs are busy', async () => {
    // Exact intervals are tuning; the contract is hidden > visible > busy, and nothing runs early.
    state.smi.stdout = `${rtx4090.uuid}, 1, 1, 1\n`
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return realSetTimeout(fn, ms)
    }) as typeof setTimeout)
    await start()
    const hidden = delays.at(-1)!
    expect(hidden).toBe(30_000)
    await vi.advanceTimersByTimeAsync(hidden - 1)
    expect(state.emitted).toHaveLength(1)
    state.windows = [window(true)]
    await vi.advanceTimersByTimeAsync(1)
    expect(state.emitted).toHaveLength(2)
    const visible = delays.at(-1)!
    expect(visible).toBeLessThan(hidden)
    state.counts = { [rtx4090.uuid]: { runningTasks: 1, queuedTasks: 0 } }
    await vi.advanceTimersByTimeAsync(visible)
    expect(state.emitted).toHaveLength(3)
    const busy = delays.at(-1)!
    expect(busy).toBeLessThan(visible)
    await vi.advanceTimersByTimeAsync(busy)
    expect(state.emitted).toHaveLength(4)
  })

  it('pauses on suspend, resamples on resume and on window show', async () => {
    const shown = window(true)
    state.windows = [shown]
    await start()
    powerMonitor.emit('suspend')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.emitted).toHaveLength(1)
    powerMonitor.emit('resume')
    await flush()
    expect(state.emitted).toHaveLength(2)
    shown.emit('show')
    await flush()
    expect(state.emitted).toHaveLength(3)
    const created = window(true)
    app.emit('browser-window-created', {}, created)
    created.emit('show')
    await flush()
    expect(state.emitted).toHaveLength(4)
  })

  it('stops sampling and detaches every listener', async () => {
    const shown = window(false)
    state.windows = [shown]
    await start()
    stop!()
    stop = undefined
    expect(powerMonitor.listenerCount('suspend') + powerMonitor.listenerCount('resume')).toBe(0)
    expect(app.listenerCount('browser-window-created')).toBe(0)
    expect(shown.listenerCount('show')).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(state.emitted).toHaveLength(1)
  })
})

describe('telemetryInterval', () => {
  it('is live only while a window is focused, and backs off otherwise', async () => {
    const { telemetryInterval } = await import('@main/services/gpuTelemetry')
    expect(telemetryInterval({ focused: true, visible: true, active: true })).toBe(2000)
    expect(telemetryInterval({ focused: true, visible: true, active: false })).toBe(5000)
    expect(telemetryInterval({ focused: false, visible: true, active: true })).toBe(4000)
    expect(telemetryInterval({ focused: false, visible: true, active: false })).toBe(15_000)
    expect(telemetryInterval({ focused: false, visible: false, active: true })).toBe(30_000)
  })
})
