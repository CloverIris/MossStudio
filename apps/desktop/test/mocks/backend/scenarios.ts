/**
 * The mutable state behind the mock backend, plus named starting scenarios.
 *
 * A scenario is plain data: handlers in ./index.ts read and write this state, so
 * a test changes what the "main process" knows by editing `backend.state`.
 */
import type { AiConversationInfo, AiProviderInfo } from '@shared/ai'
import type { UpdateDownloadState } from '@shared/release'
import { cliEngineFeatures } from '@shared/cliEngine'
import type { EngineAssetList, EngineMachine } from '@shared/engineChoice'
import { RELEASE_220, inventoryDevicesFor, machineFixture, type MachineName } from './machines'
import type {
  Catalog,
  Diagnostic,
  DownloadTask,
  EngineReadiness,
  EnvReport,
  GalleryItem,
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
  UpdateState,
} from '@shared/types'
import {
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
  gpuDeviceFixture,
  gpuInventoryFixture,
  jobFixture,
  launchDeviceFixture,
  settingsFixture,
  sshHostFixture,
  trainerVersionFixture,
  updateAvailableFixture,
  updateStateFixture,
} from './fixtures'

export interface MockBackendState {
  settings: Settings
  env: EnvReport | null
  updates: UpdateState
  updateDownload: UpdateDownloadState | null
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
  /** What the engine's machine probe found (engine:plan runs the real chooser over it). */
  engineMachine: EngineMachine
  /** The release engine:plan plans against. */
  engineAssets: EngineAssetList
  /** What `engine:features` answers; null = no usable engine. */
  engineFeatures: EngineFeatures | null
  controlAdapters: ControlAdapterEntry[]
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
  | MachineScenario
  | 'vulkanOnly'

/** First runs on the machines of ./machines.ts (old NVIDIA driver, Turing, Volta, AMD with/without ROCm, Intel, several GPUs, macOS). */
export type MachineScenario =
  | 'machineOldDriver'
  | 'machineTuring'
  | 'machineVolta'
  | 'machineAmdRocm'
  | 'machineAmd'
  | 'machineIntel'
  | 'machineMultiGpu'
  | 'machineMac'

/** Fresh state for a scenario; `patch` replaces top-level keys. */
export function scenario(name: ScenarioName = 'ready', patch: Partial<MockBackendState> = {}): MockBackendState {
  const base: MockBackendState = {
    settings: settingsFixture({ onboardingState: 'completed' }),
    env: envReportFixture(),
    updates: updateStateFixture(),
    updateDownload: null,
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
    gallery: [galleryItemFixture(0), galleryItemFixture(1), galleryItemFixture(2)],
    projects: [],
    aiProviders: [],
    conversations: [],
    engineFeatures: engineFeaturesFixture(),
    controlAdapters: [],
    engineMachine: machineFixture('nvidia'),
    engineAssets: RELEASE_220,
    localModelFolder: null,
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
    noGpu: () => ({ ...firstRun(), devices: [launchDeviceFixture({ id: 'cpu', name: 'CPU', kind: 'cpu', detail: 'Fixture CPU', memoryBytes: undefined })], gpuInventory: gpuInventoryFixture([]), engineMachine: { ...machineFixture('nvidia'), gpus: [] } }),
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
    /** Two components installed, the DiT interrupted mid-download. */
    modelPartiallyDownloaded: () => ({
      settings: settingsFixture({ onboardingState: 'active' }),
      catalog: catalogFixture({ installed: ['qwen35-encoder', 'flux2-vae-small'], partial: ['moss-sft-dit'] }),
    }),
    /** Engine and the recommended bundle installed. */
    ready: () => ({}),
    /** Ready, with one failed job in history and its diagnostic. */
    jobFailure: () => ({
      jobs: [jobFixture({ id: 'job-failed', state: 'failed', stage: 'denoise', error: { code: 'E_CUDA_OOM', message: 'CUDA out of memory' }, endedAt: base.updates.checkedAt })],
      diagnostics: [diagnosticFixture({ jobId: 'job-failed' })],
    }),
    /** Ready, and a newer release is published. */
    updateAvailable: () => ({ updates: updateAvailableFixture('1.1.0') }),
    /** Ready locally plus one SSH host with a GPU. */
    remoteHost: () => ({ hosts: [sshHostFixture()] }),
    /** Ready on an Intel Arc that only moss-infer-vulkan runs (兼容模式): text to image only, no LoRA. */
    vulkanOnly: () => ({
      gpuInventory: gpuInventoryFixture([gpuDeviceFixture({
        uuid: 'vk-8086-56a0-0', name: 'Intel(R) Arc(TM) A770 Graphics', vendor: 'intel', pciId: '8086:56a0', vulkanIndex: 0,
        computeCapability: undefined, driverVersion: undefined, utilizationPercent: undefined, memoryFreeBytes: undefined,
        memoryTotalBytes: 16 * 1024 ** 3,
      })]),
      engineFeatures: cliEngineFeatures('vulkan'),
    }),
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
  }

  const variant = name in machines ? machines[name as MachineScenario] : variants[name as Exclude<ScenarioName, MachineScenario>]
  return { ...base, ...variant(), ...patch }
}
