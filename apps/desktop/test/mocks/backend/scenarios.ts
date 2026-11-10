/**
 * The mutable state behind the mock backend, plus named starting scenarios.
 *
 * A scenario is plain data: handlers in ./index.ts read and write this state, so
 * a test changes what the "main process" knows by editing `backend.state`.
 */
import type { AiConversationInfo, AiProviderInfo } from '@shared/ai'
import type { GbcParseResult, GbcStatus } from '@shared/gbc'
import type { UpdaterState } from '@shared/update'
import { cliEngineFeatures } from '@shared/cliEngine'
import type { EngineAssetList, EngineMachine } from '@shared/engineChoice'
import { RELEASE_220, inventoryDevicesFor, machineFixture, type MachineName } from './machines'
import type {
  Catalog,
  Diagnostic,
  DownloadTask,
  EngineReadiness,
  EnvReport,
  GalleryDetail,
  GalleryItem,
  GbcVersion,
  GpuInventorySnapshot,
  JobLogLine,
  JobRecord,
  LaunchDevice,
  LaunchRow,
  LocalEngineVersion,
  ManagedHost,
  MossInferDownloadState,
  MossInferRelease,
  ControlAdapterEntry,
  EngineFeatures,
  ProjectDocument,
  Settings,
  TrainerVersion,
} from '@shared/types'
import {
  FIXTURE_MODELS_PATH,
  FIXTURE_NOW,
  GiB,
  SFT_BUNDLE_IDS,
  catalogFixture,
  diagnosticFixture,
  engineDownloadFixture,
  engineFeaturesFixture,
  engineReleaseFixture,
  engineMissingFixture,
  engineReadyFixture,
  engineVersionFixture,
  envReportFixture,
  galleryItemFixture,
  gbcParseFixture,
  gbcStatusFixture,
  GPU_RTX_5090,
  gpuDeviceFixture,
  gpuInventoryFixture,
  jobFixture,
  launchDeviceFixture,
  settingsFixture,
  sshHostFixture,
  trainerVersionFixture,
  updateAvailableFixture,
  updaterStateFixture,
} from './fixtures'
import { installStateFixture, type MockInstallState } from './install'

export interface MockBackendState {
  settings: Settings
  env: EnvReport | null
  /** The update runtime (main/update); handlers keep it in step like main does. */
  update: UpdaterState
  catalog: Catalog
  downloads: DownloadTask[]
  jobs: JobRecord[]
  jobLogs: Record<string, JobLogLine[]>
  diagnostics: Diagnostic[]
  devices: LaunchDevice[]
  launchRows: LaunchRow[]
  gpuInventory: GpuInventorySnapshot
  engineReadiness: EngineReadiness
  engineVersions: LocalEngineVersion[]
  engineDownload: MossInferDownloadState | null
  engineReleases: MossInferRelease[]
  trainerVersions: TrainerVersion[]
  hosts: ManagedHost[]
  gallery: GalleryItem[]
  projects: ProjectDocument[]
  aiProviders: AiProviderInfo[]
  conversations: AiConversationInfo[]
  /** The folder 「使用本地文件夹」 picks (models:import-folder); null = the dialog is canceled. */
  localModelFolder: { path: string; name: string; bundleId: string } | null
  /** 用电脑上的模型文件…: loose files in the picked folder, when it holds no complete model folder. */
  localModelFiles: Array<{ path: string; role: 'dit' | 'text_encoder' | 'vae' }> | null
  /** What the engine's machine probe found (engine:plan runs the real chooser over it). */
  engineMachine: EngineMachine
  /** The release engine:plan plans against. */
  engineAssets: EngineAssetList
  /** What `engine:features` answers; null = no usable engine. */
  engineFeatures: EngineFeatures | null
  controlAdapters: ControlAdapterEntry[]
  /** Setup and uninstall windows (see ./install.ts). */
  install: MockInstallState
  /** System memory app:info reports (os.totalmem). */
  systemMemoryBytes: number
  /** Free space models:space reports for a models folder; a folder not listed has plenty. */
  diskFree: Record<string, number>
  /** 看图拆区域: whether GBC runs, its versions, and what reading a picture finds. */
  gbc: { status: GbcStatus; versions: GbcVersion[]; parse: GbcParseResult }
}

export type ScenarioName =
  | 'firstRun'
  | 'noGpu'
  | 'engineInstalling'
  | 'engineInstalledModelMissing'
  | 'modelPartiallyDownloaded'
  | 'ready'
  | 'jobFailure'
  | 'updateAvailable'
  | 'remoteHost'
  | 'modelMissingRtx50'
  | MachineScenario
  | 'vulkanOnly'
  | 'lowMemory'
  | 'lowDisk'

/**
 * First runs on the machines of ./machines.ts (old NVIDIA driver, Turing, Volta, AMD with/without ROCm, Intel, several GPUs, macOS,
 * a GPU the engine cannot use, a 2 GB card, a 6 GB card, a laptop with a 2 GB card and a usable integrated GPU).
 */
export type MachineScenario =
  | 'machineOldDriver'
  | 'machineTuring'
  | 'machineVolta'
  | 'machineAmdRocm'
  | 'machineAmd'
  | 'machineIntel'
  | 'machineMultiGpu'
  | 'machineMac'
  | 'machineUnusableGpu'
  | 'machineTinyGpu'
  | 'machineSmallGpu'
  | 'machineLaptopSmallGpu'

/** Fresh state for a scenario; `patch` replaces top-level keys. */
export function scenario(name: ScenarioName = 'ready', patch: Partial<MockBackendState> = {}): MockBackendState {
  const base: MockBackendState = {
    settings: settingsFixture({ onboardingState: 'completed' }),
    env: envReportFixture(),
    update: updaterStateFixture(),
    catalog: catalogFixture({ installed: SFT_BUNDLE_IDS }),
    downloads: [],
    jobs: [],
    jobLogs: {},
    diagnostics: [],
    devices: [launchDeviceFixture()],
    launchRows: [],
    gpuInventory: gpuInventoryFixture(),
    engineReadiness: engineReadyFixture(),
    engineVersions: [engineVersionFixture()],
    engineDownload: null,
    engineReleases: [engineReleaseFixture()],
    trainerVersions: [trainerVersionFixture()],
    hosts: [],
    // The newest one carries a negative prompt, as images made in 创作 do (the detail panel reads it).
    gallery: [
      galleryItemFixture(0, { negativePrompt: 'blurry, watermark' } as Partial<GalleryDetail>),
      galleryItemFixture(1),
      galleryItemFixture(2),
    ],
    projects: [],
    aiProviders: [],
    conversations: [],
    gbc: { status: gbcStatusFixture(false), versions: [], parse: gbcParseFixture() },
    engineFeatures: engineFeaturesFixture(),
    controlAdapters: [],
    install: installStateFixture(),
    engineMachine: machineFixture('nvidia'),
    engineAssets: RELEASE_220,
    localModelFolder: null,
    localModelFiles: null,
    systemMemoryBytes: 32 * GiB,
    diskFree: {},
  }

  const firstRun = (): Partial<MockBackendState> => ({
    settings: settingsFixture({ onboardingState: 'pending' }),
    catalog: catalogFixture(),
    engineReadiness: engineMissingFixture(),
    engineVersions: [],
    engineFeatures: null,
    gallery: [],
  })

  const variants: Record<Exclude<ScenarioName, MachineScenario>, () => Partial<MockBackendState>> = {
    /** Nothing installed: onboarding pending, no engine, no model, a usable GPU. */
    firstRun,
    /** First run on a machine without an NVIDIA GPU. */
    noGpu: () => ({
      ...firstRun(),
      devices: [launchDeviceFixture({ id: 'cpu', name: 'CPU', kind: 'cpu', detail: 'Fixture CPU', memoryBytes: undefined })],
      gpuInventory: gpuInventoryFixture([]),
      engineMachine: { ...machineFixture('nvidia'), gpus: [] },
    }),
    /** First run with the engine download in flight. */
    engineInstalling: () => ({
      ...firstRun(),
      engineDownload: engineDownloadFixture({ phase: 'downloading', bytes: 450_000_000, percent: 50, speedBps: 20_000_000 }),
    }),
    /** Engine ready but none of the bundle's weights are present. */
    engineInstalledModelMissing: () => ({
      settings: settingsFixture({ onboardingState: 'active' }),
      catalog: catalogFixture(),
    }),
    /** Engine ready on an RTX 5090 (the only kind that runs NVFP4), no model downloaded yet. */
    modelMissingRtx50: () => ({
      settings: settingsFixture({ onboardingState: 'completed' }),
      catalog: catalogFixture(),
      gpuInventory: gpuInventoryFixture([GPU_RTX_5090()]),
    }),
    /** Two components installed, the DiT interrupted mid-download. */
    modelPartiallyDownloaded: () => ({
      settings: settingsFixture({ onboardingState: 'active' }),
      catalog: catalogFixture({ installed: ['qwen35-encoder', 'flux2-vae-small'], partial: ['moss-sft-dit'] }),
    }),
    /** Engine and the recommended bundle installed. */
    ready: () => ({}),
    /** Ready, with one failed job in history and its diagnostic. */
    jobFailure: () => ({
      jobs: [
        jobFixture({
          id: 'job-failed',
          state: 'failed',
          stage: 'denoise',
          error: { code: 'E_CUDA_OOM', message: 'CUDA out of memory' },
          endedAt: FIXTURE_NOW,
        }),
      ],
      diagnostics: [diagnosticFixture({ jobId: 'job-failed' })],
    }),
    /** Ready, and a newer release is published. */
    updateAvailable: () => ({ update: updateAvailableFixture('1.1.0') }),
    /** Ready locally plus one SSH host with a GPU. */
    remoteHost: () => ({ hosts: [sshHostFixture()] }),
    /** Ready on an Intel Arc that only moss-infer-vulkan runs (兼容模式): text to image only, no LoRA. */
    vulkanOnly: () => ({
      gpuInventory: gpuInventoryFixture([
        gpuDeviceFixture({
          uuid: 'vk-8086-56a0-0',
          name: 'Intel(R) Arc(TM) A770 Graphics',
          vendor: 'intel',
          pciId: '8086:56a0',
          vulkanIndex: 0,
          computeCapability: undefined,
          driverVersion: undefined,
          utilizationPercent: undefined,
          memoryFreeBytes: undefined,
          memoryTotalBytes: 16 * 1024 ** 3,
        }),
      ]),
      engineFeatures: cliEngineFeatures('vulkan'),
    }),
    /** First run on a computer with 8 GB of memory: it runs, slowly. */
    lowMemory: () => ({ ...firstRun(), systemMemoryBytes: 8 * GiB }),
    /** First run where the models folder has 12 GB free, less than the download needs. */
    lowDisk: () => ({ ...firstRun(), diskFree: { [FIXTURE_MODELS_PATH]: 12 * GiB } }),
  }

  /** First run on each kind of machine the engine chooser knows. */
  const onMachine = (machine: MachineName) => (): Partial<MockBackendState> => {
    const engineMachine = machineFixture(machine)
    return { ...firstRun(), engineMachine, gpuInventory: gpuInventoryFixture(inventoryDevicesFor(engineMachine)) }
  }
  const machines: Record<MachineScenario, () => Partial<MockBackendState>> = {
    machineOldDriver: onMachine('nvidiaOldDriver'),
    machineTuring: onMachine('turing'),
    machineVolta: onMachine('volta'),
    machineAmdRocm: onMachine('amdRocm'),
    machineAmd: onMachine('amd'),
    machineIntel: onMachine('intel'),
    machineMultiGpu: onMachine('multiGpu'),
    machineMac: onMachine('macos'),
    machineUnusableGpu: onMachine('unusableGpu'),
    machineTinyGpu: onMachine('tinyGpu'),
    machineSmallGpu: onMachine('smallGpu'),
    // Main recommends the GPU that can run the model, not the 2 GB card (recommendedGpu).
    machineLaptopSmallGpu: () => {
      const machine = onMachine('laptopSmallGpu')()
      return { ...machine, gpuInventory: { ...machine.gpuInventory!, recommendedGpuUuid: machineFixture('laptopSmallGpu').gpus[1]!.id } }
    },
  }

  const variant = name in machines ? machines[name as MachineScenario] : variants[name as Exclude<ScenarioName, MachineScenario>]
  return { ...base, ...variant(), ...patch }
}
