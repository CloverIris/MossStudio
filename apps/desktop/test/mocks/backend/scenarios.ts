/**
 * The mutable state behind the mock backend, plus named starting scenarios.
 *
 * A scenario is plain data: handlers in ./index.ts read and write this state, so
 * a test changes what the "main process" knows by editing `backend.state`.
 */
import type { AiConversationInfo, AiProviderInfo } from '@shared/ai'
import type { UpdaterState } from '@shared/update'
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
} from '@shared/types'
import {
  FIXTURE_NOW,
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
  /** What `engine:features` answers; null = no usable engine. */
  engineFeatures: EngineFeatures | null
  controlAdapters: ControlAdapterEntry[]
  /** Setup and uninstall windows (see ./install.ts). */
  install: MockInstallState
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
    gallery: [galleryItemFixture(0), galleryItemFixture(1), galleryItemFixture(2)],
    projects: [],
    aiProviders: [],
    conversations: [],
    engineFeatures: engineFeaturesFixture(),
    controlAdapters: [],
    install: installStateFixture(),
  }

  const firstRun = (): Partial<MockBackendState> => ({
    settings: settingsFixture({ onboardingState: 'pending' }),
    catalog: catalogFixture(),
    engineReadiness: engineMissingFixture(),
    engineVersions: [],
    engineFeatures: null,
    gallery: [],
  })

  const variants: Record<ScenarioName, () => Partial<MockBackendState>> = {
    /** Nothing installed: onboarding pending, no engine, no model, a usable GPU. */
    firstRun,
    /** First run on a machine without an NVIDIA GPU. */
    noGpu: () => ({ ...firstRun(), devices: [launchDeviceFixture({ id: 'cpu', name: 'CPU', kind: 'cpu', detail: 'Fixture CPU', memoryBytes: undefined })], gpuInventory: gpuInventoryFixture([]) }),
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
      jobs: [jobFixture({ id: 'job-failed', state: 'failed', stage: 'denoise', error: { code: 'E_CUDA_OOM', message: 'CUDA out of memory' }, endedAt: FIXTURE_NOW })],
      diagnostics: [diagnosticFixture({ jobId: 'job-failed' })],
    }),
    /** Ready, and a newer release is published. */
    updateAvailable: () => ({ update: updateAvailableFixture('1.1.0') }),
    /** Ready locally plus one SSH host with a GPU. */
    remoteHost: () => ({ hosts: [sshHostFixture()] }),
  }

  return { ...base, ...variants[name](), ...patch }
}
