import { join } from 'node:path'
import type { OnboardingStatus, OnboardingStep, Settings } from '@shared/types'
import { paths } from '../lib/paths'
import { listDevices } from './devices'
import { getCatalog } from './models'
import { legacyModelReady } from './modelReadiness'
import { resolveServerPath } from './mossInfer'
import { getTrainingHost } from './trainingHosts'
import { remoteEngineStatus } from './remoteEngine'
import { scanRemoteModels } from './remoteModels'

export async function getOnboardingStatus(settings: Settings, hostId = 'local'): Promise<OnboardingStatus> {
  const catalog = await getCatalog(settings, true)
  let installed = new Set(catalog.models.filter((model) => model.installed).map((model) => model.id))
  let deviceReady: boolean
  let deviceDetail: string
  let engineReady: boolean
  let engineDetail: string
  let fullModelReady = false

  if (hostId === 'local') {
    const gpu = listDevices(settings).find((device) => device.kind === 'cuda' && device.available)
    deviceReady = Boolean(gpu)
    deviceDetail = gpu?.name ?? (process.platform === 'darwin'
      ? 'macOS 请在设备页添加 Linux NVIDIA SSH 主机，并在此切换准备位置'
      : '需要可用的 NVIDIA GPU；也可以添加 Linux NVIDIA SSH 主机')
    engineReady = resolveServerPath(settings) !== null
    engineDetail = engineReady ? 'MossInfer 已安装' : '下载 MossInfer；缺少系统 CUDA 库时可选择 bundled 包'
    fullModelReady = catalog.models.some((model) => model.role === 'full' && model.installed && model.format !== 'comfyui')
      || await legacyModelReady(join(paths.hub(settings.modelsRoot), 'models--OpenMOSS-Team--MOSS-Image-SFT'))
  } else {
    const host = getTrainingHost(settings, hostId)
    if (!host || host.kind !== 'ssh') throw new Error('SSH 主机已移除，请重新选择准备位置')
    const engine = await remoteEngineStatus(host)
    deviceReady = engine.online && Boolean(engine.gpu)
    deviceDetail = engine.online ? engine.gpu || '远端未检测到 NVIDIA GPU' : 'SSH 未连接，请在设备页检查连接'
    engineReady = engine.online && engine.available
    engineDetail = engineReady ? `${host.name} · MossInfer 已安装` : '在引擎页为这台 SSH 主机安装 MossInfer'
    const inventory = engine.online ? await scanRemoteModels(host, catalog) : null
    // A local download must never complete a remote host's checklist.
    installed = new Set(inventory?.models.filter((model) => model.installed).map((model) => model.id) ?? [])
  }

  const ids = (bundle: typeof catalog.bundles[number]): string[] => [...Object.values(bundle.components), bundle.support]
  const score = (bundle: typeof catalog.bundles[number]): number => ids(bundle).reduce((total, id) =>
    total + (installed.has(id) ? 2 : hostId === 'local' && catalog.models.find((model) => model.id === id)?.installState === 'partial' ? 1 : 0), 0,
  )
  const bundle = [...catalog.bundles].sort((a, b) => score(b) - score(a) || Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)))[0]
  let modelIds = bundle ? ids(bundle) : []
  let bundleName = bundle?.name
  let modelCount = fullModelReady ? modelIds.length : modelIds.filter((id) => installed.has(id)).length
  // Single-file MossInfer overrides still need the bundle's configs and tokenizer.
  // Count the actual installed weights instead of asking for another BF16 download.
  if (bundle && !fullModelReady && catalog.models.some((model) => model.id === 'moss-runtime-config')) {
    const singleFile = (role: 'dit' | 'text_encoder') => catalog.models.find((model) =>
      installed.has(model.id) && model.role === role && model.family === 'moss-image'
      && model.format === 'comfyui' && ['bf16', 'int8', 'int4', 'w4a8'].includes(model.precision),
    )
    const dit = singleFile('dit')
    const textEncoder = singleFile('text_encoder')
    if (dit || textEncoder) {
      const candidates = [dit?.id ?? bundle.components.dit, textEncoder?.id ?? bundle.components.textEncoder,
        bundle.components.vae, 'moss-runtime-config']
      const count = candidates.filter((id) => installed.has(id)).length
      if (count > modelCount) {
        modelIds = candidates
        modelCount = count
        bundleName = 'MossInfer 单文件组合'
      }
    }
  }
  const modelReady = fullModelReady || modelIds.length > 0 && modelCount === modelIds.length
  const partialModel = modelCount > 0 || hostId === 'local' && modelIds.some((id) => catalog.models.find((model) => model.id === id)?.installState === 'partial')
  const steps: OnboardingStep[] = [
    { id: 'device', status: deviceReady ? 'ok' : 'missing', title: '推理设备', detail: deviceDetail, action: 'devices' },
    { id: 'engine', status: engineReady ? 'ok' : 'missing', title: 'MossInfer 引擎', detail: engineDetail, action: 'engines' },
    {
      id: 'model', title: '模型', action: 'models', modelIds,
      status: modelReady ? 'ok' : partialModel ? 'partial' : 'missing',
      detail: modelReady ? `${bundleName ?? '完整模型'} 已就绪`
        : `${bundleName ?? 'MOSS-Image'} · ${modelCount}/${modelIds.length || 4} 个组件已就绪，需准备主模型、文本编码器、VAE 与配置`,
      sizeBytes: catalog.models.filter((model) => modelIds.includes(model.id) && !installed.has(model.id)).reduce((total, model) => total + model.sizeBytes, 0),
    },
  ]
  return { hostId, bundleId: bundle?.id, bundleName, ready: steps.every((step) => step.status === 'ok'), steps, checkedAt: new Date().toISOString() }
}
