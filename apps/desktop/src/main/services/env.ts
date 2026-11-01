import { app } from 'electron'
import { gitBinary } from '../lib/gitBinary'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { isAbsolute } from 'node:path'
import type {
  CheckItem,
  EnvReport,
  GpuInfo,
  PythonInfo,
  Recommendation,
  Settings,
  ToolState,
} from '@shared/types'
import { firstLine, run } from '../lib/run'
import { paths } from '../lib/paths'
import { probeNetwork } from './network'

export interface ScanProgress {
  section: string
  status: 'running' | 'done' | 'error'
  detail?: string
}

type ProgressFn = (event: ScanProgress) => void

const GB = 1024 ** 3

async function which(name: string): Promise<string | null> {
  const result = await run(process.platform === 'win32' ? 'where' : 'which', [name], { timeoutMs: 3000 })
  return result.code === 0 ? firstLine(result.stdout) || null : null
}

async function detectGpu(): Promise<GpuInfo> {
  if (process.platform === 'darwin') {
    try {
      const result = await run('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 10_000 })
      const parsed = JSON.parse(result.stdout) as {
        SPDisplaysDataType?: Array<Record<string, unknown>>
      }
      const entry = parsed.SPDisplaysDataType?.[0]
      if (entry) {
        const name = String(entry['sppci_model'] ?? entry['_name'] ?? entry['spdisplays_chipset_model'] ?? '')
        const cores = Number.parseInt(String(entry['sppci_cores'] ?? ''), 10)
        const metal = /metal/i.test(JSON.stringify(entry))
        const memory = parseMemory(String(entry['spdisplays_vram'] ?? ''))
        if (name) {
          return {
            kind: /apple/i.test(name) ? 'apple' : /nvidia/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : 'intel',
            name,
            cores: Number.isFinite(cores) && cores > 0 ? cores : undefined,
            memoryBytes: memory,
            metal,
            available: true,
          }
        }
      }
    } catch {
      // fall through
    }
    const brand = await run('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeoutMs: 3000 })
    const name = firstLine(brand.stdout) || 'Apple GPU'
    return { kind: process.arch === 'arm64' ? 'apple' : 'unknown', name, metal: process.arch === 'arm64', available: process.arch === 'arm64' }
  }

  if (process.platform === 'win32') {
    try {
      const result = await run(
        'powershell',
        ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress'],
        { timeoutMs: 10_000 },
      )
      const raw = JSON.parse(result.stdout) as unknown
      const list = (Array.isArray(raw) ? raw : [raw]) as Array<{ Name?: string; DriverVersion?: string }>
      const best = list.find((item) => /nvidia|amd|radeon|intel|arc/i.test(item.Name ?? '')) ?? list[0]
      if (best?.Name) {
        return {
          kind: /nvidia/i.test(best.Name) ? 'nvidia' : /amd|radeon/i.test(best.Name) ? 'amd' : /intel|arc/i.test(best.Name) ? 'intel' : 'unknown',
          name: best.Name,
          driver: best.DriverVersion,
          available: true,
        }
      }
    } catch {
      // ignore
    }
    return { kind: 'unknown', name: '未知 GPU', available: false }
  }

  try {
    const result = await run('lspci', [], { timeoutMs: 4000 })
    const line = result.stdout.split('\n').find((l) => /VGA|3D|Display/i.test(l))
    if (line) {
      return { kind: /nvidia/i.test(line) ? 'nvidia' : /amd|radeon/i.test(line) ? 'amd' : /intel/i.test(line) ? 'intel' : 'unknown', name: line.split(':').slice(2).join(':').trim() || line, available: true }
    }
  } catch {
    // ignore
  }
  return { kind: 'unknown', name: '未知 GPU', available: false }
}

function parseMemory(text: string): number | undefined {
  const match = text.match(/([\d.]+)\s*(GB|MB)/i)
  if (!match) return undefined
  const value = Number.parseFloat(match[1]!)
  return match[2]!.toUpperCase() === 'GB' ? value * GB : value * 1024 * 1024
}

async function detectPythons(settings: Settings): Promise<PythonInfo[]> {
  const found = new Map<string, PythonInfo>()

  const add = async (path: string | null, source: PythonInfo['source']): Promise<void> => {
    if (!path) return
    try {
      const real = await fs.realpath(path)
      if (found.has(real)) return
      const result = await run(real, ['--version'], { timeoutMs: 4000 })
      const match = `${result.stdout}${result.stderr}`.match(/Python\s+(\d+\.\d+\.\d+)/)
      if (!match) return
      found.set(real, { path: real, version: match[1]!, source })
    } catch {
      // ignore
    }
  }

  await add(settings.pythonPath, 'system')

  const names = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python']
  for (const name of names) await add(await which(name), 'system')

  if (process.platform === 'win32') {
    const py = await run('py', ['-3', '-c', 'import sys;print(sys.executable)'], { timeoutMs: 4000 })
    if (py.code === 0) await add(firstLine(py.stdout), 'system')
  }

  const uvList = await run('uv', ['python', 'list'], { timeoutMs: 6000 })
  if (uvList.code === 0) {
    for (const line of uvList.stdout.split('\n')) {
      const match = line.match(/(\/[^\s]+python[\d.]*|\b[A-Za-z]:\\[^\s]+python\.exe)\b/)
      if (match) await add(match[1]!, 'uv')
    }
  }

  try {
    const managed = await fs.readdir(paths.managedPython(), { withFileTypes: true })
    for (const entry of managed) {
      if (!entry.isDirectory()) continue
      const candidate =
        process.platform === 'win32'
          ? `${paths.managedPython()}/${entry.name}/python.exe`
          : `${paths.managedPython()}/${entry.name}/bin/python3`
      await add(candidate, 'managed')
    }
  } catch {
    // ignore
  }

  return [...found.values()].slice(0, 8)
}

async function detectTool(name: string, args: string[]): Promise<ToolState> {
  const path = isAbsolute(name) ? name : await which(name)
  if (!path) return { found: false }
  const result = await run(path, args, { timeoutMs: 4000 })
  const version = firstLine(result.stdout || result.stderr)
  return { found: result.code === 0, path, version: version || undefined }
}

async function availableMemory(total: number): Promise<number> {
  if (process.platform === 'darwin') {
    try {
      const result = await run('vm_stat', [], { timeoutMs: 3000 })
      const pageMatch = result.stdout.match(/page size of (\d+) bytes/)
      const pageSize = pageMatch ? Number(pageMatch[1]) : 4096
      const pages = (label: string): number => {
        const match = result.stdout.match(new RegExp(`${label}:\\s+(\\d+)\\.`))
        return match ? Number(match[1]) : 0
      }
      const reclaimable =
        pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')
      if (reclaimable > 0) return reclaimable * pageSize
    } catch {
      // fall through
    }
  }
  return Math.min(total, os.freemem())
}

async function diskInfo(target: string): Promise<{ total: number; free: number }> {
  try {
    const stats = await fs.statfs(target)
    return { total: Number(stats.blocks) * Number(stats.bsize), free: Number(stats.bavail) * Number(stats.bsize) }
  } catch {
    return { total: 0, free: 0 }
  }
}


function formatBytes(bytes: number): string {
  if (!bytes) return '未知'
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function recommendationFor(memoryTotal: number, gpu: GpuInfo): Recommendation {
  const memoryGb = memoryTotal / GB
  if (!gpu.available) {
    return {
      width: 512,
      height: 512,
      steps: 20,
      profile: 'base',
      quant: 'int8',
      note: '未检测到可用 GPU，CPU 运行会很慢；建议先只做下载与环境准备。',
      estimatedLabel: 'CPU：30 分钟以上',
    }
  }
  if (memoryGb >= 48) {
    return {
      width: 1024,
      height: 1024,
      steps: 50,
      profile: 'base',
      quant: 'bf16',
      note: '内存充足，可用官方 50 步全质量档；追求速度可切 8 步 DMD。',
      estimatedLabel: '约 6–15 分钟/张',
    }
  }
  if (memoryGb >= 24) {
    return {
      width: 1024,
      height: 1024,
      steps: 8,
      profile: 'dmd8',
      quant: 'bf16',
      note: '建议 1024² + 8 步 DMD；50 步请预留足够时间。',
      estimatedLabel: '约 1–4 分钟/张',
    }
  }
  if (memoryGb >= 15) {
    return {
      width: 768,
      height: 768,
      steps: 8,
      profile: 'dmd8',
      quant: 'int8',
      note: '16 GB 档：用 8 步 DMD + int8/混合精度，1024² 容易触发内存压力。',
      estimatedLabel: '约 1–3 分钟/张',
    }
  }
  return {
    width: 512,
    height: 512,
    steps: 8,
    profile: 'dmd8',
    quant: 'int4',
    note: '小内存设备：512² + int4 + 8 步 DMD，先保证能跑。',
    estimatedLabel: '约 30–90 秒/张',
  }
}

export async function scanEnvironment(
  settings: Settings,
  onProgress?: ProgressFn,
): Promise<EnvReport> {
  const report = (section: string, status: ScanProgress['status'], detail?: string): void =>
    onProgress?.({ section, status, detail })

  report('system', 'running')
  const cpu = os.cpus()
  const dataPath = paths.root()
  const modelsPath = paths.models(settings.modelsRoot)

  const [disk, pythons, git, uv, network, gpu] = await Promise.all([
    diskInfo(modelsPath),
    (report('tools', 'running'), detectPythons(settings)),
    detectTool(gitBinary(), ['--version']),
    detectTool('uv', ['--version']),
    (report('network', 'running'), probeNetwork(settings.networkMode)),
    (report('accelerator', 'running'), detectGpu()),
  ])

  report('system', 'done')
  report('tools', 'done')
  report('network', 'done')
  report('accelerator', 'done')
  report('memory', 'done')

  const device = {
    platform: process.platform,
    arch: process.arch,
    osVersion: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    cpuModel: cpu[0]?.model?.trim() || '未知 CPU',
    cpuCores: cpu.length,
    memoryTotal: os.totalmem(),
    memoryFree: await availableMemory(os.totalmem()),
    diskTotal: disk.total,
    diskFree: disk.free,
    dataPath,
    modelsPath,
  }

  const memoryGb = device.memoryTotal / GB
  const selected = network.selected
  const checks: CheckItem[] = [
    {
      id: 'os',
      group: 'system',
      label: '操作系统',
      status: 'ok',
      value: `${os.type()} ${os.release()} · ${process.arch}`,
      detail: 'MossStudio V1 优先支持 macOS arm64，Windows 版本在后续里程碑。',
    },
    {
      id: 'memory',
      group: 'memory',
      label: '内存',
      status: memoryGb >= 16 ? 'ok' : 'warn',
      value: `${memoryGb.toFixed(0)} GB 统一内存`,
      detail:
        memoryGb < 16
          ? '低于 16 GB 时请使用 512² + int4 档。'
          : `当前可用约 ${formatBytes(device.memoryFree)}（含可回收缓存）。`,
    },
    {
      id: 'disk',
      group: 'memory',
      label: '磁盘',
      status: device.diskFree < 30 * GB ? 'error' : device.diskFree < 60 * GB ? 'warn' : 'ok',
      value: `剩余 ${formatBytes(device.diskFree)} / ${formatBytes(device.diskTotal)}`,
      detail:
        device.diskFree < 60 * GB
          ? 'bf16 全量权重约 27 GB，加上运行时与输出，建议至少 60 GB 空闲。'
          : '空间足够容纳 bf16 权重与运行时。',
      actions: device.diskFree < 60 * GB ? [{ id: 'storage', label: '打开存储设置', kind: 'open-settings', payload: 'storage' }] : undefined,
    },
    {
      id: 'gpu',
      group: 'accelerator',
      label: 'GPU',
      status: gpu.available ? 'ok' : 'warn',
      value: gpu.available ? `${gpu.name}${gpu.cores ? ` · ${gpu.cores} 核` : ''}` : '未检测到 GPU',
      detail:
        gpu.kind === 'apple'
          ? '使用 PyTorch MPS 后端；大分辨率下注意统一内存压力。'
          : gpu.available
            ? '将按平台选择 CUDA 或 Vulkan 后端。'
            : '仍可下载模型与创建实例，但生成会很慢。',
    },
    {
      id: 'python',
      group: 'tools',
      label: 'Python',
      status: pythons.length ? 'ok' : 'warn',
      value: pythons.length ? pythons.map((p) => p.version).join(' / ') : '未找到 3.10+',
      detail: pythons.length
        ? `运行时默认使用 ${pythons[0]!.path}`
        : '可以稍后一键安装托管 Python，不要求系统预装。',
      actions: pythons.length ? undefined : [{ id: 'python', label: '查看安装方式', kind: 'open-settings', payload: 'runtime' }],
    },
    {
      id: 'git',
      group: 'tools',
      label: 'git',
      status: git.found ? 'ok' : 'error',
      value: git.version ?? '未安装',
      detail: git.found ? '用于拉取 MOSS-Image 的分支与提交。' : '实例管理依赖 git，请先安装。',
    },
    {
      id: 'network',
      group: 'network',
      label: '镜像策略',
      status: selected.git || selected.hf ? 'ok' : 'warn',
      value: [
        selected.git ? `git ${selected.git.replace(/^https?:\/\//, '').replace(/\/$/, '')}` : 'git 直连',
        selected.pip ? `pip ${selected.pip.replace(/^https?:\/\//, '').split('/')[0]}` : 'pip 默认',
        selected.hf ? `hf ${selected.hf.replace(/^https?:\/\//, '')}` : 'hf 直连',
      ].join(' · '),
      detail: '启动器会按延迟自动选择镜像；可在设置中固定。',
    },
  ]

  return {
    scannedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    device,
    gpu,
    pythons,
    tools: { git, uv },
    network,
    checks,
    recommendation: recommendationFor(device.memoryTotal, gpu),
  }
}
