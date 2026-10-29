import type { ReleaseHomeCopy, ReleaseInstaller } from './release'

export type CheckStatus = 'ok' | 'warn' | 'error' | 'unknown'

export type CheckActionKind =
  | 'rescan'
  | 'open-settings'
  | 'open-url'
  | 'install-python'
  | 'switch-mirror'

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

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  uiAnimation: 'system' | 'on' | 'off'
  language: 'zh-CN' | 'en'
  networkMode: 'auto' | 'direct' | 'mirror'
  gitMirror: string | null
  pipIndex: string | null
  hfEndpoint: string | null
  modelsRoot: string | null
  pythonPath: string | null
  torchBackend: 'auto' | 'cpu' | 'cuda'
  torchIndex: string | null
  autoCheckUpdates: boolean
  desktopNotifications: boolean
  lanWebEnabled: boolean
  lanWebPort: number | null
  lanWebInstanceId: string | null
  updateChannel: 'stable' | 'beta'
  dismissedAnnouncements: string[]
  dismissedUpdateVersion: string | null
  sidebarCollapsed: boolean
  onboardingState: 'pending' | 'active' | 'dismissed' | 'completed'
  onboardingHostId: string
  galleryRoots: string[]
  homeBackground: string | null
  trainerRoot: string | null
  gbcRoot: string | null
  inferenceBackend: 'runner' | 'mossinfer'
  mossInferServerPath: string | null
  mossInferMemoryMode: 'min_memory' | 'balanced' | 'max_speed'
  mossInferTier: 'reference' | 'high' | 'turbo'
  mossInferChannel: 'stable' | 'dev'
  mossInferVariant: 'system-cuda' | 'bundled'
  githubToken: string | null
  disabledDevices: string[]
  deviceLabels: Record<string, string>
}

export interface EngineRemoteProgress {
  hostId: string
  phase: 'checking' | 'querying' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error'
  message: string
  percent?: number
}

export interface MossInferDownloadState {
  channel: 'stable' | 'dev'
  phase: 'querying' | 'downloading' | 'verifying' | 'extracting' | 'cuda_libs' | 'done' | 'error'
  bytes: number
  totalBytes: number
  percent: number
  speedBps: number
  version?: string
  serverPath?: string
  recommendedFlavour?: string
  variant?: 'system-cuda' | 'bundled'
  note?: string
  cublaslt?: unknown
  error?: string
  updatedAt: string
}

export interface AppNotification {
  id: string
  tone: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  createdAt: string
  read: boolean
}

export interface Announcement {
  id: string
  level: 'info' | 'success' | 'warning' | 'critical'
  title: string
  body: string
  bodyUrl?: string
  startsAt?: string
  endsAt?: string | null
  dismissible: boolean
  pinned: boolean
  action?: { label: string; kind: 'open_url' | 'check_update' | 'open_settings'; url?: string }
}

export interface UpdateState {
  checkedAt: string
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  channel: 'stable' | 'beta'
  manifestSource: 'local' | 'remote' | 'cache' | 'none'
  home?: ReleaseHomeCopy
  announcements: Announcement[]
  releaseNotes?: string
  publishedAt?: string
  releaseUrl?: string
  installer?: ReleaseInstaller | null
  mandatory?: boolean
  error?: string
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

export type InstancePlacement =
  | { kind: 'local' }
  | { kind: 'ssh'; hostId: string; hostName?: string; root: string }

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

export interface JobRecord {
  modelSnapshot?: unknown
  engine?: 'runner' | 'mossinfer'
  id: string
  instanceId: string
  instanceName: string
  caseId?: string
  caseName?: string
  workspace?: WorkspaceKind
  deviceId?: string
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
  endedAt?: string
  pid?: number
  exitCode?: number
  error?: { code: string; message: string }
  outputs?: Array<{ path: string; width: number; height: number; seed: number }>
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
  modelsPath: string
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
  schemaVersion: 1
  id: string
  name: string
  width: number
  height: number
  summary: { caption: string; meta: string[]; canvas: 'single' | 'multi_panel' | 'collage' }
  layers: ProjectLayer[]
  prompt: string
  negative: string
  seed: number
  steps: number
  cfg: number
  instanceId?: string
  modelBundleId?: string
  deviceId?: string
  backgroundPath?: string
  seriesId?: string
  page?: number
  createdAt: string
  updatedAt: string
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
