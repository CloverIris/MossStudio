import { z } from 'zod'
import { releaseInstallerSchema } from './release'

const pathLike = z.string().min(1).max(4096)
const urlLike = z.string().min(8).max(2048).regex(/^https?:\/\//)



const hostSaveSchema = z.object({
  id: z.string().max(80).optional(),
  name: z.string().max(120).default(''),
  host: z.string().min(1).max(255),
  user: z.string().min(1).max(120),
  port: z.number().int().min(1).max(65535).optional(),
  authMethod: z.enum(['identityFile', 'password', 'none']).optional(),
  identityFile: z.string().max(4096).optional(),
  password: z.string().max(1024).regex(/^[^\r\n\0]*$/, '密码不能包含换行或 NUL').optional(),
  trainerRoot: z.string().min(1).max(4096),
  instanceRoot: z.string().max(4096).optional(),
  modelsRoot: z.string().max(4096).optional(),
})

export const schemas = {
  settingsUpdate: z
    .object({
      theme: z.enum(['system', 'light', 'dark']),
      uiAnimation: z.enum(['system', 'on', 'off']),
      language: z.enum(['zh-CN', 'en']),
      networkMode: z.enum(['auto', 'direct', 'mirror']),
      gitMirror: z.string().max(2048).nullable(),
      pipIndex: z.string().max(2048).nullable(),
      hfEndpoint: z.string().max(2048).nullable(),
      modelsRoot: z.string().max(4096).nullable(),
      pythonPath: z.string().max(4096).nullable(),
      torchBackend: z.enum(['auto', 'cpu', 'cuda']),
      torchIndex: z.string().max(2048).nullable(),
      autoCheckUpdates: z.boolean(),
      desktopNotifications: z.boolean(),
      lanWebEnabled: z.boolean(),
      lanWebPort: z.number().int().min(1024).max(65535).nullable(),
      lanWebInstanceId: z.string().max(120).nullable(),
      updateChannel: z.enum(['stable', 'beta']),
      dismissedUpdateVersion: z.string().max(80).nullable(),
      sidebarCollapsed: z.boolean(),
      onboardingState: z.enum(['pending', 'active', 'dismissed', 'completed']),
      onboardingHostId: z.string().min(1).max(80),
      galleryRoots: z.array(z.string().max(4096)).max(20),
      homeBackground: z.string().max(4096).nullable(),
      trainerRoot: z.string().max(4096).nullable(),
      inferenceBackend: z.enum(['runner', 'mossinfer']),
      mossInferServerPath: z.string().max(4096).nullable(),
      mossInferMemoryMode: z.enum(['min_memory', 'balanced', 'max_speed']),
      mossInferTier: z.enum(['reference', 'high', 'turbo']),
      mossInferChannel: z.enum(['stable', 'dev']),
      mossInferVariant: z.enum(['system-cuda', 'bundled']),
      githubToken: z.string().max(200).nullable(),
    })
    .partial(),

  mossInferDownload: z.object({
    channel: z.enum(['stable', 'dev']),
    flavour: z.enum(['cu12', 'cu13']).optional(),
    variant: z.enum(['system-cuda', 'bundled']).optional(),
    cudaWheels: z.boolean().optional(),
  }),

  onboardingStatus: z.object({ hostId: z.string().min(1).max(80).optional() }).optional(),

  gitBranches: z
    .object({
      source: urlLike.optional(),
    })
    .optional(),

  gitCommits: z.object({
    branch: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(200).default(60),
    source: urlLike.optional(),
  }),

  instanceCreate: z.object({
    branch: z.string().min(1).max(120),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    name: z.string().min(1).max(60).optional(),
    runtimeMode: z.enum(['shared', 'isolated']).default('shared'),
    source: urlLike.optional(),
    hostId: z.string().max(80).optional(),
  }),

  instanceRemoteHost: z.object({
    hostId: z.string().min(1).max(80),
    source: urlLike.optional(),
  }),

  instanceRemoteCommits: z.object({
    hostId: z.string().min(1).max(80),
    branch: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(200).default(80),
    source: urlLike.optional(),
  }),

  instanceDelete: z.object({
    id: z.string().min(1).max(120),
    keepOutputs: z.boolean().default(true),
  }),

  modelBundle: z.object({ id: z.string().min(1).max(160) }),
  instanceModelBinding: z.object({
    id: z.string().min(1).max(120),
    binding: z.object({ bundleId: z.string().min(1).max(160), dit: z.string().min(1).max(160), textEncoder: z.string().min(1).max(160), vae: z.string().min(1).max(160) }).nullable(),
  }),
  instanceAdapters: z.object({
    id: z.string().min(1).max(120),
    bindings: z.array(z.object({
      id: z.string().min(1).max(160),
      enabled: z.boolean(),
      strength: z.number().min(0).max(4),
    })).max(200),
  }),

  instanceUpdate: z.object({
    id: z.string().min(1).max(120),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  }),

  instanceId: z.object({ id: z.string().min(1).max(120) }),

  instanceOpen: z.object({ id: z.string().min(1).max(120) }),

  runtimeInstall: z.object({ instanceId: z.string().min(1).max(120) }),

  download: z.object({
    kind: z.enum(['model', 'adapter']),
    id: z.string().min(1).max(160),
  }),

  modelPause: z.object({ taskId: z.string().min(1).max(160) }),

  downloadDelete: z.object({
    kind: z.enum(['model', 'adapter']),
    id: z.string().min(1).max(160),
  }),

  announcementsDismiss: z.object({ id: z.string().min(1).max(120) }),

  windowOpen: z.object({
    kind: z.enum(['studio', 'trainer']),
    route: z.string().regex(/^\/[a-z0-9/_-]*(?:\?instanceId=[a-z0-9._%~-]+)?$/i).max(120).optional(),
  }),

  copyText: z.object({ text: z.string().max(4096) }),

  updatesDownload: z.object({
    version: z.string().min(1).max(80),
    installer: releaseInstallerSchema,
  }),

  updatesCancel: z.object({ version: z.string().min(1).max(80) }),

  trainerCommits: z.object({
    branch: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(200).default(80),
  }),

  trainerHostSave: hostSaveSchema,

  trainerHostRemove: z.object({ id: z.string().min(1).max(80) }),

  trainerHostTest: z.object({ id: z.string().min(1).max(80) }),

  hostsList: z.object({}).optional(),

  hostSave: hostSaveSchema,

  remoteResourceInspect: z.object({ hostId: z.string().min(1).max(120), kind: z.enum(['engine', 'models', 'outputs']), path: z.string().min(1).max(4096) }),
  remoteResourceRemove: z.object({ hostId: z.string().min(1).max(120), path: z.string().min(1).max(4096) }),

  modelsRemoteInventory: z.object({ hostId: z.string().min(1).max(120), modelsRoot: z.string().max(4096).optional() }),

  modelsRemoteDownload: z.object({ hostId: z.string().min(1).max(120), modelId: z.string().min(1).max(200) }),

  hostUpdatePaths: z.object({
    id: z.string().min(1).max(120),
    engineRoot: z.string().max(4096).optional(),
    outputRoot: z.string().max(4096).optional(),
    modelsRoot: z.string().max(4096).optional(),
    modelPath: z.string().max(4096).optional(),
  }),

  hostId: z.object({ id: z.string().min(1).max(80) }),

  trainerRemoteHost: z.object({ hostId: z.string().min(1).max(80) }),

  trainerRemoteCommits: z.object({
    hostId: z.string().min(1).max(80),
    branch: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(200).default(80),
  }),

  trainerRemoteCreate: z.object({
    hostId: z.string().min(1).max(80),
    branch: z.string().min(1).max(120),
    commit: z.string().min(7).max(64),
    name: z.string().max(120).optional(),
  }),

  trainerRemoteVersion: z.object({
    hostId: z.string().min(1).max(80),
    versionId: z.string().min(1).max(160),
  }),

  trainerRun: z.object({
    versionId: z.string().min(1).max(120),
    action: z.enum(['train', 'inspect_data', 'cache_text', 'cache_latents', 'export', 'sample']),
    runName: z.string().min(1).max(120),
    weights: z.string().min(1).max(4096),
    dataset: z.string().min(1).max(4096),
    algo: z.string().min(1).max(80),
    steps: z.number().int().min(1).max(1_000_000),
    lr: z.string().max(40),
    dim: z.string().max(20),
    alpha: z.string().max(20),
    batch: z.string().max(20),
    resolution: z.number().int().min(64).max(4096),
    overrides: z.string().max(8000),
  }),

  trainerCreate: z.object({
    branch: z.string().min(1).max(120),
    commit: z.string().min(7).max(64),
    name: z.string().max(120).optional(),
  }),

  trainerId: z.object({ id: z.string().min(1).max(120) }),

  launchRow: z.object({
    id: z.string().min(1).max(120),
    caseId: z.string().max(120).optional(),
    caseName: z.string().max(240),
    instanceId: z.string().min(1).max(160),
    instanceName: z.string().max(240),
    workspace: z.literal('clover'),
    deviceId: z.string().max(160),
    profile: z.enum(['base', 'dmd8']),
    jobId: z.string().max(160).optional(),
    state: z.enum(['queued', 'starting', 'running', 'stopped', 'failed']),
    queuedAt: z.string(),
    startedAt: z.string().optional(),
    error: z.string().max(2000).optional(),
  }),

  launchRowId: z.object({ id: z.string().min(1).max(120) }),

  aiProviderSave: z.object({
    id: z.string().max(120).optional(),
    name: z.string().min(1).max(80),
    kind: z.enum(['openai', 'anthropic', 'gemini', 'ollama']),
    baseUrl: z.string().url().max(2048),
    model: z.string().min(1).max(200),
    apiKey: z.string().max(4096).optional(),
    temperature: z.number().min(0).max(2).optional(),
  }),

  engineRemoteStatus: z.object({ hostId: z.string().min(1).max(80) }),

  enginePrepareRemoteModel: z.object({ hostId: z.string().min(1).max(80), repo: z.string().min(1).max(200).optional() }),

  engineInstallRemote: z.object({ hostId: z.string().min(1).max(80) }),

  engineSystemCuda: z.null(),

  mossInferCudaLibs: z.null(),

  gbcCommits: z.object({ branch: z.string().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }),
  gbcVersionCreate: z.object({ branch: z.string().min(1).max(200), commit: z.string().min(7).max(64), name: z.string().max(120).optional() }),
  gbcVersionRemove: z.object({ id: z.string().min(1).max(160) }),

  gbcStatusQuery: z.object({ versionId: z.string().max(160).optional() }),
  gbcListImages: z.object({ folder: z.string().min(1).max(4096) }),
  gbcThumbnails: z.object({ paths: z.array(z.string().max(4096)).max(120), width: z.number().int().min(32).max(1600).default(160) }),
  gbcInstallEnv: z.object({ versionId: z.string().min(1).max(160) }),

  gbcRun: z.object({
    folder: z.string().max(4096).optional(),
    files: z.array(z.string().max(4096)).max(2000).optional(),
    providerId: z.string().min(1).max(120),
    detector: z.enum(['owlv2', 'sam3']).default('owlv2'),
    versionId: z.string().max(160).optional(),
    sidecarJson: z.boolean().optional(),
    sidecarTxt: z.boolean().optional(),
  }).refine((value) => Boolean(value.folder?.trim() || value.files?.length), { message: '需要选择图片目录或图片文件' }),

  aiChat: z.object({
    providerId: z.string().min(1).max(120),
    conversationId: z.string().max(120).optional(),
    messages: z.array(z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string().min(1).max(32000),
    })).min(1).max(40),
    system: z.string().max(16000).optional(),
  }),

  projectId: z.object({ id: z.string().min(1).max(120) }),

  projectLayer: z.object({
    id: z.string().min(1).max(120),
    kind: z.enum(['object', 'character', 'text']),
    caption: z.string().max(4000),
    text: z.string().max(4000).optional(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    visible: z.boolean(),
    locked: z.boolean(),
    opacity: z.number().min(0).max(1),
  }),

  projectSave: z.object({
    id: z.string().max(120).optional(),
    name: z.string().min(1).max(200),
    width: z.number().int().min(64).max(4096),
    height: z.number().int().min(64).max(4096),
    summary: z.object({
      caption: z.string().max(4000),
      meta: z.array(z.string().max(200)).max(100),
      canvas: z.enum(['single', 'multi_panel', 'collage']),
    }),
    layers: z.array(z.object({
      id: z.string().min(1).max(120),
      kind: z.enum(['object', 'character', 'text']),
      caption: z.string().max(4000),
      text: z.string().max(4000).optional(),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      visible: z.boolean(),
      locked: z.boolean(),
      opacity: z.number().min(0).max(1),
    })).max(200),
    prompt: z.string().max(20000),
    negative: z.string().max(8000),
    seed: z.number().int(),
    steps: z.number().int().min(1).max(1000),
    cfg: z.number().min(0).max(20),
    instanceId: z.string().max(160).optional(),
    backgroundPath: z.string().max(4096).optional(),
    seriesId: z.string().max(120).optional(),
    page: z.number().int().min(1).max(9999).optional(),
  }),

  caseSave: z.object({
    id: z.string().max(80).optional(),
    name: z.string().max(120).optional(),
    instanceId: z.string().min(1).max(120),
    workspace: z.literal('clover'),
    deviceId: z.string().min(1).max(120),
    profile: z.enum(['base', 'dmd8']),
  }),

  caseRemove: z.object({ id: z.string().min(1).max(80) }),

  sshTerminalOpen: z.object({ hostId: z.string().min(1).max(80) }),
  sshTerminalInput: z.object({ id: z.string().min(1).max(120), data: z.string().max(65536) }),
  sshTerminalClose: z.object({ id: z.string().min(1).max(120) }),

  jobStart: z.object({
    instanceId: z.string().min(1).max(120),
    prompt: z.string().max(32768),
    negativePrompt: z.string().max(8192).default(''),
    width: z.number().int().min(256).max(2048).multipleOf(16),
    height: z.number().int().min(256).max(2048).multipleOf(16),
    steps: z.number().int().min(1).max(100),
    cfg: z.number().min(0).max(20),
    seed: z.number().int().min(0).max(4294967295),
    profile: z.enum(['base', 'dmd8']).default('base'),
    mode: z.enum(['runner', 'simulate']).default('runner'),
    caseId: z.string().max(80).optional(),
    caseName: z.string().max(120).optional(),
    workspace: z.literal('clover').optional(),
    deviceId: z.string().max(120).optional(),
    kind: z.enum(['inference', 'training']).optional(),
  }),

  jobId: z.object({ id: z.string().min(1).max(120) }),

  jobInput: z.object({
    id: z.string().min(1).max(120),
    text: z.string().max(4096),
  }),

  diagnosticsDismiss: z.object({ id: z.string().min(1).max(120) }),

  galleryList: z.object({
    cursor: z.string().max(32).optional(),
    limit: z.number().int().min(1).max(120).default(48),
    query: z.string().max(200).optional(),
    root: z.string().max(4096).optional(),
  }),

  galleryItem: z.object({ path: pathLike }),

  galleryReveal: z.object({ path: pathLike }),

  pickImages: z.object({ title: z.string().max(120).optional() }),

  pickDialog: z.object({
    kind: z.enum(['folder', 'image', 'file']).default('folder'),
    title: z.string().max(120).optional(),
  }),

  openPath: z.object({ path: pathLike }),

  openExternal: z.object({ url: urlLike }),
}

export type Schemas = typeof schemas
