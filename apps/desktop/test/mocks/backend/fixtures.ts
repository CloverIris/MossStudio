/**
 * Typed fixture data for the mock backend.
 *
 * Every export is a factory returning a fresh object so tests can mutate their
 * copy freely. Unit tests (test/) and the E2E suite (e2e/) share them.
 */
import releaseCatalog from '../../../resources/models.json'
import type { AiConversationInfo, AiProviderInfo } from '@shared/ai'
import type { UpdateAnnouncement, UpdaterState } from '@shared/update'
import type {
  AdapterEntry,
  ControlAdapterEntry,
  EngineFeatures,
  Catalog,
  Diagnostic,
  DownloadTask,
  EngineReadiness,
  EnvReport,
  GalleryItem,
  GpuInventoryDevice,
  GpuInventorySnapshot,
  GpuTelemetrySnapshot,
  JobLogLine,
  JobParams,
  JobRecord,
  LaunchDevice,
  LaunchRow,
  LocalEngineVersion,
  ManagedHost,
  MossInferRelease,
  ModelBundle,
  ModelEntry,
  MossInferDownloadState,
  ProjectCanvas,
  ProjectDocument,
  Settings,
  TrainerVersion,
} from '@shared/types'

/** Deterministic clock used by every fixture timestamp. */
export const FIXTURE_NOW = '2026-11-01T00:00:00.000Z'

export const GiB = 1024 ** 3

// ---------------------------------------------------------------------------
// Settings

/** Mirrors main/services/settings.ts DEFAULT_SETTINGS (kept in sync by a test). */
export function settingsFixture(patch: Partial<Settings> = {}): Settings {
  return {
    theme: 'system',
    uiAnimation: 'system',
    language: 'zh-CN',
    networkMode: 'auto',
    gitMirror: null,
    pipIndex: null,
    hfEndpoint: null,
    hasHfToken: false,
    modelDownloadConcurrency: 4,
    hfQueryHostId: null,
    modelsRoot: null,
    modelDirectories: { dit: null, textEncoder: null, vae: null, support: null, adapters: null },
    pythonPath: null,
    torchBackend: 'auto',
    torchIndex: null,
    desktopNotifications: true,
    lanWebEnabled: false,
    lanWebPort: null,
    lanWebInstanceId: null,
    updateChannel: 'stable',
    autoDownloadUpdates: true,
    dismissedAnnouncements: [],
    noticedFailedUpdates: [],
    lastRunVersion: null,
    skippedUpdateVersion: null,
    sidebarCollapsed: false,
    onboardingState: 'pending',
    onboardingHostId: 'local',
    galleryRoots: [],
    homeBackground: null,
    trainerRoot: null,
    engineRoot: null,
    gbcRoot: null,
    inferenceBackend: 'mossinfer',
    mossInferServerPath: null,
    mossInferMemoryMode: 'balanced',
    mossInferTier: 'high',
    mossInferRefreshEvery: 5,
    mossInferChannel: 'stable',
    engineDeviceOverrides: {},
    gpuSelection: 'auto',
    gpuProfileMode: 'auto',
    gpuProfileOverrides: {},
    hasGithubToken: false,
    disabledDevices: [],
    deviceLabels: {},
    remoteHostsEnabled: false,
    trainingEnabled: false,
    engineAutoUpdate: true,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// Model catalog (the real resources/models.json, normalised like main/services/models.ts)

type RawModel = (typeof releaseCatalog.models)[number]
type RawAdapter = (typeof releaseCatalog.adapters)[number]

function toModel(raw: RawModel): ModelEntry {
  return {
    id: raw.id,
    name: raw.name,
    choice: 'choice' in raw ? (raw.choice as string) : undefined,
    provider: raw.provider as ModelEntry['provider'],
    repo: raw.repo,
    revision: raw.revision,
    role: raw.role as ModelEntry['role'],
    format: raw.format as ModelEntry['format'],
    family: 'family' in raw ? (raw.family as string) : undefined,
    subfolder: 'subfolder' in raw ? (raw.subfolder as string) : undefined,
    precision: raw.precision,
    sizeBytes: raw.size_bytes,
    files: 'files' in raw ? (raw.files as string[]) : undefined,
    license: raw.license,
    tags: raw.tags,
    notes: 'notes' in raw ? (raw.notes as string) : undefined,
    installState: 'missing',
    installed: false,
    installedBytes: 0,
  }
}

function toAdapter(raw: RawAdapter): AdapterEntry {
  return {
    id: raw.id,
    name: raw.name,
    provider: raw.provider as AdapterEntry['provider'],
    repo: raw.repo,
    revision: raw.revision,
    kind: raw.kind as AdapterEntry['kind'],
    base: 'base' in raw ? (raw.base as string) : undefined,
    license: raw.license,
    files: raw.files,
    sizeBytes: raw.size_bytes,
    requiresProfile: 'requires_profile' in raw ? (raw.requires_profile as string) : undefined,
    tags: raw.tags,
    notes: 'notes' in raw ? (raw.notes as string) : undefined,
    installed: false,
    installedBytes: 0,
  }
}

/** Component ids of the recommended SFT bundle. */
export const SFT_BUNDLE_IDS = ['moss-sft-dit', 'qwen35-encoder', 'flux2-vae-small', 'moss-pipeline'] as const

export interface CatalogOptions {
  /** Model or adapter ids that report as fully installed. */
  installed?: readonly string[]
  /** Model ids that report a partial (interrupted) download. */
  partial?: readonly string[]
  source?: Catalog['source']
}

export function catalogFixture(options: CatalogOptions = {}): Catalog {
  const installed = new Set(options.installed ?? [])
  const partial = new Set(options.partial ?? [])
  return {
    bundles: releaseCatalog.bundles.map((bundle) => ({ ...bundle, components: { ...bundle.components } })) as ModelBundle[],
    updatedAt: releaseCatalog.updated_at,
    source: options.source ?? 'builtin',
    models: releaseCatalog.models.map((raw) => {
      const model = toModel(raw)
      if (installed.has(model.id)) return { ...model, installed: true, installState: 'ready', installedBytes: model.sizeBytes }
      if (partial.has(model.id)) return { ...model, installState: 'partial', installedBytes: Math.floor(model.sizeBytes / 3) }
      return model
    }),
    adapters: releaseCatalog.adapters.map((raw) => {
      const adapter = toAdapter(raw)
      return installed.has(adapter.id) ? { ...adapter, installed: true, installedBytes: adapter.sizeBytes } : adapter
    }),
  }
}

// ---------------------------------------------------------------------------
// GPU

export function gpuDeviceFixture(patch: Partial<GpuInventoryDevice> = {}): GpuInventoryDevice {
  return {
    uuid: 'GPU-11111111-2222-3333-4444-555555555555',
    index: 0,
    name: 'NVIDIA GeForce RTX 4090',
    computeCapability: { major: 8, minor: 9 },
    memoryTotalBytes: 24 * GiB,
    memoryFreeBytes: 22 * GiB,
    utilizationPercent: 3,
    driverVersion: '581.42',
    ...patch,
  }
}

export const GPU_RTX_3060 = (): GpuInventoryDevice =>
  gpuDeviceFixture({
    uuid: 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    index: 1,
    name: 'NVIDIA GeForce RTX 3060',
    computeCapability: { major: 8, minor: 6 },
    memoryTotalBytes: 12 * GiB,
    memoryFreeBytes: 11 * GiB,
  })

export const GPU_GTX_1660 = (): GpuInventoryDevice =>
  gpuDeviceFixture({
    uuid: 'GPU-99999999-8888-7777-6666-555555555555',
    index: 2,
    name: 'NVIDIA GeForce GTX 1660',
    computeCapability: { major: 7, minor: 5 },
    memoryTotalBytes: 6 * GiB,
    memoryFreeBytes: 5 * GiB,
  })

export function gpuInventoryFixture(devices: GpuInventoryDevice[] = [gpuDeviceFixture()]): GpuInventorySnapshot {
  if (devices.length === 0) {
    return { scannedAt: FIXTURE_NOW, status: 'unavailable', devices: [], error: 'nvidia-smi not found' }
  }
  return { scannedAt: FIXTURE_NOW, status: 'ok', devices, recommendedGpuUuid: devices[0]!.uuid }
}

export function gpuTelemetryFixture(devices: GpuInventoryDevice[] = [gpuDeviceFixture()]): GpuTelemetrySnapshot {
  return {
    sampledAt: FIXTURE_NOW,
    status: devices.length ? 'ok' : 'unavailable',
    devices: devices.map((device) => ({
      ...device,
      memoryUsedBytes: (device.memoryTotalBytes ?? 0) - (device.memoryFreeBytes ?? 0),
      runningTasks: 0,
      queuedTasks: 0,
    })),
    recommendedGpuUuid: devices[0]?.uuid,
  }
}

export function launchDeviceFixture(patch: Partial<LaunchDevice> = {}): LaunchDevice {
  return {
    id: 'cuda:0',
    name: 'NVIDIA GeForce RTX 4090',
    kind: 'cuda',
    detail: 'CUDA 13.0 · 24 GB',
    memoryBytes: 24 * GiB,
    available: true,
    hostId: 'local',
    source: 'local',
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// Engine

export const ENGINE_PATH = '/fixture/mossinfer/v2.1.1/bin/moss-server'

export function engineVersionFixture(patch: Partial<LocalEngineVersion> = {}): LocalEngineVersion {
  return { id: 'v2.1.1', name: 'v2.1.1', path: ENGINE_PATH, current: true, source: 'managed', ...patch }
}

export function engineReadyFixture(patch: Partial<EngineReadiness> = {}): EngineReadiness {
  return { state: 'ready', path: ENGINE_PATH, ...patch }
}

export function engineMissingFixture(patch: Partial<EngineReadiness> = {}): EngineReadiness {
  return { state: 'missing', path: null, reason: '未找到 moss-server；请下载引擎或设置路径', ...patch }
}

export function engineDownloadFixture(patch: Partial<MossInferDownloadState> = {}): MossInferDownloadState {
  return {
    channel: 'stable',
    phase: 'downloading',
    bytes: 0,
    totalBytes: 900_000_000,
    percent: 0,
    speedBps: 0,
    version: 'v2.1.1',
    releaseTag: 'v2.1.1',
    updatedAt: FIXTURE_NOW,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// Downloads

export function downloadFixture(patch: Partial<DownloadTask> = {}): DownloadTask {
  const targetId = patch.targetId ?? 'moss-sft-dit'
  return {
    id: `model:${targetId}`,
    kind: 'model',
    targetId,
    label: 'MOSS-Image SFT',
    state: 'queued',
    filesTotal: 4,
    filesDone: 0,
    bytes: 0,
    totalBytes: 10_164_704_750,
    speedBps: 0,
    updatedAt: FIXTURE_NOW,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// Jobs

export function jobFixture(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    instanceId: 'mossinfer',
    instanceName: 'MossInfer',
    engine: 'mossinfer',
    deviceUuid: gpuDeviceFixture().uuid,
    mode: 'runner',
    state: 'queued',
    stage: 'idle',
    params: { prompt: 'a cat', negativePrompt: '', width: 1024, height: 1024, steps: 28, cfg: 4.5, seed: 42, profile: 'base' },
    progress: { stage: 'idle', current: 0, total: 28, percent: 0 },
    startedAt: FIXTURE_NOW,
    ...patch,
  }
}

export interface JobLifecycleOptions {
  fail?: { code: string; message: string }
  /** Live preview frames while denoising (each a `JobRecord.preview` with a new `seq`). */
  previews?: number
  /** Start queued behind this many jobs: one `queued` update per place (N, N-1 … 1). */
  queuedAhead?: number
}

/** Where the mock engine "writes" a job's live preview (clover:// serves any path in E2E). */
export function previewPathFixture(jobId: string): string {
  return `/fixture/cache/previews/${jobId}.png`
}

/**
 * The event sequence a successful (or failing) job emits on Events.job:
 * optionally queued (with `queuePosition` counting down), then loading,
 * denoising (with `previews` live frames), decoding and the result.
 */
export function jobLifecycle(base: JobRecord, options: JobLifecycleOptions = {}): JobRecord[] {
  const total = base.params.steps
  const { preview: _preview, queuePosition: _queuePosition, ...clean } = base
  const at = (stage: JobRecord['stage'], current: number, state: JobRecord['state']): JobRecord => ({
    ...clean,
    state,
    stage,
    progress: { stage, current, total, percent: Math.round((current / total) * 100) },
  })
  const queued = Array.from({ length: Math.max(0, options.queuedAhead ?? 0) }, (_, index) => ({
    ...at('idle', 0, 'queued'),
    queuePosition: (options.queuedAhead ?? 0) - index,
  }))
  const frames = Math.max(0, options.previews ?? 0)
  const denoise = frames
    ? Array.from({ length: frames }, (_, index) => {
        const step = Math.max(1, Math.round(((index + 1) / frames) * total))
        return { ...at('denoise', step, 'running'), preview: { path: previewPathFixture(base.id), step, total, seq: index + 1 } }
      })
    : [at('denoise', Math.floor(total / 2), 'running'), at('denoise', total, 'running')]
  const running = [...queued, at('load', 0, 'starting'), at('text', 0, 'running'), ...denoise]
  if (options.fail) {
    return [...running, { ...at('denoise', total, 'failed'), error: options.fail, endedAt: FIXTURE_NOW, exitCode: 1 }]
  }
  return [
    ...running,
    at('decode', total, 'running'),
    {
      ...at('ready', total, 'succeeded'),
      endedAt: FIXTURE_NOW,
      exitCode: 0,
      outputs: [{ path: `/fixture/outputs/${base.id}.png`, width: base.params.width, height: base.params.height, seed: base.params.seed }],
    },
  ]
}

/** The pseudo IPC channel the Studio's HTTP job submission (POST /api/engine-jobs) is answered on. */
export const ENGINE_JOBS_CHANNEL = 'http:POST /api/engine-jobs'

/**
 * The job the backend answers a Studio submission with: queued, with every
 * generation field of the request in `params` (image inputs included), so a
 * test can assert what reached the engine side.
 */
export function submittedJobFixture(body: Record<string, unknown>, id: string): JobRecord {
  const base = jobFixture({
    id,
    state: 'queued',
    stage: 'idle',
    canvasId: typeof body['canvasId'] === 'string' ? body['canvasId'] : undefined,
    canvasTitle: typeof body['canvasTitle'] === 'string' ? body['canvasTitle'] : undefined,
    projectId: typeof body['projectId'] === 'string' ? body['projectId'] : undefined,
    hostId: typeof body['hostId'] === 'string' ? body['hostId'] : undefined,
    params: {
      prompt: String(body['prompt'] ?? ''),
      negativePrompt: String(body['negativePrompt'] ?? ''),
      width: Number(body['width'] ?? 1024),
      height: Number(body['height'] ?? 1024),
      steps: Number(body['steps'] ?? 28),
      cfg: Number(body['cfg'] ?? 4.5),
      seed: Number(body['seed'] ?? 0),
      profile: body['profile'] === 'dmd8' ? 'dmd8' : 'base',
      ...(Array.isArray(body['adapters']) ? { adapters: structuredClone(body['adapters']) as JobParams['adapters'] } : {}),
      ...Object.fromEntries(
        (['initImage', 'mask', 'control', 'references', 'sampling'] as const)
          .filter((key) => body[key] !== undefined && body[key] !== null)
          .map((key) => [key, structuredClone(body[key])]),
      ),
    },
  })
  return { ...base, progress: { stage: 'idle', current: 0, total: base.params.steps, percent: 0 } }
}

export function jobLogFixture(jobId: string, count: number, startSeq = 0): JobLogLine[] {
  return Array.from({ length: count }, (_, index) => ({
    jobId,
    seq: startSeq + index,
    at: FIXTURE_NOW,
    stream: 'stdout' as const,
    text: `line ${startSeq + index}`,
  }))
}

export function launchRowFixture(patch: Partial<LaunchRow> = {}): LaunchRow {
  return {
    id: 'row-1',
    caseName: 'Default',
    instanceId: 'mossinfer',
    instanceName: 'MossInfer',
    workspace: 'clover',
    deviceId: 'cuda:0',
    profile: 'base',
    state: 'queued',
    queuedAt: FIXTURE_NOW,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// Diagnostics

export function diagnosticFixture(patch: Partial<Diagnostic> = {}): Diagnostic {
  return {
    id: 'diag-1',
    ruleId: 'cuda-oom',
    severity: 'error',
    title: '显存不足',
    explain: 'CUDA out of memory',
    solutions: [{ label: '更换模型目录', action: 'open_settings', params: { tab: 'storage' } }],
    raw: 'CUDA error: out of memory',
    signature: 'cuda-oom',
    count: 1,
    firstAt: FIXTURE_NOW,
    lastAt: FIXTURE_NOW,
    toast: true,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// Updates

// The update runtime's state (src/shared/update.ts) as main/update pushes it.

export function announcementFixture(patch: Partial<UpdateAnnouncement> = {}): UpdateAnnouncement {
  return { id: 'notice-1', level: 'info', title: '公告', body: '**MossStudio** 发布了新的 `模型`。', ...patch }
}

/** Installed build on the newest version: nothing to do. */
export function updaterStateFixture(patch: Partial<UpdaterState> = {}): UpdaterState {
  return {
    supported: true,
    unsupportedReason: null,
    current: '1.0.3',
    channel: 'stable',
    autoDownload: true,
    phase: 'idle',
    checkedAt: FIXTURE_NOW,
    available: null,
    progress: null,
    pending: null,
    readyAt: null,
    updatedFrom: null,
    previous: null,
    canRollback: false,
    minimumVersion: null,
    required: false,
    busy: [],
    restartWhenIdle: false,
    error: null,
    announcements: [],
    skippedVersion: null,
    failedVersion: null,
    failedNotice: false,
    ...patch,
  }
}

/** A newer version offered by the feed and not downloaded yet (自动下载更新 off). */
export function updateAvailableFixture(version = '1.1.0', patch: Partial<UpdaterState> = {}): UpdaterState {
  return updaterStateFixture({
    phase: 'available',
    autoDownload: false,
    available: {
      version,
      publishedAt: '2026-10-30T08:00:00.000Z',
      kind: 'delta',
      downloadSize: 48_000_000,
      notes: `## MossStudio ${version}\n\n- 生成更快，显存占用更少\n- 作品页可以按日期筛选\n- 修复了若干问题`,
      notesUrl: `https://github.com/CloverIris/MossStudio/releases/tag/v${version}`,
    },
    ...patch,
  })
}

/** Downloading `version` at `percent`. */
export function updateDownloadingFixture(version = '1.1.0', percent = 40, patch: Partial<UpdaterState> = {}): UpdaterState {
  const available = updateAvailableFixture(version).available!
  const totalBytes = available.downloadSize
  return updaterStateFixture({
    phase: 'downloading',
    available,
    progress: { bytes: Math.round((totalBytes * percent) / 100), totalBytes, speedBps: 6_000_000, percent },
    ...patch,
  })
}

/** Downloaded and materialized: restart to switch to `version`. */
export function updateReadyFixture(version = '1.1.0', patch: Partial<UpdaterState> = {}): UpdaterState {
  return updaterStateFixture({ phase: 'ready', available: updateAvailableFixture(version).available, pending: version, ...patch })
}

/** The first start after `version` failed its start and was rolled back to 1.0.3. */
export function updateFailedFixture(version = '1.1.0', patch: Partial<UpdaterState> = {}): UpdaterState {
  return updaterStateFixture({ failedVersion: version, failedNotice: true, ...patch })
}

// ---------------------------------------------------------------------------
// Hosts

export function sshHostFixture(patch: Partial<ManagedHost> = {}): ManagedHost {
  return {
    id: 'ssh-gpu',
    name: 'Linux GPU',
    kind: 'ssh',
    host: 'gpu.example.test',
    user: 'moss',
    port: 22,
    authMethod: 'identityFile',
    identityFile: '/home/moss/.ssh/id_ed25519',
    trainerRoot: '~/.mossstudio/trainer',
    engineRoot: '~/.mossstudio/engine',
    status: 'ok',
    lastCheckedAt: FIXTURE_NOW,
    devices: [],
    ...patch,
  }
}

export function localHostFixture(patch: Partial<ManagedHost> = {}): ManagedHost {
  return { id: 'local', name: '本机', kind: 'local', trainerRoot: '/fixture/trainer', status: 'ok', devices: [], ...patch }
}

// ---------------------------------------------------------------------------
// Gallery, projects

export function galleryItemFixture(index = 0, patch: Partial<GalleryItem> = {}): GalleryItem {
  const name = `moss_${String(index).padStart(4, '0')}.png`
  return {
    id: `gallery-${index}`,
    path: `/fixture/outputs/${name}`,
    name,
    dir: '/fixture/outputs',
    root: '/fixture/outputs',
    size: 1_500_000 + index,
    mtime: Date.parse(FIXTURE_NOW) - index * 60_000,
    ext: '.png',
    width: 1024,
    height: 1024,
    prompt: `prompt ${index}`,
    seed: index,
    ...patch,
  }
}

export function canvasFixture(patch: Partial<ProjectCanvas> = {}): ProjectCanvas {
  return {
    id: 'canvas-1',
    kind: 'layout',
    title: 'Canvas 1',
    x: 0,
    y: 0,
    width: 1024,
    height: 1024,
    summary: { caption: 'A poster', meta: [], canvas: 'single' },
    layers: [],
    prompt: '',
    negative: '',
    seed: 42,
    steps: 28,
    cfg: 4.5,
    ...patch,
  }
}

export function projectFixture(patch: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    schemaVersion: 3,
    id: 'project-1',
    name: 'Project 1',
    canvases: [canvasFixture()],
    selectedCanvasId: 'canvas-1',
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// AI

export function aiProviderFixture(patch: Partial<AiProviderInfo> = {}): AiProviderInfo {
  return {
    id: 'fixture-ai',
    name: 'Fixture AI',
    kind: 'openai',
    baseUrl: 'https://example.test',
    model: 'fixture',
    temperature: 0.7,
    hasKey: true,
    ...patch,
  }
}

export function conversationFixture(patch: Partial<AiConversationInfo> = {}): AiConversationInfo {
  return { id: 'fixture-history', title: '历史对话', providerId: 'fixture-ai', messages: [], createdAt: '', updatedAt: '', ...patch }
}

// ---------------------------------------------------------------------------
// Environment

export function envReportFixture(patch: Partial<EnvReport> = {}): EnvReport {
  return {
    scannedAt: FIXTURE_NOW,
    appVersion: '1.0.3',
    device: {
      platform: 'win32',
      arch: 'x64',
      osVersion: '10.0.26100',
      hostname: 'fixture',
      cpuModel: 'Fixture CPU',
      cpuCores: 16,
      memoryTotal: 64 * GiB,
      memoryFree: 40 * GiB,
      diskTotal: 2000 * GiB,
      diskFree: 900 * GiB,
      dataPath: '/fixture/data',
      modelsPath: '/fixture/data/models',
    },
    gpu: { kind: 'nvidia', name: 'NVIDIA GeForce RTX 4090', memoryBytes: 24 * GiB, cuda: '13.0', driver: '581.42', available: true },
    pythons: [],
    tools: { git: { found: true, version: '2.51.0', path: '/usr/bin/git' }, uv: { found: false } },
    network: {
      checkedAt: FIXTURE_NOW,
      mode: 'auto',
      probes: [],
      selected: { git: null, pip: null, hf: 'https://huggingface.co', manifest: null },
    },
    checks: [],
    recommendation: { width: 1024, height: 1024, steps: 28, profile: 'base', quant: 'bf16', note: '', estimatedLabel: '~20s' },
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// Adapters, engine releases, trainer

/** A LoRA the user imported from disk (provider `local`, already installed). */
export function localAdapterFixture(patch: Partial<AdapterEntry> = {}): AdapterEntry {
  return {
    id: 'local-lora-ink',
    name: 'Ink Style LoRA',
    provider: 'local',
    repo: '/fixture/loras/ink-style.safetensors',
    revision: 'local',
    kind: 'lora',
    license: 'unknown',
    files: ['ink-style.safetensors'],
    sizeBytes: 151_000_000,
    tags: ['imported'],
    installed: true,
    installedBytes: 151_000_000,
    ...patch,
  }
}

export function engineReleaseFixture(patch: Partial<MossInferRelease> = {}): MossInferRelease {
  return {
    tag: 'v2.1.1',
    name: 'MossInfer v2.1.1',
    publishedAt: FIXTURE_NOW,
    body: '',
    assets: [{ name: 'mossinfer-win-x64-cu13.zip', size: 900_000_000 }],
    ...patch,
  }
}

export function trainerVersionFixture(patch: Partial<TrainerVersion> = {}): TrainerVersion {
  return {
    id: 'trainer-main',
    hostId: 'local',
    hostName: '本机',
    name: 'main',
    branch: 'main',
    commit: 'a1b2c3d4e5f6',
    shortCommit: 'a1b2c3d',
    commitDate: FIXTURE_NOW,
    subject: 'Fixture trainer',
    author: 'fixture',
    channel: 'stable',
    path: '/fixture/trainer/main',
    runtimeId: 'runtime-main',
    runtimeState: 'ready',
    createdAt: FIXTURE_NOW,
    lastUsedAt: null,
    dirty: false,
    status: 'ok',
    ...patch,
  }
}

/** What moss-server 2.2.0 reports in its hello: every generation feature on. */
export function engineFeaturesFixture(patch: Partial<EngineFeatures> = {}): EngineFeatures {
  return {
    preview: true,
    imageInput: true,
    control: true,
    references: true,
    hires: true,
    samplers: true,
    lora: true,
    values: {
      sampler: ['euler', 'ab2', 'euler_ancestral', 'heun', 'dpmpp_2m', 'dpmpp_2m_sde', 'er_sde', 'res_multistep'],
      scheduler: ['moss', 'simple', 'normal', 'karras', 'exponential', 'beta', 'sgm_uniform'],
      resize: ['crop', 'fit', 'stretch'],
      mask_encoding: ['u8', 'binary01'],
      step_cache: ['off', 'fbcache'],
    },
    ...patch,
  }
}

export function controlAdapterFixture(patch: Partial<ControlAdapterEntry> = {}): ControlAdapterEntry {
  return {
    id: 'control-union',
    name: 'moss-control-union.safetensors',
    path: '/fixture/models/control/moss-control-union.safetensors',
    sizeBytes: 1_200_000_000,
    controlKinds: ['depth', 'canny', 'pose'],
    baseModel: 'moss-image',
    addedAt: FIXTURE_NOW,
    ...patch,
  }
}

/** Machines for the engine chooser (./machines.ts), here so E2E specs reach them through `__mock.fixtures`. */
export { machineFixture, inventoryDevicesFor } from './machines'
