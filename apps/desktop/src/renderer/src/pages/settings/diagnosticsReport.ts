import { describeEngineReadiness } from '@shared/engineReadiness'
import type { AppInfo, Diagnostic, EngineReadiness, EnvReport, GpuInventorySnapshot, Settings } from '@shared/types'

export interface DiagnosticsInput {
  info: AppInfo | null
  env: EnvReport | null
  gpu: GpuInventorySnapshot | null
  engine: EngineReadiness | null
  settings: Settings | null
  diagnostics: Diagnostic[]
}

/**
 * Plain-text report people paste into an issue or the QQ group. No tokens,
 * passwords or host addresses: only versions, hardware and recent problems.
 */
export function diagnosticsReport(input: DiagnosticsInput, now = new Date()): string {
  const { info, env, gpu, engine, settings } = input
  const lines = [
    `MossStudio ${info?.version ?? env?.appVersion ?? '未知版本'}`,
    `生成时间 ${now.toISOString()}`,
    `系统 ${info?.platform ?? '—'} ${info?.arch ?? ''}${env?.device.osVersion ? ` · ${env.device.osVersion}` : ''}`.trim(),
    `Electron ${info?.electron ?? '—'} · Chrome ${info?.chrome ?? '—'} · Node ${info?.node ?? '—'}`,
  ]
  if (gpu?.devices.length) {
    for (const device of gpu.devices) {
      const cc = device.computeCapability ? ` · SM${device.computeCapability.major}${device.computeCapability.minor}` : ''
      const memory = device.memoryTotalBytes ? ` · ${Math.round(device.memoryTotalBytes / 1024 ** 3)} GB` : ''
      const driver = device.driverVersion ? ` · 驱动 ${device.driverVersion}` : ''
      lines.push(`GPU ${device.index} ${device.name}${memory}${cc}${driver}`)
    }
  } else {
    lines.push(`GPU 未检测到${gpu?.error ? `（${gpu.error}）` : ''}`)
  }
  lines.push(`引擎 ${engine ? describeEngineReadiness(engine) : '检测中'}`)
  for (const device of engine?.devices ?? []) lines.push(`  ${device.name}：${device.packageId ?? '没有可用的引擎'}`)
  if (settings) {
    lines.push(
      `引擎设置 ${settings.mossInferChannel} · ${settings.mossInferTier} · ${settings.mossInferMemoryMode}${
        Object.keys(settings.engineDeviceOverrides ?? {}).length
          ? ` · 指定引擎 ${Object.entries(settings.engineDeviceOverrides)
              .map(([gpu, id]) => `${gpu}=${id}`)
              .join(', ')}`
          : ''
      }`,
      `功能 远程主机 ${settings.remoteHostsEnabled ? '开' : '关'} · 训练 ${settings.trainingEnabled ? '开' : '关'} · 看图 ${settings.gbcEnabled ? '开' : '关'} · 局域网 ${settings.lanWebEnabled ? '开' : '关'}`,
    )
  }
  const failing = env?.checks.filter((check) => check.status === 'error' || check.status === 'warn') ?? []
  if (failing.length) {
    lines.push('', '环境检查')
    for (const check of failing) lines.push(`- ${check.label}：${check.value}${check.detail ? `（${check.detail}）` : ''}`)
  }
  const recent = [...input.diagnostics].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 10)
  if (recent.length) {
    lines.push('', '最近的问题')
    for (const item of recent) lines.push(`- [${item.severity}] ${item.title}${item.count > 1 ? ` ×${item.count}` : ''} · ${item.lastAt}`)
  }
  return lines.join('\n')
}
