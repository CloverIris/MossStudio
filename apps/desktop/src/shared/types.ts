import type { EngineMachine, EnginePlan } from './engineChoice'

export type CheckStatus = 'ok' | 'warn' | 'error' | 'unknown'

export type CheckActionKind = 'rescan' | 'open-settings' | 'open-url' | 'install-python' | 'switch-mirror'

export interface CheckAction {
  id: string
  label: string
  kind: CheckActionKind
  url?: string
  payload?: string
}

export interface CheckItem {
  id: string
  group: 'system' | 'accelerator' | 'memory' | 'tools' | 'network' | 'ports'
  label: string
  status: CheckStatus
  value: string
  detail?: string
  actions?: CheckAction[]
}

export interface DeviceInfo {
  platform: string
  arch: string
  osVersion: string
  hostname: string
  cpuModel: string
  cpuCores: number
  memoryTotal: number
  memoryFree: number
  diskTotal: number
  diskFree: number
  dataPath: string
  enginePath?: string
  modelsPath: string
}

export interface GpuInfo {
  kind: 'apple' | 'nvidia' | 'amd' | 'intel' | 'unknown'
  name: string
  cores?: number
  memoryBytes?: number
  metal?: boolean
  cuda?: string
  driver?: string
  available: boolean
}

export interface PythonInfo {
  path: string
  version: string
  source: 'system' | 'uv' | 'pyenv' | 'conda' | 'managed'
}

export interface PythonInstallState {
  phase: 'querying' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'
  bytes: number
  totalBytes: number
  percent: number
  version?: string
  path?: string
  error?: string
}

export interface ToolState {
  found: boolean
  version?: string
  path?: string
}

export interface NetworkProbe {
  id: string
  label: string
  url: string
  ok: boolean
  latencyMs: number | null
  error?: string
}

export interface NetworkSelection {
  git: string | null
  pip: string | null
  hf: string | null
  manifest: string | null
}

export interface NetworkReport {
  checkedAt: string
  mode: 'auto' | 'direct' | 'mirror'
  selected: NetworkSelection
  probes: NetworkProbe[]
}

export interface Recommendation {
  width: number
  height: number
  steps: number
  profile: 'base' | 'dmd8'
  quant: 'bf16' | 'int8' | 'int4'
  note: string
  estimatedLabel: string
}

export interface EnvReport {
  scannedAt: string
  appVersion: string
  device: DeviceInfo
  gpu: GpuInfo
  pythons: PythonInfo[]
  tools: { git: ToolState; uv: ToolState }
  network: NetworkReport
  checks: CheckItem[]
  recommendation: Recommendation
}

export type ModelDirectoryId = 'dit' | 'textEncoder' | 'vae' | 'support' | 'adapters'

export type ModelDirectories = Record<ModelDirectoryId, string | null>

/** One file or diffusers folder found by a read-only directory scan. */
export interface ScannedModel {
  path: string
  relativePath: string
  name: string
  size: number
  mtimeMs: number
  role: 'dit' | 'text_encoder' | 'vae' | 'support' | 'full' | 'lora'
  layout: 'comfyui-single-file' | 'diffusers-folder' | 'unknown'
  confidence: 'high' | 'medium' | 'low'
  hint: string
}

export interface ModelScanResult {
  root: string
  scannedAt: string
  files: number
  candidates: ScannedModel[]
  skipped: Array<{ path: string; reason: string }>
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  uiAnimation: 'system' | 'on' | 'off'
  language: 'zh-CN' | 'en'
  networkMode: 'auto' | 'direct' | 'mirror'
  gitMirror: string | null
  pipIndex: string | null
  hfEndpoint: string | null
  hasHfToken: boolean
  modelDownloadConcurrency: number
  hfQueryHostId: string | null
  modelsRoot: string | null
  modelDirectories: ModelDirectories
  pythonPath: string | null
  torchBackend: 'auto' | 'cpu' | 'cuda'
  torchIndex: string | null
  desktopNotifications: boolean
  lanWebEnabled: boolean
  lanWebPort: number | null
  lanWebInstanceId: string | null
  updateChannel: 'stable' | 'beta'
  /** 自动更新: download and prepare new versions in the background; the next start installs them. */
  autoDownloadUpdates: boolean
  /** Set by 回到上一个版本: this version (and older) is not offered again until the user asks. */
  skippedUpdateVersion: string | null
  dismissedAnnouncements: string[]
  /** Versions whose automatic rollback the user has already been told about (once each). */
  noticedFailedUpdates: string[]
  /** The version that ran last: a newer one starting says once that it was updated. */
  lastRunVersion: string | null
  sidebarCollapsed: boolean
  onboardingState: 'pending' | 'active' | 'dismissed' | 'completed'
  onboardingHostId: string
  galleryRoots: string[]
  homeBackground: string | null
  trainerRoot: string | null
  engineRoot: string | null
  gbcRoot: string | null
  inferenceBackend: 'runner' | 'mossinfer'
  mossInferServerPath: string | null
  mossInferMemoryMode: 'min_memory' | 'balanced' | 'max_speed'
  mossInferTier: 'reference' | 'high' | 'turbo'
  /** Restart the engine after this many generations (0 = never) to release GPU memory and re-read the weights. */
  mossInferRefreshEvery: number
  mossInferChannel: 'stable' | 'dev'
  /** deviceUuid → engine package id (`cu13`, `vulkan`, …) chosen in 设置 › 设备 › 高级; absent = automatic. */
  engineDeviceOverrides: Record<string, string>
  gpuSelection: GpuSelection
  gpuProfileMode: 'auto' | 'custom'
  gpuProfileOverrides: Record<string, GpuProfileOverride>
  /** A GitHub token is saved (encrypted, githubCredentials.ts); the value never leaves the main process. */
  hasGithubToken: boolean
  disabledDevices: string[]
  deviceLabels: Record<string, string>
  /** Optional feature: run generation/training on SSH machines. Off by default. */
  remoteHostsEnabled: boolean
  /** Optional feature: LoRA training. Off by default. */
  trainingEnabled: boolean
  /** Keep the inference engine on the latest release of its channel automatically. */
  engineAutoUpdate: boolean
}

export type GpuSelection = 'auto' | { uuid: string }

export interface GpuProfileOverride {
  memoryMode?: Settings['mossInferMemoryMode']
  tier?: Settings['mossInferTier']
}

export interface GpuInventoryDevice {
  uuid: string
  index: number
  name: string
  computeCapability?: { major: number; minor: number }
  memoryTotalBytes?: number
  memoryFreeBytes?: number
  utilizationPercent?: number
  driverVersion?: string
  /** `10de:2757`. */
  pciId?: string
  /** Absent means NVIDIA (nvidia-smi rows); other GPUs come from the engine's Vulkan probe. */
  vendor?: 'nvidia' | 'amd' | 'intel' | 'other'
  /** Index of this GPU in `moss-infer-vulkan --list-devices`. */
  vulkanIndex?: number
  /** AMD on Linux: `gfx1100`. */
  gfxTarget?: string
}

export interface GpuInventorySnapshot {
  scannedAt: string
  status: 'ok' | 'unavailable' | 'error'
  devices: GpuInventoryDevice[]
  recommendedGpuUuid?: string
  error?: string
  capabilityNotice?: string
}

export interface EngineGpuCompatibility {
  uuid: string
  index: number
  name: string
  status: 'supported' | 'unsupported' | 'unknown'
  reason?: string
  freeMemoryBytes?: number
}

export interface EngineGpuProbeSnapshot {
  enginePath: string
  engineVersion?: string
  checkedAt: string
  devices: EngineGpuCompatibility[]
}

export interface GpuTelemetryDevice extends GpuInventoryDevice {
  memoryUsedBytes?: number
  runningTasks: number
  queuedTasks: number
}

export interface GpuTelemetrySnapshot {
  sampledAt: string
  status: 'ok' | 'unavailable' | 'error'
  devices: GpuTelemetryDevice[]
  recommendedGpuUuid?: string
  error?: string
}

export interface RemoteCudaProbe {
  checkedAt: string
  durationMs: number
  driverVersion?: string
  computeCapabilities: string[]
  libraries: Array<{
    path: string
    major: 12 | 13
    versionText?: string
    dependencyCheck: 'passed' | 'failed' | 'unavailable'
    error?: string
  }>
  flavours: Array<'cu12' | 'cu13'>
  foundFlavours?: Array<'cu12' | 'cu13'>
  recommendedFlavour?: 'cu12' | 'cu13'
  recommendedVariant?: 'system-cuda' | 'bundled'
  standardArchitectureSupported?: boolean
  gpuReason?: string
  /** nvidia-smi names, one per GPU in the order of computeCapabilities. */
  gpuNames?: string[]
  /** PCI ids of every display device (`/sys/class/drm`), to tell a host with only AMD / Intel GPUs. */
  pciIds?: string[]
  /** nvidia-smi did not answer within 15 s: the GPU list is unknown, not empty. */
  nvidiaSmiTimedOut?: boolean
  error?: string
}

export interface RemoteEngineInfo {
  online: boolean
  available: boolean
  path: string
  root: string
  gpu: string
  version?: string
  cuda?: RemoteCudaProbe
  error?: string
  checkedAt: string
}

export interface RemoteEngineInstallOptions {
  channel?: 'stable' | 'dev'
  flavour?: 'cu12' | 'cu13'
  variant?: 'system-cuda' | 'bundled'
  architecture?: 'auto' | 'standard' | 'sm75' | 'sm70'
  releaseTag?: string
}

export interface EngineRemoteProgress {
  hostId: string
  phase: 'checking' | 'querying' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error'
  message: string
  percent?: number
  bytes?: number
  totalBytes?: number
  speedBps?: number
}

export interface MossInferDownloadState {
  channel: 'stable' | 'dev'
  phase: 'querying' | 'downloading' | 'verifying' | 'extracting' | 'cuda_libs' | 'done' | 'error' | 'canceled'
  bytes: number
  totalBytes: number
  percent: number
  speedBps: number
  version?: string
  releaseTag?: string
  serverPath?: string
  recommendedFlavour?: string
  variant?: 'system-cuda' | 'bundled'
  architecture?: 'standard' | 'sm75' | 'sm70'
  /** Package ids this install covers (`cu13`, `vulkan`, …); on done/error the ones that landed. */
  packages?: string[]
  /** Which package of a multi-package install is in progress. */
  step?: { index: number; count: number; packageId: string }
  note?: string
  cublaslt?: unknown
  error?: string
  updatedAt: string
}

/** The engine plan for this computer (engine:plan): what was detected, which package each GPU gets, what is missing. */
export type EnginePlanView = EnginePlan & {
  channel: 'stable' | 'dev'
  /** The release planned against; null offline or on the dev channel without a release. */
  releaseTag: string | null
  machine: EngineMachine
  probedAt: string
  /** Probes that failed. */
  notes: string[]
  /** Package ids installed (newest of each). */
  installed: string[]
  /** Planned package ids not installed at this release yet. */
  missing: string[]
  releaseError?: string
}

export interface MossInferRelease {
  tag: string
  name: string
  publishedAt: string | null
  body: string
  assets: Array<{ name: string; size: number }>
}

export interface LocalEngineVersion {
  id: string
  name: string
  path: string
  current: boolean
  /** managed: unpacked under <userData>/mossinfer; external: a path the user picked. */
  source: 'managed' | 'external'
}

export interface EngineInstallAttempt {
  at: string
  version?: string
  error?: string
}

export interface EngineInstallProgress {
  phase: MossInferDownloadState['phase']
  percent: number
  version?: string
}

export type EngineReadinessState = 'missing' | 'ready'

export interface EngineReadiness {
  state: EngineReadinessState
  path: string | null
  reason?: string
  /** Per local GPU: the package it runs (null = nothing installed runs on it). */
  devices?: Array<{ deviceUuid: string; name: string; packageId: string | null; path: string | null }>
  installing?: EngineInstallProgress
  lastAttempt?: EngineInstallAttempt
}

export interface AppNotification {
  id: string
  tone: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  createdAt: string
  read: boolean
}

export interface BranchInfo {
  name: string
  sha: string
  isDefault: boolean
  isStable: boolean
}

export interface CommitInfo {
  sha: string
  short: string
  date: string
  subject: string
  author: string
}

export type InstanceChannel = 'stable' | 'experimental' | 'custom'
export type RuntimeMode = 'shared' | 'isolated'
export type RuntimeState = 'missing' | 'created' | 'installing' | 'ready' | 'error'

export type InstancePlacement = { kind: 'local' } | { kind: 'ssh'; hostId: string; hostName?: string; root: string }

export interface InstanceInfo {
  id: string
  name: string
  source: string
  branch: string
  commit: string
  shortCommit: string
  commitDate: string
  subject: string
  author: string
  channel: InstanceChannel
  runtimeId: string
  runtimeMode: RuntimeMode
  runtimeState: RuntimeState
  placement: InstancePlacement
  hostId?: string
  models: string[]
  modelBinding?: ModelBinding
  adapters: string[]
  adapterBindings?: Array<{ id: string; enabled: boolean; strength: number }>
  createdAt: string
  lastUsedAt: string | null
  path: string
  dirty: boolean
  status: 'ok' | 'missing' | 'runtime-missing'
}

export interface RuntimeInfo {
  torchIndex?: string | null
  id: string
  instanceId: string
  instanceIds: string[]
  path: string
  python: string
  pythonVersion: string
  lockHash: string
  kind: RuntimeMode
  state: RuntimeState
  hostId?: string
  remote?: boolean
  deps: string[]
  createdAt: string
}

export interface ModelEntry {
  id: string
  name: string
  provider: 'hf' | 'local'
  repo: string
  revision: string
  role: 'full' | 'dit' | 'text_encoder' | 'vae' | 'support'
  format?: 'diffusers' | 'comfyui'
  family?: string
  subfolder?: string
  installState?: 'missing' | 'partial' | 'ready' | 'error'
  resolvedRevision?: string
  precision: string
  sizeBytes: number
  /** When set, only these repo paths are downloaded (e.g. sft/transformer/*). */
  files?: string[]
  license: string
  tags: string[]
  notes?: string
  preview?: string
  localPath?: string
  installed: boolean
  installedBytes: number
}

export interface AdapterEntry {
  id: string
  name: string
  provider: 'hf' | 'local'
  repo: string
  revision: string
  kind: 'lora' | 'lycoris' | 'dmd'
  base?: string
  license: string
  files: string[]
  sizeBytes: number
  requiresProfile?: string
  tags: string[]
  notes?: string
  installed: boolean
  installedBytes: number
}

export interface ModelBinding {
  bundleId: string
  dit: string
  textEncoder: string
  vae: string
}

export interface ModelBundle {
  id: string
  name: string
  description: string
  components: Pick<ModelBinding, 'dit' | 'textEncoder' | 'vae'>
  support: string
  recommended?: boolean
}

export interface Catalog {
  bundles: ModelBundle[]
  updatedAt: string
  models: ModelEntry[]
  adapters: AdapterEntry[]
  source: 'local' | 'remote' | 'cache' | 'builtin'
}

export type DownloadState = 'queued' | 'running' | 'verifying' | 'paused' | 'done' | 'error' | 'canceled'

export interface DownloadTask {
  hostId?: string
  hostName?: string
  remotePath?: string
  revision?: string
  connectionError?: string
  id: string
  kind: 'model' | 'adapter'
  targetId: string
  label: string
  state: DownloadState
  filesTotal: number
  filesDone: number
  bytes: number
  totalBytes: number
  speedBps: number
  currentFile?: string
  error?: string
  updatedAt: string
}

export type TrainingHostKind = 'local' | 'ssh'
export type SshAuthMethod = 'identityFile' | 'password' | 'none'
export type TrainerChannel = 'stable' | 'experimental' | 'custom'
export type TrainerRuntimeState = 'missing' | 'created' | 'installing' | 'ready' | 'error'

export interface TrainingHost {
  id: string
  name: string
  kind: TrainingHostKind
  host?: string
  user?: string
  port?: number
  authMethod?: SshAuthMethod
  identityFile?: string
  hasPassword?: boolean
  trainerRoot: string
  /** MossInfer engine root on this host (default ~/.mossstudio/engine). */
  engineRoot?: string
  outputRoot?: string
  modelPath?: string
  /** Remote MOSS instance worktrees; used by the device manager and remote inference. */
  instanceRoot?: string
  /** Remote HF-compatible model cache; never auto-uploaded from the local cache. */
  modelsRoot?: string
  downloadProxy?: string
  hfEndpoint?: string
  downloadConcurrency?: number
  hasHfToken?: boolean
  status: 'unchecked' | 'ok' | 'error'
  lastCheckedAt?: string
  error?: string
  remote?: {
    os?: string
    gpu?: string
    git?: string
    uv?: string
    python?: string
    rootReady?: boolean
  }
  versions?: TrainerVersion[]
}

export interface ComputeDevice {
  id: string
  hostId: string
  hostName: string
  name: string
  kind: DeviceKind
  detail: string
  memoryBytes?: number
  available: boolean
  source: 'local' | 'remote'
}

export interface ManagedHost extends TrainingHost {
  devices: ComputeDevice[]
}

export interface TrainerVersion {
  id: string
  hostId: string
  hostName?: string
  name: string
  branch: string
  commit: string
  shortCommit: string
  commitDate: string
  subject: string
  author: string
  channel: TrainerChannel
  path: string
  runtimeId: string
  runtimeState: TrainerRuntimeState
  createdAt: string
  lastUsedAt?: string | null
  dirty: boolean
  status: 'ok' | 'missing'
}

export interface TrainerRunInput {
  versionId: string
  action: 'train' | 'inspect_data' | 'cache_text' | 'cache_latents' | 'export' | 'sample'
  runName: string
  weights: string
  dataset: string
  algo: string
  steps: number
  lr: string
  dim: string
  alpha: string
  batch: string
  resolution: number
  overrides: string
}

export interface TrainerRuntimeInfo {
  id: string
  versionId: string
  path: string
  python: string
  pythonVersion: string
  lockHash: string
  state: TrainerRuntimeState
  deps: string[]
  createdAt: string
}

export type WorkspaceKind = 'clover'
export type DeviceKind = 'mps' | 'cuda' | 'cpu'

export interface LaunchDevice {
  id: string
  name: string
  kind: DeviceKind
  detail: string
  memoryBytes?: number
  available: boolean
  hostId?: string
  source?: 'local' | 'remote'
}

export interface LaunchCase {
  id: string
  name: string
  instanceId: string
  workspace: WorkspaceKind
  deviceId: string
  profile: 'base' | 'dmd8'
  createdAt: string
  lastUsedAt?: string
}

export interface OnboardingStep {
  id: 'device' | 'engine' | 'model'
  status: 'ok' | 'missing' | 'partial'
  title: string
  detail: string
  action: 'devices' | 'engines' | 'models'
  modelIds?: string[]
  sizeBytes?: number
}

export interface OnboardingStatus {
  hostId: string
  bundleId?: string
  bundleName?: string
  ready: boolean
  steps: OnboardingStep[]
  checkedAt: string
}

export type JobMode = 'runner' | 'simulate' | 'training'
export type JobState = 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type JobStage = 'load' | 'text' | 'denoise' | 'decode' | 'save' | 'ready' | 'idle'

export interface JobParams {
  prompt: string
  negativePrompt: string
  width: number
  height: number
  steps: number
  cfg: number
  seed: number
  profile: 'base' | 'dmd8'
  adapters?: Array<{ path: string; strength: number }>
  /** Image-to-image: start from this picture instead of noise. */
  initImage?: JobInitImage
  /** Inpainting: only the white part of this PNG is repainted. Needs `initImage`. */
  mask?: JobMask
  /** A control adapter guided by one image per control kind (depth, edges, pose…). */
  control?: JobControl
  /** Reference pictures for an edit adapter (at most 4). */
  references?: JobReferences
  /** Sampler, scheduler and the second (hires) pass; absent fields use the engine's defaults. */
  sampling?: JobSampling
}

export type ImageResizeMode = 'crop' | 'fit' | 'stretch'

export interface JobInitImage {
  path: string
  /** 0 keeps the picture, 1 replaces it entirely. */
  strength: number
  resize?: ImageResizeMode
}

export interface JobMask {
  path: string
}

export interface JobControlImage {
  /** One of the adapter's `controlKinds`. */
  kind: string
  path: string
  /** 0–10, engine default 1. */
  strength: number
  /** Fraction of the denoise where this image starts/stops guiding, 0 ≤ start ≤ end ≤ 1. */
  start: number
  end: number
}

export interface JobControl {
  adapter: string
  loraStrength?: number
  images: JobControlImage[]
}

export interface JobReferences {
  paths: string[]
  /** 16–2048; the engine scales references so their long edge fits. */
  maxEdge?: number
}

export interface JobHires {
  width: number
  height: number
  steps?: number
  strength?: number
}

export interface JobSampling {
  /** A name from `EngineFeatures.values.sampler`. */
  sampler?: string
  /** A name from `EngineFeatures.values.scheduler`. */
  scheduler?: string
  shift?: number
  hires?: JobHires
  stepCache?: string
  cfgTruncation?: number
}

/** What the engine that will run a job can do, read from its hello. */
export interface EngineFeatures {
  /** Live preview images while denoising. */
  preview: boolean
  /** `initImage` and `mask`. */
  imageInput: boolean
  control: boolean
  references: boolean
  hires: boolean
  samplers: boolean
  /** LoRA adapters (`adapters`). */
  lora: boolean
  /** Set when the engine is a one-shot CLI (moss-infer-vulkan / moss-infer-hip): text to image only. */
  cli?: 'vulkan' | 'hip'
  /** Accepted names per enum parameter, e.g. `{ sampler: ['euler', …], scheduler: [...], resize: [...] }`. */
  values: Record<string, string[]>
}

/** A control adapter file registered with the app (identified by the engine's `inspect`). */
export interface ControlAdapterEntry {
  id: string
  name: string
  path: string
  sizeBytes: number
  /** Control kinds the file was trained for, e.g. `['depth', 'canny']`. */
  controlKinds: string[]
  baseModel?: string
  addedAt: string
}

export interface LaunchStartInput {
  instanceId: string
  caseId?: string
  caseName?: string
  workspace: WorkspaceKind
  deviceId: string
  profile: 'base' | 'dmd8'
}

export interface LaunchRow {
  id: string
  caseId?: string
  caseName: string
  instanceId: string
  instanceName: string
  workspace: WorkspaceKind
  deviceId: string
  profile: 'base' | 'dmd8'
  jobId?: string
  state: 'queued' | 'starting' | 'running' | 'stopped' | 'failed'
  queuedAt: string
  startedAt?: string
  error?: string
}

export interface JobStartInput {
  instanceId: string
  caseId?: string
  caseName?: string
  workspace?: WorkspaceKind
  deviceId?: string
  kind?: 'inference' | 'training'
  trainerVersionId?: string
  prompt: string
  negativePrompt?: string
  width: number
  height: number
  steps: number
  cfg: number
  seed: number
  profile?: 'base' | 'dmd8'
  mode?: 'runner' | 'simulate'
}

export interface JobProgress {
  stage: JobStage
  current: number
  total: number
  percent: number
  etaMs?: number
  message?: string
}

/** The memory mode and tier a job runs with, and what decided them. */
export interface JobGpuProfile {
  memoryMode: Settings['mossInferMemoryMode']
  tier: Settings['mossInferTier']
  /** model-weights: the DiT / text encoder files allow one tier only. hardware-compatibility: the GPU does. */
  source: 'recommended' | 'global' | 'gpu-override' | 'hardware-compatibility' | 'model-weights'
}

export interface JobRecord {
  modelSnapshot?: unknown
  engine?: 'runner' | 'mossinfer'
  projectId?: string
  canvasId?: string
  canvasLineage?: string[]
  /** The canvas's title when the job started, so Activity can name the job as the Studio card does. */
  canvasTitle?: string
  id: string
  instanceId: string
  instanceName: string
  caseId?: string
  caseName?: string
  workspace?: WorkspaceKind
  deviceId?: string
  deviceUuid?: string
  gpuSnapshot?: {
    index: number
    name: string
    computeCapability?: { major: number; minor: number }
  }
  gpuProfile?: JobGpuProfile
  kind?: 'inference' | 'training'
  trainerVersionId?: string
  trainerRunName?: string
  trainerAction?: string
  trainerWeights?: string
  trainerAlgo?: string
  trainerArtifact?: string
  hostId?: string
  mode: JobMode
  state: JobState
  stage: JobStage
  params: JobParams
  progress: JobProgress
  metrics?: { step?: number; loss?: number; lr?: number; gradNorm?: number }
  startedAt: string
  /** When the engine actually began this job; absent on older records, where it equals `startedAt`. */
  runStartedAt?: string
  /** How many jobs were ahead of this one when it was queued (0 = it started at once). */
  queuedBehind?: number
  endedAt?: string
  pid?: number
  exitCode?: number
  error?: { code: string; message: string }
  outputs?: Array<{ path: string; width: number; height: number; seed: number }>
  /** Latest live preview while denoising (a PNG the engine rewrites; `seq` changes on every write). */
  preview?: { path: string; step: number; total: number; seq: number }
  /** 1-based place in the queue of the engine that will run it, while `state` is 'queued'. */
  queuePosition?: number
  url?: string
  logPath?: string
}

export interface JobLogLine {
  jobId: string
  seq: number
  at: string
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface DiagnosticSolution {
  label: string
  action: string
  params?: Record<string, unknown>
}

export interface Diagnostic {
  id: string
  jobId?: string
  ruleId: string
  severity: 'error' | 'warning' | 'info'
  title: string
  explain: string
  solutions: DiagnosticSolution[]
  raw: string
  signature: string
  count: number
  firstAt: string
  lastAt: string
  toast: boolean
}

export interface GalleryItem {
  id: string
  path: string
  name: string
  dir: string
  root: string
  size: number
  mtime: number
  ext: string
  width?: number
  height?: number
  prompt?: string
  seed?: number | null
  /** Studio project the image was generated for, when known (job record or sidecar). */
  projectId?: string
  /** Generation job that produced the image, when known. */
  jobId?: string
}

/** How an image was generated, from its job record or its JSON sidecar. Every field is optional. */
export interface GalleryGeneration {
  jobId?: string
  projectId?: string
  modelName?: string
  modelBundleId?: string
  steps?: number
  cfg?: number
  width?: number
  height?: number
  seed?: number
  adapters?: Array<{ path: string; strength: number }>
  /** ISO time the generation started. */
  createdAt?: string
  /** Where it ran, in plain words: "本机 · RTX 4090" or the SSH host's name. */
  where?: string
  hostId?: string
  /** The overall description as the user wrote it (for a region layout: its caption). */
  description?: string
  /** Number of regions when the image came from a region layout. */
  regions?: number
  /** With 高清修复: the first pass's size (`width`/`height` are the finished picture's). */
  baseWidth?: number
  baseHeight?: number
  /** The pictures and sampling choices the generation used, when it used any. */
  initImage?: JobInitImage
  mask?: JobMask
  control?: JobControl
  references?: JobReferences
  sampling?: JobSampling
}

export interface GalleryPage {
  items: GalleryItem[]
  nextCursor: string | null
  total: number
  scannedAt: string
}

export interface GalleryDetail extends GalleryItem {
  negativePrompt?: string
  parameters?: string
  generation?: GalleryGeneration
}

import type { BackendInfo } from './backend'

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  dataPath: string
  enginePath?: string
  modelsPath: string
  modelDirectories: Record<ModelDirectoryId, string>
  acrylic: boolean
  backend?: BackendInfo
}

export interface IpcError {
  code: string
  message: string
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

export type ProjectLayerKind = 'object' | 'character' | 'text'

export interface ProjectLayer {
  id: string
  kind: ProjectLayerKind
  caption: string
  text?: string
  bbox: [number, number, number, number]
  visible: boolean
  locked: boolean
  opacity: number
}

export interface ProjectDocument {
  schemaVersion: 3
  id: string
  name: string
  canvases: ProjectCanvas[]
  selectedCanvasId?: string
  seriesId?: string
  page?: number
  createdAt: string
  updatedAt: string
}

export interface CanvasAdapter {
  id: string
  strength: number
  path?: string
}

/** An image a Canvas takes in: another Canvas on the board (drawn as a wire). */
export interface CanvasImageLink {
  canvasId: string
  /** Which of the source's outputs; absent = its first. Ignored for `kind: 'image'` sources. */
  output?: number
}

export interface CanvasInputs {
  init?: { link: CanvasImageLink; strength: number; resize?: ImageResizeMode }
  /** PNG painted on this Canvas (white = repaint), stored in the project's assets. */
  mask?: { path: string }
  control?: {
    adapterId: string
    loraStrength?: number
    images: Array<{ kind: string; link: CanvasImageLink; strength: number; start: number; end: number }>
  }
  references?: { links: CanvasImageLink[]; maxEdge?: number }
  /** 风格 nodes (`kind: 'style'`) whose description and LoRA this Canvas generates with. */
  styles?: { links: CanvasImageLink[] }
}

/** A 放大 node: a layout Canvas that redraws its start picture (原图) larger. */
export interface CanvasUpscale {
  /** Times the 原图's size (the long edge stays within the engine's limit). */
  scale: number
}

export interface ProjectCanvas {
  id: string
  /**
   * layout: a description to generate; result: a generation's output; image: a picture brought in from a file;
   * style: a 风格 (a description and LoRA that the layout Canvases wired to it generate with).
   */
  kind: 'layout' | 'result' | 'image' | 'style'
  /** A 放大 node (layout only): redraws its start picture at `scale` times its size. */
  upscale?: CanvasUpscale
  /**
   * A result: the description and LoRA its run was actually generated with,
   * when they differ from its own (its 风格 added, a 放大's inherited
   * description). Running it again uses these.
   */
  generated?: { prompt: string; adapters?: CanvasAdapter[] }
  /** The picture of an `image` Canvas (copied into the project's assets). */
  imagePath?: string
  /** The real pixel size of `imagePath` (`width`/`height` are its card size on the board). */
  imageSize?: { width: number; height: number }
  /** Pictures this Canvas generates from. */
  inputs?: CanvasInputs
  sampling?: JobSampling
  /** A result of a run with 高清修复: the first pass's size (`width`/`height` are the finished picture's). */
  baseSize?: { width: number; height: number }
  title: string
  /** Position on the free-form board, in unscaled board pixels. */
  x: number
  y: number
  width: number
  height: number
  summary: { caption: string; meta: string[]; canvas: 'single' | 'multi_panel' | 'collage' }
  layers: ProjectLayer[]
  prompt: string
  negative: string
  seed: number
  steps: number
  cfg: number
  modelBundleId?: string
  deviceUuid?: string
  deviceId?: string
  backgroundPath?: string
  sourceCanvasId?: string
  /**
   * A result kept on the board as its own card. Unpinned results of a layout
   * canvas stack in that canvas's filmstrip instead (see pages/studio/runs.ts).
   */
  pinned?: boolean
  /** The filmstrip picture a layout canvas shows on its face and gives to wires; absent = the newest. */
  shownOutput?: CanvasImageLink
  jobId?: string
  jobState?: JobState
  progress?: JobProgress
  outputs?: NonNullable<JobRecord['outputs']>
  error?: JobRecord['error']
  /** LoRA adapters applied when this Canvas generates. */
  adapters?: CanvasAdapter[]
  /** Keep `seed` for the next run; otherwise every run draws a new random seed. */
  seedLocked?: boolean
}

export interface ProjectSummary {
  id: string
  name: string
  width: number
  height: number
  layerCount: number
  seriesId?: string
  page?: number
  updatedAt: string
}

export interface GbcVersion {
  id: string
  name: string
  branch: string
  commit: string
  shortCommit: string
  subject: string
  commitDate: string
  path: string
  createdAt: string
}
