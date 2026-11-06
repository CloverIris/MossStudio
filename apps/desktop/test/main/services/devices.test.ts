import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void
const state = {
  sync: '' as string | Error,
  async: [] as Array<{ error?: Error; stdout?: string; stderr?: string }>,
  asyncCalls: [] as string[][],
  syncCalls: [] as Array<[string, string[]]>,
  events: [] as Array<{ channel: string; payload: unknown }>,
}
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  execFileSync: (file: string, args: string[]) => {
    state.syncCalls.push([file, args])
    if (state.sync instanceof Error) throw state.sync
    return state.sync
  },
  execFile: (_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    state.asyncCalls.push(args)
    const next = state.async.shift() ?? { stdout: '' }
    setImmediate(() => callback(next.error ?? null, next.stdout ?? '', next.stderr ?? ''))
  },
}))
vi.mock('@main/lib/events', () => ({ emit: (channel: string, payload: unknown) => state.events.push({ channel, payload }) }))

const originalPlatform = process.platform
const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true })

beforeEach(() => {
  vi.resetModules()
  Object.assign(state, { sync: '', async: [], asyncCalls: [], syncCalls: [], events: [] })
})
afterEach(() => setPlatform(originalPlatform))
const load = () => import('@main/services/devices')

describe('listDevices', () => {
  it('lists CUDA rows from nvidia-smi plus the CPU', async () => {
    setPlatform('linux')
    state.sync = '0, NVIDIA GeForce RTX 4090, 24564\n1, NVIDIA A100, N/A\n, broken, 1\n'
    const devices = (await load()).listDevices()
    expect(devices.map((device) => device.id)).toEqual(['cuda:0', 'cuda:1', 'cpu'])
    expect(devices[0]).toEqual({
      id: 'cuda:0',
      name: 'NVIDIA GeForce RTX 4090',
      kind: 'cuda',
      detail: 'CUDA · 24 GB',
      memoryBytes: 24564 * 1024 * 1024,
      available: true,
    })
    expect(devices[1]).toMatchObject({ detail: 'CUDA · 显存未知', memoryBytes: undefined })
    expect(devices[2]!.kind).toBe('cpu')
  })

  it('still lists the CPU when nvidia-smi is missing', async () => {
    setPlatform('win32')
    state.sync = new Error('ENOENT')
    expect((await load()).listDevices().map((device) => device.kind)).toEqual(['cpu'])
  })

  it('applies user labels and disabled devices', async () => {
    setPlatform('linux')
    state.sync = '0, NVIDIA A, 1024\n'
    const devices = (await load()).listDevices({ disabledDevices: ['cpu'], deviceLabels: { 'cuda:0': 'Main GPU', cpu: '' } })
    expect(devices[0]).toMatchObject({ name: 'Main GPU', available: true })
    expect(devices[1]!.available).toBe(false)
    expect(devices[1]!.name).not.toBe('')
  })

  it('never asks nvidia-smi on macOS', async () => {
    setPlatform('darwin')
    ;(await load()).listDevices()
    expect(state.syncCalls.some(([file]) => file === 'nvidia-smi')).toBe(false)
  })
})

describe('refreshGpuInventory', () => {
  it('merges compute capabilities and recommends the newest architecture', async () => {
    state.async = [
      { stdout: '0, GPU-a, RTX 3060, 12288, 11000, 3, 581.42\n1, GPU-b, RTX 4090, 24564, 20000, 50, 581.42\n' },
      { stdout: 'GPU-a, 8.6\nGPU-b, 8.9\n' },
    ]
    const snapshot = await (await load()).refreshGpuInventory()
    expect(snapshot.status).toBe('ok')
    expect(snapshot.devices.map((device) => device.computeCapability)).toEqual([
      { major: 8, minor: 6 },
      { major: 8, minor: 9 },
    ])
    expect(snapshot.recommendedGpuUuid).toBe('GPU-b')
    expect(snapshot.capabilityNotice).toBeUndefined()
    expect(state.events).toEqual([{ channel: 'event:gpu-inventory', payload: snapshot }])
  })

  it('adds a notice when capabilities are partial or the query fails', async () => {
    state.async = [{ stdout: '0, GPU-a, X, 1, 1, 1, N/A\n' }, { stdout: 'GPU-a, [N/A]\n' }]
    const { refreshGpuInventory } = await load()
    const partial = await refreshGpuInventory()
    expect(partial.capabilityNotice).toMatch(/未知设备不会被自动归类/)
    expect(partial.recommendedGpuUuid).toBeUndefined()
    state.async = [
      { stdout: '0, GPU-a, X, 1, 1, 1, N/A\n' },
      { error: new Error('Field "compute_cap" is not a valid field'), stderr: 'bad field' },
    ]
    expect((await refreshGpuInventory()).capabilityNotice).toBe(
      '无法从 NVIDIA 驱动读取 SM 计算能力：nvidia-smi --query-gpu=uuid,compute_cap 失败：bad field',
    )
  })

  it('reports unavailable for missing nvidia-smi or empty output, error otherwise', async () => {
    const { refreshGpuInventory } = await load()
    state.async = [{ error: new Error('spawn nvidia-smi ENOENT') }]
    expect(await refreshGpuInventory()).toMatchObject({
      status: 'unavailable',
      devices: [],
      error: expect.stringContaining('未找到 nvidia-smi'),
    })
    state.async = [{ stdout: '\n' }]
    expect(await refreshGpuInventory()).toMatchObject({ status: 'unavailable', error: 'nvidia-smi 未返回可识别的 NVIDIA GPU' })
    state.async = [{ error: new Error('exit 9'), stderr: 'NVIDIA-SMI has failed' }]
    expect(await refreshGpuInventory()).toMatchObject({ status: 'error', error: expect.stringContaining('NVIDIA-SMI has failed') })
  })

  it('shares one refresh between concurrent callers and caches for getGpuInventory', async () => {
    state.async = [{ stdout: '0, GPU-a, X, 1, 1, 1, 1\n' }, { stdout: 'GPU-a, 8.0\n' }]
    const { refreshGpuInventory, getGpuInventory } = await load()
    const [a, b] = await Promise.all([refreshGpuInventory(), refreshGpuInventory()])
    expect(a).toBe(b)
    expect(await getGpuInventory()).toBe(a)
    expect(state.asyncCalls).toHaveLength(2)
  })
})
