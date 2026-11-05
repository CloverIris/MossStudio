import { app, BrowserWindow, powerMonitor } from 'electron'
import { execFile } from 'node:child_process'
import type { GpuTelemetryDevice, GpuTelemetrySnapshot } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { getGpuInventory } from './devices'
import { getGpuJobCounts } from './supervisor'

function queryGpuMemory(): Promise<Map<string, { used?: number; free?: number; utilization?: number }>> {
  return new Promise((resolve, reject) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=uuid,memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || `nvidia-smi 遥测查询失败：${error.message}`))
          return
        }
        const samples = new Map<string, { used?: number; free?: number; utilization?: number }>()
        for (const row of stdout.split(/\r?\n/).filter(Boolean)) {
          const [uuid, used, free, utilization] = row.split(',').map((part) => part.trim())
          if (!uuid) continue
          const number = (value: string | undefined): number | undefined => {
            if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined
            const parsed = Number(value)
            return Number.isFinite(parsed) ? parsed : undefined
          }
          samples.set(uuid, {
            used: number(used),
            free: number(free),
            utilization: number(utilization),
          })
        }
        resolve(samples)
      },
    )
  })
}

async function sampleGpuTelemetry(): Promise<GpuTelemetrySnapshot> {
  const inventory = await getGpuInventory()
  const counts = await getGpuJobCounts()
  if (inventory.status !== 'ok') {
    return {
      sampledAt: new Date().toISOString(),
      status: inventory.status,
      devices: [],
      recommendedGpuUuid: inventory.recommendedGpuUuid,
      error: inventory.error,
    }
  }

  try {
    const samples = await queryGpuMemory()
    const devices: GpuTelemetryDevice[] = inventory.devices.map((device) => {
      const sample = samples.get(device.uuid)
      const tasks = counts[device.uuid]
      return {
        ...device,
        memoryUsedBytes: sample?.used === undefined ? undefined : sample.used * 1024 * 1024,
        memoryFreeBytes: sample?.free === undefined ? device.memoryFreeBytes : sample.free * 1024 * 1024,
        utilizationPercent: sample?.utilization ?? device.utilizationPercent,
        runningTasks: tasks?.runningTasks ?? 0,
        queuedTasks: tasks?.queuedTasks ?? 0,
      }
    })
    return {
      sampledAt: new Date().toISOString(),
      status: 'ok',
      devices,
      recommendedGpuUuid: inventory.recommendedGpuUuid,
    }
  } catch (error) {
    return {
      sampledAt: new Date().toISOString(),
      status: 'error',
      recommendedGpuUuid: inventory.recommendedGpuUuid,
      devices: inventory.devices.map((device) => ({
        ...device,
        runningTasks: counts[device.uuid]?.runningTasks ?? 0,
        queuedTasks: counts[device.uuid]?.queuedTasks ?? 0,
      })),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function startGpuTelemetry(): () => void {
  let stopped = false
  let suspended = false
  let timer: NodeJS.Timeout | undefined
  let sampling = false
  let latest: GpuTelemetrySnapshot | null = null

  const sample = async (): Promise<void> => {
    if (stopped || suspended || sampling) return
    sampling = true
    try {
      latest = await sampleGpuTelemetry()
      emit(Events.gpuTelemetry, latest)
    } catch (error) {
      latest = {
        sampledAt: new Date().toISOString(),
        status: 'error',
        devices: [],
        error: error instanceof Error ? error.message : String(error),
      }
      emit(Events.gpuTelemetry, latest)
    } finally {
      sampling = false
      schedule()
    }
  }

  const schedule = (): void => {
    if (stopped || suspended || timer) return
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
    // The title-bar monitor is live only while someone is looking at it.
    const focused = windows.some((window) => window.isFocused())
    const visible = windows.some((window) => window.isVisible() && !window.isMinimized())
    const active = latest?.devices.some((device) => device.runningTasks > 0 || device.queuedTasks > 0) ?? false
    timer = setTimeout(() => {
      timer = undefined
      void sample()
    }, telemetryInterval({ focused, visible, active }))
    timer.unref()
  }

  const onWindowShow = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    void sample()
  }
  const attachWindow = (_event: Electron.Event, window: BrowserWindow): void => {
    window.on('show', onWindowShow)
  }
  const onSuspend = (): void => {
    suspended = true
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const onResume = (): void => {
    suspended = false
    void sample()
  }
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('resume', onResume)
  for (const window of BrowserWindow.getAllWindows()) window.on('show', onWindowShow)
  app.on('browser-window-created', attachWindow)
  void sample()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    powerMonitor.removeListener('suspend', onSuspend)
    powerMonitor.removeListener('resume', onResume)
    app.removeListener('browser-window-created', attachWindow)
    for (const window of BrowserWindow.getAllWindows()) window.removeListener('show', onWindowShow)
  }
}

/** How long to wait before the next nvidia-smi sample. */
export function telemetryInterval({ focused, visible, active }: { focused: boolean; visible: boolean; active: boolean }): number {
  if (focused) return active ? 2000 : 5000
  if (visible) return active ? 4000 : 15_000
  return 30_000
}
