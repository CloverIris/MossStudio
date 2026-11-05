import { join } from 'node:path'
import type { OnboardingStatus, OnboardingStep, Settings } from '@shared/types'
import { paths } from '../lib/paths'
import { cachedGpuInventory, listDevices } from './devices'
import { getCatalog } from './models'
import { legacyModelReady } from './modelReadiness'
import { engineReadiness } from './engineReadiness'
import { describeEngineReadiness } from '@shared/engineReadiness'
import { getTrainingHost } from './trainingHosts'
import { remoteEngineStatus } from './remoteEngine'
import { scanRemoteModels } from './remoteModels'
import { localEngineKinds } from './engineInstalls'
import { cliBundleProblem, type CliEngineKind } from '@shared/cliEngine'

export async function getOnboardingStatus(settings: Settings, hostId = 'local'): Promise<OnboardingStatus> {
  const catalog = await getCatalog(settings, true)
  let installed = new Set(catalog.models.filter((model) => model.installed).map((model) => model.id))
  let deviceReady: boolean
  let deviceDetail: string
  let engineStepStatus: OnboardingStep['status']
  let engineDetail: string
  let fullModelReady = false
  // Every local GPU runs moss-infer-vulkan / moss-infer-hip: only a complete bf16 bundle works there.
  let cliKind: CliEngineKind | null = null

  if (hostId === 'local') {
    const kinds = localEngineKinds()
    if (kinds.length > 0 && kinds.every((kind) => kind === 'vulkan' || kind === 'hip')) cliKind = kinds[0] as CliEngineKind
    // NVIDIA from nvidia-smi; AMD / Intel GPUs from the engine's machine probe (merged into the GPU inventory).
    const gpu = listDevices(settings).find((device) => device.kind === 'cuda' && device.available)
      ?? cachedGpuInventory()?.devices.find((device) => device.vendor && device.vendor !== 'nvidia')
    deviceReady = Boolean(gpu)
    deviceDetail = gpu?.name ?? (process.platform === 'darwin'
      ? 'macOS 请在设备页添加 Linux NVIDIA SSH 主机，并在此切换准备位置'
      : '需要一块能运行引擎的显卡（NVIDIA、AMD 或 Intel）；也可以添加 Linux NVIDIA SSH 主机')
    const readiness = await engineReadiness()
    engineStepStatus = readiness.state === 'ready'
      ? 'ok'
      : 'missing'
    engineDetail = describeEngineReadiness(readiness)
    fullModelReady = catalog.models.some((model) => model.role === 'full' && model.installed && model.format !== 'comfyui'
      && (!cliKind || model.precision === 'bf16'))
      || await legacyModelReady(join(paths.hub(settings.modelsRoot), 'models--OpenMOSS-Team--MOSS-Image-SFT'))
  } else {
    const host = getTrainingHost(settings, hostId)
    if (!host || host.kind !== 'ssh') throw new Error('SSH 主机已移除，请重新选择准备位置')
    const engine = await remoteEngineStatus(host)
    deviceReady = engine.online && Boolean(engine.gpu)
    deviceDetail = engine.online ? engine.gpu || '远端未检测到 NVIDIA GPU' : 'SSH 未连接，请在设备页检查连接'
    engineStepStatus = engine.online && engine.available ? 'ok' : 'missing'
    engineDetail = engineStepStatus === 'ok' ? `${host.name} · MossInfer 已安装` : '在引擎页为这台 SSH 主机安装 MossInfer'
    const inventory = engine.online ? await scanRemoteModels(host, catalog) : null
    // A local download must never complete a remote host's checklist.
    installed = new Set(inventory?.models.filter((model) => model.installed).map((model) => model.id) ?? [])
  }

  const ids = (bundle: typeof catalog.bundles[number]): string[] => [...Object.values(bundle.components), bundle.support]
  const score = (bundle: typeof catalog.bundles[number]): number => ids(bundle).reduce((total, id) =>
    total + (installed.has(id) ? 2 : hostId === 'local' && catalog.models.find((model) => model.id === id)?.installState === 'partial' ? 1 : 0), 0,
  )
  const usable = cliKind ? catalog.bundles.filter((item) => cliBundleProblem(cliKind!, item, catalog.models) === null) : catalog.bundles
  const bundle = [...usable].sort((a, b) => score(b) - score(a) || Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)))[0]
  let modelIds = bundle ? ids(bundle) : []
  let bundleName = bundle?.name
  let modelCount = fullModelReady ? modelIds.length : modelIds.filter((id) => installed.has(id)).length
  // Single-file MossInfer overrides still need the bundle's configs and tokenizer.
  // Count the actual installed weights instead of asking for another BF16 download.
  if (bundle && !fullModelReady && !cliKind && catalog.models.some((model) => model.id === 'moss-runtime-config')) {
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
    { id: 'engine', status: engineStepStatus, title: 'MossInfer 引擎', detail: engineDetail, action: 'engines' },
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
