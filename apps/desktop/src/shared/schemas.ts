import { z } from 'zod'

const pathLike = z.string().trim().min(1, '目录路径不能为空').max(4096)
const urlLike = z
  .string()
  .min(8)
  .max(2048)
  .regex(/^https?:\/\//)
const hfEndpoint = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }, '请输入有效的 HTTP/HTTPS HF 地址')
const downloadProxy = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true
    try {
      const url = new URL(value)
      return (
        ['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol) &&
        Boolean(url.hostname) &&
        !url.search &&
        !url.hash &&
        (!url.pathname || url.pathname === '/')
      )
    } catch {
      return false
    }
  }, '代理需使用 HTTP/HTTPS/SOCKS4/SOCKS4a/SOCKS5/SOCKS5h 地址')
const hfToken = z
  .string()
  .trim()
  .max(2048)
  .regex(/^[^\r\n\0]*$/, 'Token 不能包含换行或 NUL')
/** A file path handed to the engine: non-empty, no NUL (the engine refuses both). */
const inputPath = z
  .string()
  .max(4096)
  .refine((value) => value.trim().length > 0, '图片路径不能为空')
  .regex(/^[^\0]*$/, '图片路径不能包含 NUL')
const unitInterval = (label: string) => z.number().min(0, `${label}需在 0 到 1 之间`).max(1, `${label}需在 0 到 1 之间`)

/** The pictures a canvas takes in, as links to other canvases (see CanvasInputs). */
const canvasImageLinkSchema = z.object({
  canvasId: z.string().min(1).max(120),
  output: z.number().int().min(0).max(63).optional(),
})

const resizeModeSchema = z.enum(['crop', 'fit', 'stretch'])

const samplingSchema = z.object({
  sampler: z.string().min(1).max(64).optional(),
  scheduler: z.string().min(1).max(64).optional(),
  shift: z.number().optional(),
  hires: z
    .object({
      // 64 like every canvas size (a hires result card takes this size).
      width: z
        .number()
        .int()
        .min(64, '高清修复尺寸至少 64')
        .max(4096, '高清修复尺寸最大 4096')
        .multipleOf(16, '高清修复尺寸需为 16 的倍数'),
      height: z
        .number()
        .int()
        .min(64, '高清修复尺寸至少 64')
        .max(4096, '高清修复尺寸最大 4096')
        .multipleOf(16, '高清修复尺寸需为 16 的倍数'),
      steps: z.number().int().min(0).max(1000).optional(),
      strength: unitInterval('高清修复重绘幅度').optional(),
    })
    .optional(),
  stepCache: z.string().min(1).max(32).optional(),
  cfgTruncation: unitInterval('CFG 截断').optional(),
})

/**
 * The image inputs of a generation (JobParams.initImage … sampling), with the
 * engine's own limits (moss-server test_protocol.py) so a bad request gets a
 * readable answer before it reaches the engine.
 */
export const jobInputsSchema = z
  .object({
    initImage: z
      .object({
        path: inputPath,
        strength: unitInterval('重绘幅度'),
        resize: resizeModeSchema.optional(),
      })
      .optional(),
    mask: z.object({ path: inputPath }).optional(),
    control: z
      .object({
        adapter: inputPath,
        loraStrength: z.number().min(-10).max(10).optional(),
        images: z
          .array(
            z.object({
              kind: z.string().trim().min(1, '控制类型不能为空').max(64),
              path: inputPath,
              strength: z.number().min(0, '控制强度需在 0 到 10 之间').max(10, '控制强度需在 0 到 10 之间'),
              start: unitInterval('控制开始位置'),
              end: unitInterval('控制结束位置'),
            }),
          )
          .max(16, '控制图最多 16 张'),
      })
      .optional(),
    references: z
      .object({
        paths: z.array(inputPath).min(1, '至少需要 1 张参考图').max(4, '参考图最多 4 张'),
        maxEdge: z
          .number()
          .int('参考图边长需为整数')
          .min(16, '参考图边长需在 16 到 2048 之间')
          .max(2048, '参考图边长需在 16 到 2048 之间')
          .optional(),
      })
      .optional(),
    sampling: samplingSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mask && !value.initImage) {
      ctx.addIssue({ code: 'custom', path: ['mask'], message: '遮罩需要先设置起始图' })
    }
    const kinds = new Set<string>()
    value.control?.images.forEach((image, index) => {
      if (image.start > image.end) {
        ctx.addIssue({ code: 'custom', path: ['control', 'images', index], message: '控制图的开始位置不能晚于结束位置' })
      }
      if (kinds.has(image.kind)) {
        ctx.addIssue({ code: 'custom', path: ['control', 'images', index], message: `「${image.kind}」控制图只能有一张` })
      }
      kinds.add(image.kind)
    })
  })

const projectCanvasSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(['layout', 'result', 'image']),
  imagePath: z.string().max(4096).optional(),
  /** Pixel size of `imagePath` (up to studio:import-image's 16384 limit); width/height are the card's. */
  imageSize: z
    .object({
      width: z.number().int().min(1).max(16384),
      height: z.number().int().min(1).max(16384),
    })
    .optional(),
  inputs: z
    .object({
      init: z.object({ link: canvasImageLinkSchema, strength: z.number().min(0).max(1), resize: resizeModeSchema.optional() }).optional(),
      mask: z.object({ path: z.string().min(1).max(4096) }).optional(),
      control: z
        .object({
          // '' while a control image is linked before an adapter is picked (generate is blocked then).
          adapterId: z.string().max(200),
          loraStrength: z.number().optional(),
          images: z
            .array(
              z.object({
                kind: z.string().min(1).max(64),
                link: canvasImageLinkSchema,
                strength: z.number().min(0).max(10),
                start: z.number().min(0).max(1),
                end: z.number().min(0).max(1),
              }),
            )
            .max(16),
        })
        .optional(),
      references: z
        .object({
          links: z.array(canvasImageLinkSchema).max(4),
          maxEdge: z.number().int().min(16).max(2048).optional(),
        })
        .optional(),
    })
    .optional(),
  sampling: samplingSchema.optional(),
  /** First-pass size of a hires result card (width/height are then the output size). */
  baseSize: z
    .object({
      width: z.number().int().min(64).max(4096),
      height: z.number().int().min(64).max(4096),
    })
    .optional(),
  title: z.string().max(200),
  x: z.number().int().min(-100000).max(100000),
  y: z.number().int().min(-100000).max(100000),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  summary: z.object({
    caption: z.string().max(4000),
    meta: z.array(z.string().max(200)).max(100),
    canvas: z.enum(['single', 'multi_panel', 'collage']),
  }),
  layers: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        kind: z.enum(['object', 'character', 'text']),
        caption: z.string().max(4000),
        text: z.string().max(4000).optional(),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        visible: z.boolean(),
        locked: z.boolean(),
        opacity: z.number().min(0).max(1),
      }),
    )
    .max(200),
  prompt: z.string().max(20000),
  negative: z.string().max(8000),
  seed: z.number().int(),
  steps: z.number().int().min(1).max(1000),
  cfg: z.number().min(0).max(20),
  modelBundleId: z.string().max(160).optional(),
  deviceUuid: z.string().min(1).max(200).optional(),
  deviceId: z.string().max(160).optional(),
  backgroundPath: z.string().max(4096).optional(),
  sourceCanvasId: z.string().max(120).optional(),
  pinned: z.boolean().optional(),
  shownOutput: canvasImageLinkSchema.optional(),
  jobId: z.string().max(160).optional(),
  jobState: z.enum(['queued', 'starting', 'running', 'succeeded', 'failed', 'canceled']).optional(),
  progress: z
    .object({
      stage: z.enum(['load', 'text', 'denoise', 'decode', 'save', 'ready', 'idle']),
      current: z.number(),
      total: z.number(),
      percent: z.number(),
      etaMs: z.number().optional(),
      message: z.string().optional(),
    })
    .optional(),
  outputs: z
    .array(
      z.object({
        path: z.string().max(4096),
        width: z.number(),
        height: z.number(),
        seed: z.number(),
      }),
    )
    .max(64)
    .optional(),
  error: z.object({ code: z.string().max(120), message: z.string().max(4000) }).optional(),
  adapters: z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        strength: z.number().min(0).max(2),
        path: z.string().max(4096).optional(),
      }),
    )
    .max(16)
    .optional(),
  seedLocked: z.boolean().optional(),
})

const hostSaveSchema = z.object({
  id: z.string().max(80).optional(),
  name: z.string().max(120).default(''),
  host: z.string().min(1).max(255),
  user: z.string().min(1).max(120),
  port: z.number().int().min(1).max(65535).optional(),
  authMethod: z.enum(['identityFile', 'password', 'none']).optional(),
  identityFile: z.string().max(4096).optional(),
  password: z
    .string()
    .max(1024)
    .regex(/^[^\r\n\0]*$/, '密码不能包含换行或 NUL')
    .optional(),
  trainerRoot: z.string().min(1).max(4096),
  instanceRoot: z.string().max(4096).optional(),
  modelsRoot: z.string().max(4096).optional(),
  downloadProxy: downloadProxy.optional(),
  hfEndpoint: hfEndpoint.optional(),
  downloadConcurrency: z.number().int().min(1).max(16).nullable().optional(),
  hfToken: hfToken.optional(),
  clearHfToken: z.boolean().optional(),
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
      hfEndpoint: hfEndpoint.nullable(),
      hfToken: hfToken.nullable().optional(),
      modelDownloadConcurrency: z.number().int().min(1).max(16),
      hfQueryHostId: z.string().max(120).nullable(),
      modelsRoot: z.string().max(4096).nullable(),
      modelDirectories: z
        .object({
          dit: z.string().max(4096).nullable().optional(),
          textEncoder: z.string().max(4096).nullable().optional(),
          vae: z.string().max(4096).nullable().optional(),
          support: z.string().max(4096).nullable().optional(),
          adapters: z.string().max(4096).nullable().optional(),
        })
        .optional(),
      pythonPath: z.string().max(4096).nullable(),
      torchBackend: z.enum(['auto', 'cpu', 'cuda']),
      torchIndex: z.string().max(2048).nullable(),
      desktopNotifications: z.boolean(),
      lanWebEnabled: z.boolean(),
      lanWebPort: z.number().int().min(1024).max(65535).nullable(),
      lanWebInstanceId: z.string().max(120).nullable(),
      updateChannel: z.enum(['stable', 'beta']),
      autoDownloadUpdates: z.boolean(),
      sidebarCollapsed: z.boolean(),
      onboardingState: z.enum(['pending', 'active', 'dismissed', 'completed']),
      onboardingHostId: z.string().min(1).max(80),
      galleryRoots: z.array(z.string().max(4096)).max(20),
      homeBackground: z.string().max(4096).nullable(),
      trainerRoot: z.string().max(4096).nullable(),
      engineRoot: z.string().max(4096).nullable(),
      gbcRoot: z.string().max(4096).nullable(),
      disabledDevices: z.array(z.string().max(200)).max(64),
      deviceLabels: z.record(z.string().max(200), z.string().max(200)),
      inferenceBackend: z.enum(['runner', 'mossinfer']),
      mossInferServerPath: z.string().max(4096).nullable(),
      mossInferMemoryMode: z.enum(['min_memory', 'balanced', 'max_speed']),
      mossInferTier: z.enum(['reference', 'high', 'turbo']),
      mossInferChannel: z.enum(['stable', 'dev']),
      engineDeviceOverrides: z
        .record(z.string().min(1).max(200), z.string().regex(/^(?:(?:cu12|cu13)(?:-sm75|-sm70)?(?:-system-cuda)?|vulkan|hip)$/))
        .refine((value) => Object.keys(value).length <= 64, '最多 64 块 GPU'),
      gpuSelection: z.union([z.literal('auto'), z.object({ uuid: z.string().min(1).max(200) })]),
      gpuProfileMode: z.enum(['auto', 'custom']),
      gpuProfileOverrides: z.record(
        z.string().max(200),
        z.object({
          memoryMode: z.enum(['min_memory', 'balanced', 'max_speed']).optional(),
          tier: z.enum(['reference', 'high', 'turbo']).optional(),
        }),
      ),
      githubToken: z.string().max(200).nullable().optional(),
      remoteHostsEnabled: z.boolean(),
      trainingEnabled: z.boolean(),
      engineAutoUpdate: z.boolean(),
    })
    .partial(),

  mossInferDownload: z.object({
    channel: z.enum(['stable', 'dev']),
    /** Package ids to install; omitted = what the plan says is missing. */
    packages: z
      .array(z.string().regex(/^(?:(?:cu12|cu13)(?:-sm75|-sm70)?(?:-system-cuda)?|vulkan|hip)$/))
      .min(1)
      .max(8)
      .optional(),
    /** Reinstall every planned package. */
    all: z.boolean().optional(),
    cudaWheels: z.boolean().optional(),
    releaseTag: z.string().min(1).max(120).optional(),
  }),

  enginePlan: z
    .object({
      refresh: z.boolean().optional(),
      channel: z.enum(['stable', 'dev']).optional(),
      releaseTag: z.string().min(1).max(120).optional(),
    })
    .optional(),

  engineVersionId: z.object({ id: z.string().min(1).max(240) }),
  engineSelectDirectory: z.object({ path: pathLike }),

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

  modelsScan: z.object({
    directory: z.string().trim().max(4096).optional(),
  }),

  modelsRegisterScan: z.object({
    items: z
      .array(
        z.object({
          path: pathLike,
          role: z.enum(['dit', 'text_encoder', 'vae', 'support', 'full']),
          name: z.string().max(260).optional(),
          relativePath: z.string().max(4096).optional(),
          layout: z.enum(['comfyui-single-file', 'diffusers-folder']).optional(),
        }),
      )
      .min(1)
      .max(2000),
  }),

  instanceModelBinding: z.object({
    id: z.string().min(1).max(120),
    binding: z
      .object({
        bundleId: z.string().min(1).max(160),
        dit: z.string().min(1).max(160),
        textEncoder: z.string().min(1).max(160),
        vae: z.string().min(1).max(160),
      })
      .nullable(),
  }),
  instanceAdapters: z.object({
    id: z.string().min(1).max(120),
    bindings: z
      .array(
        z.object({
          id: z.string().min(1).max(160),
          enabled: z.boolean(),
          strength: z.number().min(0).max(4),
        }),
      )
      .max(200),
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
    route: z
      .string()
      .regex(/^\/[a-z0-9/_-]*(?:\?instanceId=[a-z0-9._%~-]+)?$/i)
      .max(120)
      .optional(),
  }),

  copyText: z.object({ text: z.string().max(4096) }),

  updateSetChannel: z.object({ channel: z.enum(['stable', 'beta']) }),

  /** update:set-auto-download and update:restart-when-idle. */
  updateToggle: z.object({ enabled: z.boolean() }),

  trainerCommits: z.object({
    branch: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(200).default(80),
  }),

  trainerHostSave: hostSaveSchema,

  trainerHostRemove: z.object({ id: z.string().min(1).max(80) }),

  trainerHostTest: z.object({ id: z.string().min(1).max(80) }),

  hostsList: z.object({}).optional(),

  hostSave: hostSaveSchema,

  remoteResourceInspect: z.object({
    hostId: z.string().min(1).max(120),
    kind: z.enum(['engine', 'models', 'outputs']),
    path: z.string().min(1).max(4096),
  }),
  remoteResourceRemove: z.object({ hostId: z.string().min(1).max(120), path: z.string().min(1).max(4096) }),

  modelsRemoteInventory: z.object({ hostId: z.string().min(1).max(120), modelsRoot: z.string().max(4096).optional() }),

  modelsRemoteDownload: z.object({ hostId: z.string().min(1).max(120), modelId: z.string().min(1).max(200) }),
  modelsRemoteDelete: z.object({ hostId: z.string().min(1).max(120), ids: z.array(z.string().min(1).max(200)).min(1).max(50) }),
  remoteDownloadsRefresh: z.object({ hostId: z.string().min(1).max(120) }),
  remoteDownloadControl: z.object({
    hostId: z.string().min(1).max(120),
    taskId: z.string().min(1).max(400),
    operation: z.enum(['pause', 'resume', 'cancel']),
  }),

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

  engineRemoteStatus: z.object({ hostId: z.string().min(1).max(80), refreshCuda: z.boolean().optional() }),

  enginePrepareRemoteModel: z.object({ hostId: z.string().min(1).max(80), repo: z.string().min(1).max(200).optional() }),

  engineInstallRemote: z.object({
    hostId: z.string().min(1).max(80),
    channel: z.enum(['stable', 'dev']).optional(),
    flavour: z.enum(['cu12', 'cu13']).optional(),
    variant: z.enum(['system-cuda', 'bundled']).optional(),
    architecture: z.enum(['auto', 'standard', 'sm75', 'sm70']).optional(),
    releaseTag: z.string().min(1).max(120).optional(),
  }),

  engineSystemCuda: z.object({}).strict(),

  mossInferCudaLibs: z.object({}).strict(),

  gbcCommits: z.object({ branch: z.string().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }),
  gbcVersionCreate: z.object({
    branch: z.string().min(1).max(200),
    commit: z.string().min(7).max(64),
    name: z.string().max(120).optional(),
  }),
  gbcVersionRemove: z.object({ id: z.string().min(1).max(160) }),

  gbcStatusQuery: z.object({ versionId: z.string().max(160).optional() }),
  gbcListImages: z.object({ folder: z.string().min(1).max(4096) }),
  gbcThumbnails: z.object({ paths: z.array(z.string().max(4096)).max(120), width: z.number().int().min(32).max(1600).default(160) }),
  gbcInstallEnv: z.object({ versionId: z.string().min(1).max(160) }),

  gbcRun: z
    .object({
      folder: z.string().max(4096).optional(),
      files: z.array(z.string().max(4096)).max(2000).optional(),
      providerId: z.string().min(1).max(120),
      detector: z.enum(['owlv2', 'sam3']).default('owlv2'),
      versionId: z.string().max(160).optional(),
      sidecarJson: z.boolean().optional(),
      sidecarTxt: z.boolean().optional(),
    })
    .refine((value) => Boolean(value.folder?.trim() || value.files?.length), { message: '需要选择图片目录或图片文件' }),

  aiChat: z
    .object({
      providerId: z.string().min(1).max(120),
      conversationId: z.string().max(120).optional(),
      message: z.string().max(32000).optional(),
      regenerate: z.boolean().optional(),
      context: z.string().max(16000).optional(),
    })
    .refine((value) => Boolean(value.regenerate || value.message?.trim()), { message: '需要消息或重新生成标记' }),

  aiToolResult: z.object({
    callId: z.string().min(1).max(200),
    result: z.object({
      ok: z.boolean(),
      content: z.string().max(200_000),
    }),
  }),

  aiConversationTitle: z.object({
    id: z.string().min(1).max(120),
    title: z.string().min(1).max(120),
  }),

  projectId: z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/) }),

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
    canvases: z.array(projectCanvasSchema).max(1000),
    selectedCanvasId: z.string().max(120).optional(),
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

  engineFeatures: z.object({
    deviceUuid: z.string().min(1).max(200).optional(),
    hostId: z.string().min(1).max(80).optional(),
  }),

  /** A picture file by path, or its bytes (a paste, a browser drop). */
  studioImportImage: z
    .object({
      projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/, 'Project 无效'),
      path: pathLike.optional(),
      bytes: z.instanceof(Uint8Array).optional(),
    })
    .refine((value) => Boolean(value.path) !== Boolean(value.bytes), '需要图片路径或图片内容（二选一）'),

  studioSaveMask: z.object({
    projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/, 'Project 无效'),
    canvasId: z.string().min(1).max(120),
    png: z.instanceof(Uint8Array),
    /** The mask this one replaces on the canvas (deleted when nothing else uses it). */
    replaces: z.string().min(1).max(4096).optional(),
  }),

  controlAdapterAdd: z.object({ path: pathLike }),

  controlAdapterRemove: z.object({ id: z.string().min(1).max(200) }),

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
    /** Only images generated for this Studio project. */
    projectId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/)
      .optional(),
    /** Only images modified at or after this time (ms since epoch). */
    since: z.number().int().min(0).optional(),
  }),

  galleryItem: z.object({ path: pathLike }),

  galleryReveal: z.object({ path: pathLike }),

  galleryTrash: z.object({ path: pathLike }),

  pickImages: z.object({ title: z.string().max(120).optional() }),

  pickDialog: z.object({
    kind: z.enum(['folder', 'image', 'file']).default('folder'),
    title: z.string().max(120).optional(),
  }),

  openPath: z.object({ path: pathLike }),

  openExternal: z.object({ url: urlLike }),
}

export type Schemas = typeof schemas
