import { join } from 'node:path'
import type { OnboardingStatus, OnboardingStep, Settings } from '@shared/types'
import { paths } from '../lib/paths'
import { cachedGpuInventory, listDevices } from './devices'
import { getCatalog, modelMissingBytes } from './models'
import { legacyModelReady } from './modelReadiness'
import { engineReadiness } from './engineReadiness'
import { describeEngineReadiness } from '@shared/engineReadiness'
import { getTrainingHost } from './trainingHosts'
import { remoteEngineStatus } from './remoteEngine'
import { scanRemoteModels } from './remoteModels'
import { localEngineKinds, resolveDeviceEngine } from './engineInstalls'
import { cliBundleProblem, type CliEngineKind } from '@shared/cliEngine'
import { isCliEngine } from '@shared/enginePackages'
import { bestBundleFor, bundleWeightProblem, generationGpus, isFileBundle, isFp16Dit } from '@shared/bundleFit'

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
    const gpu =
      listDevices(settings).find((device) => device.kind === 'cuda' && device.available) ??
      cachedGpuInventory()?.devices.find((device) => device.vendor && device.vendor !== 'nvidia')
    deviceReady = Boolean(gpu)
    deviceDetail =
      gpu?.name ??
      (process.platform === 'darwin'
        ? 'macOS 请在设备页添加 Linux NVIDIA SSH 主机，并在此切换准备位置'
        : '需要一块能运行引擎的显卡（NVIDIA、AMD 或 Intel）；也可以添加 Linux NVIDIA SSH 主机')
    const readiness = await engineReadiness()
    engineStepStatus = readiness.state === 'ready' ? 'ok' : 'missing'
    engineDetail = describeEngineReadiness(readiness)
    fullModelReady =
      catalog.models.some(
        // A registered FP16-fixed folder is a whole model the engine refuses (isFp16Dit).
        (model) =>
          model.role === 'full' &&
          model.installed &&
          model.format !== 'comfyui' &&
          !isFp16Dit(model) &&
          (!cliKind || model.precision === 'bf16'),
      ) || (await legacyModelReady(join(paths.hub(settings.modelsRoot), 'models--OpenMOSS-Team--MOSS-Image-SFT')))
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

  const ids = (bundle: (typeof catalog.bundles)[number]): string[] => [...Object.values(bundle.components), bundle.support]
  const score = (bundle: (typeof catalog.bundles)[number]): number =>
    ids(bundle).reduce(
      (total, id) =>
        total +
        (installed.has(id) ? 2 : hostId === 'local' && catalog.models.find((model) => model.id === id)?.installState === 'partial' ? 1 : 0),
      0,
    )
  // A combination saved with an FP16 main model has every part downloaded but runs nowhere.
  const loadable = catalog.bundles.filter((item) => bundleWeightProblem(item, catalog.models) === null)
  const usable = cliKind
    ? loadable.filter((item) => cliBundleProblem(cliKind!, item, catalog.models) === null)
    : hostId === 'local'
      ? loadable
      : // Another computer runs a model folder; single files load only on this one.
        loadable.filter((item) => !isFileBundle(item, catalog.models))
  // With nothing downloaded yet, the model that suits this computer's GPU comes first (as on the 模型 page).
  const gpus = hostId === 'local' ? generationGpus(cachedGpuInventory()?.devices, settings) : []
  const cliGpus = new Set(
    gpus.filter((device) => isCliEngine(resolveDeviceEngine(device.uuid)?.package ?? 'cuda')).map((device) => device.uuid),
  )
  const best = hostId === 'local' ? bestBundleFor(usable, gpus, cliGpus)?.bundle : undefined
  const bundle = [...usable].sort(
    (a, b) =>
      score(b) - score(a) ||
      Number(b.id === best?.id) - Number(a.id === best?.id) ||
      Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)),
  )[0]
  // Downloaded single files count through the single-file bundle they belong to
  // (score above), so the checklist names a model the Studio can actually run.
  const modelIds = bundle ? ids(bundle) : []
  const bundleName = bundle?.name
  const modelCount = fullModelReady ? modelIds.length : modelIds.filter((id) => installed.has(id)).length
  const modelReady = fullModelReady || (modelIds.length > 0 && modelCount === modelIds.length)
  // What is still to download, counted like the check before each download starts (a partial download counts its .part files).
  // Only this computer has the files to count.
  const missingParts = catalog.models.filter((model) => modelIds.includes(model.id) && !installed.has(model.id))
  const sizeBytes =
    hostId === 'local'
      ? (await Promise.all(missingParts.map((model) => modelMissingBytes(settings, model)))).reduce((total, bytes) => total + bytes, 0)
      : missingParts.reduce((total, model) => total + model.sizeBytes, 0)
  const partialModel =
    modelCount > 0 ||
    (hostId === 'local' && modelIds.some((id) => catalog.models.find((model) => model.id === id)?.installState === 'partial'))
  const steps: OnboardingStep[] = [
    { id: 'device', status: deviceReady ? 'ok' : 'missing', title: '推理设备', detail: deviceDetail, action: 'devices' },
    { id: 'engine', status: engineStepStatus, title: 'MossInfer 引擎', detail: engineDetail, action: 'engines' },
    {
      id: 'model',
      title: '模型',
      action: 'models',
      modelIds,
      status: modelReady ? 'ok' : partialModel ? 'partial' : 'missing',
      detail: modelReady
        ? `${bundleName ?? '完整模型'} 已就绪`
        : `${bundleName ?? 'MOSS-Image'} · ${modelCount}/${modelIds.length || 4} 个组件已就绪，需准备主模型、文本编码器、VAE 与配置`,
      sizeBytes,
    },
  ]
  return {
    hostId,
    bundleId: bundle?.id,
    bundleName,
    ready: steps.every((step) => step.status === 'ok'),
    steps,
    checkedAt: new Date().toISOString(),
  }
}
