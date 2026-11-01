import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EngineReadiness } from '@shared/types'
import { mapEngineGpuProbe } from '@shared/gpuCompatibility'
import {
  judgeEngineSupport,
  matchEngineDevice,
  protocolCompatible,
} from '@shared/engineProtocol'
import {
  getEngineInstallProgress,
  readEngineLastAttempt,
} from '../lib/engineStore'
import { paths } from '../lib/paths'
import { probeEngine } from '../lib/probeEngine'
import { resolveGpuSelection } from '../lib/gpuInventory'
import { getGpuInventory } from './devices'
import { localEngineVersions, manifestForLocalEngineVersion } from './engines'
import { resolveServerPath } from './mossInfer'
import { getSettings } from './settings'

type ReadinessBase = Omit<EngineReadiness, 'installing' | 'lastAttempt'>

let cache: { key: string; createdAt: number; value: ReadinessBase } | null = null

export function invalidateEngineReadiness(): void {
  cache = null
}

async function calculateReadiness(force: boolean): Promise<ReadinessBase> {
  const settings = getSettings()
  const path = resolveServerPath(settings)
  if (!path || !existsSync(path)) {
    return { state: 'missing', path: null, reason: '未找到 moss-server；请下载引擎或设置路径', gpus: [] }
  }
  const inventory = await getGpuInventory()
  const version = localEngineVersions().find((item) => resolve(item.path) === resolve(path))
  const manifest = version ? manifestForLocalEngineVersion(version) : null
  const displayGpu = resolveGpuSelection(inventory.devices, settings.gpuSelection)
  let state: EngineReadiness['state']
  let reason: string | undefined
  if (!version || !manifest || !version.verified) {
    state = 'unverified'
    reason = version?.unverifiedReason ?? '当前引擎没有验证记录；请执行「验证并切换」'
  } else if (manifest.protocol !== 2) {
    state = 'unsupported'
    reason = `引擎协议为 ${manifest.protocol}，需要 protocol 2`
  } else {
    state = 'ready'
    const selection = settings.gpuSelection
    if (typeof selection === 'object') {
      const selected = inventory.devices.find((device) => device.uuid === selection.uuid)
      // auto 或已拔除的 GPU 不做 stale 判断；显式选择且仍在机的 GPU 必须与验证记录匹配。
      if (selected) {
        const matches = manifest.device && matchEngineDevice(
          [manifest.device],
          { index: selected.index, name: selected.name },
        )
        if (!matches) {
          state = 'stale'
          reason = `验证记录对应 ${manifest.device?.name || '其他 GPU'}，当前选择的是 ${selected.name}；请重新验证并切换`
        }
      }
    }
  }

  const value: ReadinessBase = {
    state,
    path,
    engineVersion: manifest?.engineVersion ?? version?.engineVersion,
    protocol: manifest?.protocol ?? version?.protocol,
    capability: manifest?.device?.compute ?? version?.capability,
    architecture: manifest?.architecture ?? version?.architecture,
    flavour: manifest?.flavour ?? version?.flavour,
    variant: manifest?.variant ?? version?.variant,
    verifiedAt: manifest?.verifiedAt ?? version?.verifiedAt,
    reason,
    device: manifest?.device,
    gpus: manifest
      ? mapEngineGpuProbe(inventory.devices, manifest.devices, path, manifest.engineVersion, manifest.verifiedAt).devices
      : [],
  }

  if (force && (state === 'unverified' || state === 'stale')) {
    try {
      const hello = await probeEngine(path)
      value.engineVersion = hello.version ?? value.engineVersion
      value.protocol = hello.protocol
      value.gpus = mapEngineGpuProbe(inventory.devices, hello.probe?.devices ?? [], path, hello.version).devices
      value.device = displayGpu
        ? matchEngineDevice(hello.probe?.devices ?? [], displayGpu)
        : hello.probe?.devices[0]
      value.capability = value.device?.compute ?? null
      if (!protocolCompatible(hello)) {
        value.state = 'unsupported'
        value.reason = `引擎协议为 ${hello.protocol}，需要 protocol 2`
      } else if (displayGpu) {
        const verdict = judgeEngineSupport(
          hello,
          { index: displayGpu.index, name: displayGpu.name },
          { inventoryCapability: displayGpu.computeCapability },
        )
        value.reason = verdict.ok
          ? state === 'unverified'
            ? '本次探测已完成；仍需「验证并切换」写入验证记录'
            : '当前 GPU 已变化；请重新验证并切换'
          : verdict.reason
      }
    } catch (error) {
      value.reason = `引擎探测失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  return value
}

export async function engineReadiness(options: { force?: boolean } = {}): Promise<EngineReadiness> {
  const settings = getSettings()
  const path = resolveServerPath(settings)
  const fingerprint = path && existsSync(path)
    ? `${resolve(path)}:${statSync(path).mtimeMs}:${JSON.stringify(settings.gpuSelection)}`
    : `missing:${JSON.stringify(settings.gpuSelection)}`
  const force = options.force === true
  let base: ReadinessBase
  if (cache?.key === fingerprint && Date.now() - cache.createdAt < 30_000 &&
      !(force && (cache.value.state === 'unverified' || cache.value.state === 'stale'))) {
    base = cache.value
  } else {
    base = await calculateReadiness(force)
    cache = { key: fingerprint, createdAt: Date.now(), value: base }
  }
  return {
    ...base,
    installing: getEngineInstallProgress() ?? undefined,
    lastAttempt: readEngineLastAttempt(paths.mossinfer()) ?? undefined,
  }
}
