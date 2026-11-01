import { execFile, execFileSync } from 'node:child_process'
import os from 'node:os'
import type { GpuInventorySnapshot, LaunchDevice, Settings } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { parseNvidiaComputeCapabilities, parseNvidiaGpuRows, recommendedGpu } from '../lib/gpuInventory'

function command(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

export function listDevices(settings?: Pick<Settings, 'disabledDevices' | 'deviceLabels'>): LaunchDevice[] {
  const devices: LaunchDevice[] = []
  const cpu = os.cpus()[0]?.model?.trim() || 'CPU'

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const chip = command('sysctl', ['-n', 'machdep.cpu.brand_string']) || 'Apple Silicon'
    devices.push({
      id: 'mps',
      name: chip,
      kind: 'mps',
      detail: 'Metal / MPS',
      memoryBytes: os.totalmem(),
      available: true,
    })
  }

  if (process.platform !== 'darwin') {
    const rows = command('nvidia-smi', [
      '--query-gpu=index,name,memory.total',
      '--format=csv,noheader,nounits',
    ])
      .split('\n')
      .filter(Boolean)
    for (const row of rows) {
      const [index, name, memory] = row.split(',').map((part) => part.trim())
      if (!index || !name) continue
      const mb = Number.parseInt(memory ?? '', 10)
      devices.push({
        id: `cuda:${index}`,
        name,
        kind: 'cuda',
        detail: `CUDA · ${Number.isFinite(mb) ? `${Math.round(mb / 1024)} GB` : '显存未知'}`,
        memoryBytes: Number.isFinite(mb) ? mb * 1024 * 1024 : undefined,
        available: true,
      })
    }
  }

  devices.push({
    id: 'cpu',
    name: cpu,
    kind: 'cpu',
    detail: 'CPU',
    memoryBytes: os.totalmem(),
    available: true,
  })
  const disabled = new Set(settings?.disabledDevices ?? [])
  return devices.map((device) => ({
    ...device,
    name: settings?.deviceLabels?.[device.id] || device.name,
    available: device.available && !disabled.has(device.id),
  }))
}

function runNvidiaSmi(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'nvidia-smi',
      args,
      { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message
          reject(new Error(`nvidia-smi ${args[0] ?? ''} 失败：${detail}`.trim()))
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

let inventory: GpuInventorySnapshot | null = null
let inventoryRefresh: Promise<GpuInventorySnapshot> | null = null

export async function refreshGpuInventory(): Promise<GpuInventorySnapshot> {
  if (inventoryRefresh) return inventoryRefresh
  inventoryRefresh = (async () => {
    let next: GpuInventorySnapshot
    try {
      const output = await runNvidiaSmi([
        '--query-gpu=index,uuid,name,memory.total,memory.free,utilization.gpu,driver_version',
        '--format=csv,noheader,nounits',
      ])
      const devices = parseNvidiaGpuRows(output)
      if (devices.length === 0) {
        next = {
          scannedAt: new Date().toISOString(),
          status: 'unavailable',
          devices: [],
          error: 'nvidia-smi 未返回可识别的 NVIDIA GPU',
        }
      } else {
        let capabilityNotice: string | undefined
        try {
          const capabilityOutput = await runNvidiaSmi([
            '--query-gpu=uuid,compute_cap',
            '--format=csv,noheader,nounits',
          ])
          const capabilities = parseNvidiaComputeCapabilities(capabilityOutput)
          for (const device of devices) device.computeCapability = capabilities.get(device.uuid)
          if (devices.some((device) => !device.computeCapability)) {
            capabilityNotice = '驱动未提供所有 GPU 的 SM 计算能力；未知设备不会被自动归类为标准架构。'
          }
        } catch (error) {
          capabilityNotice = `无法从 NVIDIA 驱动读取 SM 计算能力：${error instanceof Error ? error.message : String(error)}`
        }
        next = {
          scannedAt: new Date().toISOString(),
          status: 'ok',
          devices,
          recommendedGpuUuid: recommendedGpu(devices)?.uuid,
          capabilityNotice,
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const unavailable = /not found|ENOENT/i.test(message)
      next = {
        scannedAt: new Date().toISOString(),
        status: unavailable ? 'unavailable' : 'error',
        devices: [],
        error: unavailable
          ? '未找到 nvidia-smi；请安装 NVIDIA 驱动或使用手动架构选择。'
          : message,
      }
    }
    inventory = next
    emit(Events.gpuInventory, next)
    return next
  })()
  try {
    return await inventoryRefresh
  } finally {
    inventoryRefresh = null
  }
}

export async function getGpuInventory(): Promise<GpuInventorySnapshot> {
  return inventory ?? refreshGpuInventory()
}
