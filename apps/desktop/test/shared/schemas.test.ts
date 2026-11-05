import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { jobInputsSchema, type Schemas, schemas } from '@shared/schemas'

const SHA = 'b'.repeat(64)
const long = (length: number, char = 'a') => char.repeat(length)

interface SchemaCase {
  /** Minimal valid input. */
  valid: unknown
  /** Parsed output of `valid` when it differs (defaults, trimming). */
  output?: unknown
  /** Further valid inputs, usually boundary values. */
  accepts?: Record<string, unknown>
  /** Invalid inputs, each one change away from a valid input. */
  rejects: Record<string, unknown>
}

const layer = {
  id: 'l1',
  kind: 'object',
  caption: 'a cat',
  bbox: [0, 0, 0.5, 0.5],
  visible: true,
  locked: false,
  opacity: 1,
}

const canvas = {
  id: 'c1',
  kind: 'layout',
  title: 'Canvas',
  x: 0,
  y: 0,
  width: 1024,
  height: 1024,
  summary: { caption: '', meta: [], canvas: 'single' },
  layers: [layer],
  prompt: 'a cat',
  negative: '',
  seed: 42,
  steps: 20,
  cfg: 5,
}

const host = { host: 'gpu.example.com', user: 'root', trainerRoot: '/opt/trainer' }

const installer = {
  platform: 'win32',
  arch: 'x64',
  kind: 'exe',
  url: 'https://example.com/setup.exe',
  sha256: SHA,
  size_bytes: 10,
}

const trainerRun = {
  versionId: 'v1',
  action: 'train',
  runName: 'run',
  weights: '/w',
  dataset: '/d',
  algo: 'lora',
  steps: 1000,
  lr: '1e-4',
  dim: '16',
  alpha: '16',
  batch: '1',
  resolution: 1024,
  overrides: '',
}

const launchRow = {
  id: 'r1',
  caseName: 'case',
  instanceId: 'i1',
  instanceName: 'instance',
  workspace: 'clover',
  deviceId: 'cuda:0',
  profile: 'base',
  state: 'queued',
  queuedAt: '2026-11-04T00:00:00Z',
}

const job = { instanceId: 'i1', prompt: 'a cat', width: 512, height: 512, steps: 20, cfg: 5, seed: 0 }

const cases = {
  settingsUpdate: {
    valid: {},
    accepts: {
      'a full update': {
        theme: 'dark',
        language: 'en',
        hfEndpoint: null,
        hfToken: null,
        modelDownloadConcurrency: 16,
        lanWebPort: 65535,
        modelDirectories: { dit: '/m/dit', vae: null },
        gpuSelection: { uuid: 'GPU-1' },
        gpuProfileOverrides: { 'GPU-1': { tier: 'turbo' }, 'GPU-2': {} },
        deviceLabels: { 'GPU-1': 'Main' },
        disabledDevices: Array.from({ length: 64 }, (_, i) => `d${i}`),
        galleryRoots: Array.from({ length: 20 }, (_, i) => `/g${i}`),
      },
      'gpuSelection auto': { gpuSelection: 'auto' },
      'lowest LAN port': { lanWebPort: 1024 },
      'null LAN port': { lanWebPort: null },
      'concurrency 1': { modelDownloadConcurrency: 1 },
      'feature toggles': { remoteHostsEnabled: true, trainingEnabled: false, engineAutoUpdate: true },
      'per-GPU engines': { engineDeviceOverrides: { 'GPU-1': 'cu13-sm75-system-cuda', 'vk-1002-744c-0': 'hip', 'vk-8086-56a0-0': 'vulkan' } },
      'no per-GPU engines': { engineDeviceOverrides: {} },
    },
    rejects: {
      'unknown theme': { theme: 'blue' },
      'null theme': { theme: null },
      'concurrency 0': { modelDownloadConcurrency: 0 },
      'concurrency 17': { modelDownloadConcurrency: 17 },
      'fractional concurrency': { modelDownloadConcurrency: 1.5 },
      'privileged LAN port': { lanWebPort: 1023 },
      'LAN port 65536': { lanWebPort: 65536 },
      'empty onboarding host': { onboardingHostId: '' },
      '21 gallery roots': { galleryRoots: Array.from({ length: 21 }, (_, i) => `/g${i}`) },
      '65 disabled devices': { disabledDevices: Array.from({ length: 65 }, (_, i) => `d${i}`) },
      'empty gpu uuid': { gpuSelection: { uuid: '' } },
      'gpuSelection manual': { gpuSelection: 'manual' },
      'unknown override tier': { gpuProfileOverrides: { g: { tier: 'ultra' } } },
      'overlong device label key': { deviceLabels: { [long(201)]: 'x' } },
      'overlong github token': { githubToken: long(201) },
      'numeric hfEndpoint': { hfEndpoint: 1 },
      'non-boolean flag': { autoCheckUpdates: 'yes' },
      'non-boolean feature toggle': { remoteHostsEnabled: 1 },
      'null engine auto-update': { engineAutoUpdate: null },
      'unknown engine package': { engineDeviceOverrides: { 'GPU-1': 'cu11' } },
      'engine package for no GPU': { engineDeviceOverrides: { '': 'vulkan' } },
      '65 per-GPU engines': { engineDeviceOverrides: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`GPU-${i}`, 'vulkan'])) },
    },
  },

  mossInferDownload: {
    valid: { channel: 'stable' },
    accepts: {
      'every option': { channel: 'dev', packages: ['cu13-sm75-system-cuda', 'vulkan', 'hip', 'cu12-sm70'], all: true, cudaWheels: true, releaseTag: 'v2.1.1' },
      'the old flavour fields are ignored': { channel: 'stable', flavour: 'cu12', variant: 'bundled' },
    },
    rejects: {
      'missing channel': {},
      'unknown channel': { channel: 'nightly' },
      'unknown package': { channel: 'stable', packages: ['cu11'] },
      'empty package list': { channel: 'stable', packages: [] },
      'empty release tag': { channel: 'stable', releaseTag: '' },
      'overlong release tag': { channel: 'stable', releaseTag: long(121) },
    },
  },

  engineVersionId: {
    valid: { id: 'v2.1.1' },
    accepts: { 'longest id': { id: long(240) } },
    rejects: { 'empty id': { id: '' }, 'overlong id': { id: long(241) }, 'numeric id': { id: 1 } },
  },

  engineSelectDirectory: {
    valid: { path: '  /opt/engine  ' },
    output: { path: '/opt/engine' },
    rejects: { 'blank path': { path: '   ' }, 'overlong path': { path: long(4097) }, 'missing path': {} },
  },

  onboardingStatus: {
    valid: undefined,
    accepts: { 'empty object': {}, 'host id': { hostId: 'local' } },
    rejects: { 'empty host id': { hostId: '' }, 'overlong host id': { hostId: long(81) }, null: null },
  },

  gitBranches: {
    valid: undefined,
    accepts: { 'https source': { source: 'https://github.com/a/b' }, 'shortest url': { source: 'http://a' } },
    rejects: {
      'ftp source': { source: 'ftp://example.com/repo' },
      'schemeless source': { source: 'github.com/a/b' },
      'too short': { source: 'http:/' },
      'overlong source': { source: `https://${long(2041)}` },
    },
  },

  gitCommits: {
    valid: { branch: 'main' },
    output: { branch: 'main', limit: 60 },
    accepts: { 'limit 1': { branch: 'main', limit: 1 }, 'limit 200': { branch: 'main', limit: 200 } },
    rejects: {
      'empty branch': { branch: '' },
      'limit 0': { branch: 'main', limit: 0 },
      'limit 201': { branch: 'main', limit: 201 },
      'fractional limit': { branch: 'main', limit: 1.5 },
      'bad source': { branch: 'main', source: 'git@github.com:a/b' },
    },
  },

  instanceCreate: {
    valid: { branch: 'main', commit: 'abcdef0' },
    output: { branch: 'main', commit: 'abcdef0', runtimeMode: 'shared' },
    accepts: { 'full sha': { branch: 'main', commit: long(40, 'f'), runtimeMode: 'isolated', name: long(60) } },
    rejects: {
      'short sha': { branch: 'main', commit: 'abcdef' },
      'overlong sha': { branch: 'main', commit: long(41, 'f') },
      'uppercase sha': { branch: 'main', commit: 'ABCDEF0' },
      'non-hex sha': { branch: 'main', commit: 'abcdefg' },
      'empty name': { branch: 'main', commit: 'abcdef0', name: '' },
      'overlong name': { branch: 'main', commit: 'abcdef0', name: long(61) },
      'unknown runtime mode': { branch: 'main', commit: 'abcdef0', runtimeMode: 'docker' },
      'overlong host id': { branch: 'main', commit: 'abcdef0', hostId: long(81) },
    },
  },

  instanceRemoteHost: {
    valid: { hostId: 'h1' },
    rejects: { 'empty host id': { hostId: '' }, 'overlong host id': { hostId: long(81) } },
  },

  instanceRemoteCommits: {
    valid: { hostId: 'h1', branch: 'main' },
    output: { hostId: 'h1', branch: 'main', limit: 80 },
    rejects: { 'missing branch': { hostId: 'h1' }, 'limit 201': { hostId: 'h1', branch: 'main', limit: 201 } },
  },

  instanceDelete: {
    valid: { id: 'i1' },
    output: { id: 'i1', keepOutputs: true },
    accepts: { 'drop outputs': { id: 'i1', keepOutputs: false } },
    rejects: { 'empty id': { id: '' }, 'string flag': { id: 'i1', keepOutputs: 'false' } },
  },

  modelBundle: {
    valid: { id: 'moss-sft' },
    rejects: { 'empty id': { id: '' }, 'overlong id': { id: long(161) } },
  },

  modelsScan: {
    valid: {},
    accepts: { 'blank directory is allowed': { directory: '   ' } },
    rejects: { 'overlong directory': { directory: long(4097) }, 'numeric directory': { directory: 1 } },
  },

  modelsRegisterScan: {
    valid: { items: [{ path: ' /m/dit.safetensors ', role: 'dit' }] },
    output: { items: [{ path: '/m/dit.safetensors', role: 'dit' }] },
    accepts: {
      'every field': { items: [{ path: '/m/x', role: 'full', name: 'x', relativePath: 'x', layout: 'diffusers-folder' }] },
      '2000 items': { items: Array.from({ length: 2000 }, () => ({ path: '/m/x', role: 'vae' })) },
    },
    rejects: {
      'no items': { items: [] },
      '2001 items': { items: Array.from({ length: 2001 }, () => ({ path: '/m/x', role: 'vae' })) },
      'unknown role': { items: [{ path: '/m/x', role: 'lora' }] },
      'blank path': { items: [{ path: ' ', role: 'vae' }] },
      'unknown layout': { items: [{ path: '/m/x', role: 'vae', layout: 'ckpt' }] },
      'overlong name': { items: [{ path: '/m/x', role: 'vae', name: long(261) }] },
    },
  },

  instanceModelBinding: {
    valid: { id: 'i1', binding: null },
    accepts: { binding: { id: 'i1', binding: { bundleId: 'b', dit: 'd', textEncoder: 't', vae: 'v' } } },
    rejects: {
      'missing binding': { id: 'i1' },
      'partial binding': { id: 'i1', binding: { bundleId: 'b', dit: 'd', textEncoder: 't' } },
      'empty component': { id: 'i1', binding: { bundleId: 'b', dit: '', textEncoder: 't', vae: 'v' } },
    },
  },

  instanceAdapters: {
    valid: { id: 'i1', bindings: [] },
    accepts: { 'max strength': { id: 'i1', bindings: [{ id: 'a', enabled: true, strength: 4 }] } },
    rejects: {
      'strength above 4': { id: 'i1', bindings: [{ id: 'a', enabled: true, strength: 4.01 }] },
      'negative strength': { id: 'i1', bindings: [{ id: 'a', enabled: true, strength: -0.1 }] },
      '201 bindings': { id: 'i1', bindings: Array.from({ length: 201 }, () => ({ id: 'a', enabled: true, strength: 1 })) },
      'missing enabled': { id: 'i1', bindings: [{ id: 'a', strength: 1 }] },
    },
  },

  instanceUpdate: {
    valid: { id: 'i1', commit: '0123456789abcdef' },
    rejects: { 'bad commit': { id: 'i1', commit: 'HEAD' }, 'empty id': { id: '', commit: 'abcdef0' } },
  },

  instanceId: { valid: { id: 'i1' }, rejects: { 'empty id': { id: '' }, 'overlong id': { id: long(121) } } },
  instanceOpen: { valid: { id: 'i1' }, rejects: { 'empty id': { id: '' }, 'overlong id': { id: long(121) } } },
  runtimeInstall: { valid: { instanceId: 'i1' }, rejects: { 'wrong key': { id: 'i1' }, 'overlong id': { instanceId: long(121) } } },

  download: {
    valid: { kind: 'model', id: 'm1' },
    accepts: { adapter: { kind: 'adapter', id: 'a1' } },
    rejects: { 'unknown kind': { kind: 'lora', id: 'a1' }, 'empty id': { kind: 'model', id: '' } },
  },

  modelPause: { valid: { taskId: 't1' }, rejects: { 'empty task id': { taskId: '' }, 'overlong task id': { taskId: long(161) } } },

  downloadDelete: {
    valid: { kind: 'adapter', id: 'a1' },
    rejects: { 'unknown kind': { kind: 'bundle', id: 'a1' }, 'overlong id': { kind: 'model', id: long(161) } },
  },

  announcementsDismiss: { valid: { id: 'welcome' }, rejects: { 'empty id': { id: '' }, 'overlong id': { id: long(121) } } },

  windowOpen: {
    valid: { kind: 'studio' },
    accepts: {
      'plain route': { kind: 'trainer', route: '/trainer/runs' },
      'root route': { kind: 'studio', route: '/' },
      'instance query': { kind: 'studio', route: '/studio?instanceId=abc.1%20~-' },
      'mixed case': { kind: 'studio', route: '/Studio?instanceId=ABC' },
    },
    rejects: {
      'unknown kind': { kind: 'settings' },
      'relative route': { kind: 'studio', route: 'studio' },
      'external url': { kind: 'studio', route: 'https://evil.example/' },
      'protocol-relative': { kind: 'studio', route: '//evil.example' },
      'other query key': { kind: 'studio', route: '/studio?x=1' },
      'empty instance id': { kind: 'studio', route: '/studio?instanceId=' },
      'extra query param': { kind: 'studio', route: '/studio?instanceId=a&x=1' },
      'space in route': { kind: 'studio', route: '/a b' },
      'overlong route': { kind: 'studio', route: `/${long(120)}` },
    },
  },

  copyText: {
    valid: { text: '' },
    accepts: { 'longest text': { text: long(4096) } },
    rejects: { 'overlong text': { text: long(4097) }, 'missing text': {} },
  },

  updatesDownload: {
    valid: { version: '1.0.3', installer },
    rejects: {
      'empty version': { version: '', installer },
      'bad installer digest': { version: '1.0.3', installer: { ...installer, sha256: 'x' } },
      'unknown installer kind': { version: '1.0.3', installer: { ...installer, kind: 'msi' } },
    },
  },

  updatesCancel: { valid: { version: '1.0.3' }, rejects: { 'empty version': { version: '' }, 'overlong version': { version: long(81) } } },

  trainerCommits: {
    valid: { branch: 'main' },
    output: { branch: 'main', limit: 80 },
    rejects: { 'empty branch': { branch: '' }, 'limit 0': { branch: 'main', limit: 0 } },
  },

  trainerHostSave: {
    valid: host,
    output: { ...host, name: '' },
    accepts: {
      'every field': {
        ...host,
        id: 'h1',
        name: 'GPU box',
        port: 65535,
        authMethod: 'password',
        password: 'p@ss word',
        identityFile: '~/.ssh/id_ed25519',
        instanceRoot: '/i',
        modelsRoot: '/m',
        downloadProxy: 'socks5h://127.0.0.1:1080',
        hfEndpoint: 'https://hf-mirror.com',
        downloadConcurrency: 16,
        hfToken: 'hf_abc',
        clearHfToken: true,
      },
      'null concurrency': { ...host, downloadConcurrency: null },
      'port 1': { ...host, port: 1 },
    },
    rejects: {
      'empty host': { ...host, host: '' },
      'empty user': { ...host, user: '' },
      'empty trainer root': { ...host, trainerRoot: '' },
      'port 0': { ...host, port: 0 },
      'port 65536': { ...host, port: 65536 },
      'unknown auth': { ...host, authMethod: 'kerberos' },
      'password with newline': { ...host, password: 'a\nb' },
      'password with NUL': { ...host, password: 'a\0b' },
      'concurrency 17': { ...host, downloadConcurrency: 17 },
      'bad proxy': { ...host, downloadProxy: 'ftp://proxy' },
      'bad hf endpoint': { ...host, hfEndpoint: 'ftp://hf' },
      'token with newline': { ...host, hfToken: 'a\rb' },
    },
  },

  trainerHostRemove: { valid: { id: 'h1' }, rejects: { 'empty id': { id: '' }, 'overlong id': { id: long(81) } } },
  trainerHostTest: { valid: { id: 'h1' }, rejects: { 'empty id': { id: '' }, 'overlong id': { id: long(81) } } },

  hostsList: {
    valid: undefined,
    accepts: { 'empty object': {} },
    rejects: { null: null, string: 'all' },
  },

  hostSave: {
    valid: host,
    output: { ...host, name: '' },
    rejects: { 'overlong host': { ...host, host: long(256) }, 'overlong name': { ...host, name: long(121) } },
  },

  remoteResourceInspect: {
    valid: { hostId: 'h1', kind: 'engine', path: '/opt/engine' },
    rejects: {
      'unknown kind': { hostId: 'h1', kind: 'logs', path: '/x' },
      'empty path': { hostId: 'h1', kind: 'models', path: '' },
      'empty host': { hostId: '', kind: 'outputs', path: '/x' },
    },
  },

  remoteResourceRemove: {
    valid: { hostId: 'h1', path: '/opt/engine' },
    rejects: { 'empty path': { hostId: 'h1', path: '' }, 'overlong path': { hostId: 'h1', path: long(4097) } },
  },

  modelsRemoteInventory: {
    valid: { hostId: 'h1' },
    accepts: { 'with root': { hostId: 'h1', modelsRoot: '/m' } },
    rejects: { 'empty host': { hostId: '' }, 'overlong root': { hostId: 'h1', modelsRoot: long(4097) } },
  },

  modelsRemoteDownload: {
    valid: { hostId: 'h1', modelId: 'm1' },
    rejects: { 'empty model': { hostId: 'h1', modelId: '' }, 'overlong model': { hostId: 'h1', modelId: long(201) } },
  },

  modelsRemoteDelete: {
    valid: { hostId: 'h1', ids: ['moss-sft-dit', 'qwen35-encoder'] },
    rejects: { 'no ids': { hostId: 'h1', ids: [] }, 'empty id': { hostId: 'h1', ids: [''] }, 'too many': { hostId: 'h1', ids: Array.from({ length: 51 }, (_, i) => `m${i}`) }, 'empty host': { hostId: '', ids: ['m'] } },
  },

  remoteDownloadsRefresh: { valid: { hostId: 'h1' }, rejects: { 'empty host': { hostId: '' } } },

  remoteDownloadControl: {
    valid: { hostId: 'h1', taskId: 't1', operation: 'pause' },
    accepts: { resume: { hostId: 'h1', taskId: long(400), operation: 'resume' } },
    rejects: {
      'unknown operation': { hostId: 'h1', taskId: 't1', operation: 'delete' },
      'overlong task': { hostId: 'h1', taskId: long(401), operation: 'cancel' },
    },
  },

  hostUpdatePaths: {
    valid: { id: 'h1' },
    accepts: { 'every path': { id: 'h1', engineRoot: '/e', outputRoot: '/o', modelsRoot: '/m', modelPath: '/m/x' } },
    rejects: { 'empty id': { id: '' }, 'overlong path': { id: 'h1', engineRoot: long(4097) } },
  },

  hostId: { valid: { id: 'h1' }, rejects: { 'empty id': { id: '' }, 'overlong id': { id: long(81) } } },
  trainerRemoteHost: { valid: { hostId: 'h1' }, rejects: { 'empty host': { hostId: '' } } },

  trainerRemoteCommits: {
    valid: { hostId: 'h1', branch: 'main' },
    output: { hostId: 'h1', branch: 'main', limit: 80 },
    rejects: { 'limit 201': { hostId: 'h1', branch: 'main', limit: 201 } },
  },

  trainerRemoteCreate: {
    valid: { hostId: 'h1', branch: 'main', commit: 'abcdef0' },
    accepts: { 'longest commit': { hostId: 'h1', branch: 'main', commit: long(64) } },
    rejects: {
      'short commit': { hostId: 'h1', branch: 'main', commit: 'abc' },
      'overlong commit': { hostId: 'h1', branch: 'main', commit: long(65) },
    },
  },

  trainerRemoteVersion: {
    valid: { hostId: 'h1', versionId: 'v1' },
    rejects: { 'empty version': { hostId: 'h1', versionId: '' } },
  },

  trainerRun: {
    valid: trainerRun,
    accepts: { 'max steps': { ...trainerRun, steps: 1_000_000, resolution: 4096, action: 'sample' } },
    rejects: {
      'unknown action': { ...trainerRun, action: 'deploy' },
      'steps 0': { ...trainerRun, steps: 0 },
      'too many steps': { ...trainerRun, steps: 1_000_001 },
      'resolution 63': { ...trainerRun, resolution: 63 },
      'resolution 4097': { ...trainerRun, resolution: 4097 },
      'numeric lr': { ...trainerRun, lr: 0.0001 },
      'empty dataset': { ...trainerRun, dataset: '' },
      'overlong overrides': { ...trainerRun, overrides: long(8001) },
    },
  },

  trainerCreate: {
    valid: { branch: 'main', commit: 'abcdef0' },
    rejects: { 'short commit': { branch: 'main', commit: 'abcdef' }, 'overlong name': { branch: 'main', commit: 'abcdef0', name: long(121) } },
  },

  trainerId: { valid: { id: 't1' }, rejects: { 'empty id': { id: '' } } },

  launchRow: {
    valid: launchRow,
    accepts: { 'optional fields': { ...launchRow, caseId: 'c', jobId: 'j', startedAt: 'x', error: long(2000), state: 'failed', profile: 'dmd8' } },
    rejects: {
      'other workspace': { ...launchRow, workspace: 'comfy' },
      'unknown state': { ...launchRow, state: 'paused' },
      'unknown profile': { ...launchRow, profile: 'turbo' },
      'missing queuedAt': { ...launchRow, queuedAt: undefined },
      'overlong error': { ...launchRow, error: long(2001) },
    },
  },

  launchRowId: { valid: { id: 'r1' }, rejects: { 'empty id': { id: '' } } },

  aiProviderSave: {
    valid: { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt' },
    accepts: {
      'temperature bounds': { name: 'x', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'm', temperature: 2, apiKey: '' },
      'zero temperature': { name: 'x', kind: 'gemini', baseUrl: 'https://g.example', model: 'm', temperature: 0 },
    },
    rejects: {
      'unknown kind': { name: 'x', kind: 'mistral', baseUrl: 'https://a.example', model: 'm' },
      'not a url': { name: 'x', kind: 'openai', baseUrl: 'api.openai.com', model: 'm' },
      'empty name': { name: '', kind: 'openai', baseUrl: 'https://a.example', model: 'm' },
      'overlong name': { name: long(81), kind: 'openai', baseUrl: 'https://a.example', model: 'm' },
      'empty model': { name: 'x', kind: 'openai', baseUrl: 'https://a.example', model: '' },
      'temperature above 2': { name: 'x', kind: 'openai', baseUrl: 'https://a.example', model: 'm', temperature: 2.1 },
      'negative temperature': { name: 'x', kind: 'openai', baseUrl: 'https://a.example', model: 'm', temperature: -0.1 },
    },
  },

  engineRemoteStatus: {
    valid: { hostId: 'h1' },
    accepts: { refresh: { hostId: 'h1', refreshCuda: true } },
    rejects: { 'empty host': { hostId: '' }, 'string refresh': { hostId: 'h1', refreshCuda: 'yes' } },
  },

  enginePrepareRemoteModel: {
    valid: { hostId: 'h1' },
    accepts: { repo: { hostId: 'h1', repo: 'OpenMOSS/MOSS-Image' } },
    rejects: { 'empty repo': { hostId: 'h1', repo: '' }, 'overlong repo': { hostId: 'h1', repo: long(201) } },
  },

  engineInstallRemote: {
    valid: { hostId: 'h1' },
    accepts: {
      'every option': { hostId: 'h1', channel: 'dev', flavour: 'cu13', variant: 'system-cuda', architecture: 'standard', releaseTag: 'v2' },
      'the Volta / Turing build': { hostId: 'h1', flavour: 'cu12', architecture: 'sm70' },
    },
    rejects: { 'unknown variant': { hostId: 'h1', variant: 'docker' }, 'empty tag': { hostId: 'h1', releaseTag: '' } },
  },

  enginePlan: {
    valid: undefined,
    accepts: { 'every option': { refresh: true, channel: 'dev', releaseTag: 'v2.2.0' }, empty: {} },
    rejects: { 'unknown channel': { channel: 'nightly' }, 'empty tag': { releaseTag: '' } },
  },

  engineSystemCuda: {
    valid: {},
    rejects: { 'any key': { refresh: true }, undefined: undefined },
  },

  mossInferCudaLibs: {
    valid: {},
    rejects: { 'any key': { force: true }, null: null },
  },

  gbcCommits: {
    valid: { branch: 'main' },
    accepts: { limit: { branch: 'main', limit: 200 } },
    rejects: { 'empty branch': { branch: '' }, 'limit 0': { branch: 'main', limit: 0 }, 'overlong branch': { branch: long(201) } },
  },

  gbcVersionCreate: {
    valid: { branch: 'main', commit: 'abcdef0' },
    rejects: { 'short commit': { branch: 'main', commit: 'abc' } },
  },

  gbcVersionRemove: { valid: { id: 'g1' }, rejects: { 'empty id': { id: '' } } },

  gbcStatusQuery: {
    valid: {},
    accepts: { version: { versionId: 'v1' }, 'empty version': { versionId: '' } },
    rejects: { 'overlong version': { versionId: long(161) }, undefined: undefined },
  },

  gbcListImages: { valid: { folder: '/imgs' }, rejects: { 'empty folder': { folder: '' } } },

  gbcThumbnails: {
    valid: { paths: [] },
    output: { paths: [], width: 160 },
    accepts: { 'width bounds low': { paths: ['/a'], width: 32 }, 'width bounds high': { paths: Array.from({ length: 120 }, () => '/a'), width: 1600 } },
    rejects: {
      'width 31': { paths: [], width: 31 },
      'width 1601': { paths: [], width: 1601 },
      '121 paths': { paths: Array.from({ length: 121 }, () => '/a') },
      'fractional width': { paths: [], width: 100.5 },
    },
  },

  gbcInstallEnv: { valid: { versionId: 'v1' }, rejects: { 'empty version': { versionId: '' } } },

  gbcRun: {
    valid: { providerId: 'p1', folder: '/imgs' },
    output: { providerId: 'p1', folder: '/imgs', detector: 'owlv2' },
    accepts: { files: { providerId: 'p1', files: ['/a.png'], detector: 'sam3', sidecarJson: true, sidecarTxt: false } },
    rejects: {
      'neither folder nor files': { providerId: 'p1' },
      'blank folder': { providerId: 'p1', folder: '   ' },
      'empty files': { providerId: 'p1', files: [] },
      'unknown detector': { providerId: 'p1', folder: '/imgs', detector: 'yolo' },
      'empty provider': { providerId: '', folder: '/imgs' },
      '2001 files': { providerId: 'p1', files: Array.from({ length: 2001 }, () => '/a.png') },
    },
  },

  aiChat: {
    valid: { providerId: 'p1', message: 'hi' },
    accepts: {
      regenerate: { providerId: 'p1', regenerate: true },
      'regenerate with blank message': { providerId: 'p1', message: '  ', regenerate: true },
      'with context': { providerId: 'p1', conversationId: 'c', message: 'hi', context: long(16000) },
    },
    rejects: {
      'no message': { providerId: 'p1' },
      'blank message': { providerId: 'p1', message: '  \n ' },
      'regenerate false': { providerId: 'p1', regenerate: false },
      'overlong message': { providerId: 'p1', message: long(32001) },
      'overlong context': { providerId: 'p1', message: 'hi', context: long(16001) },
      'empty provider': { providerId: '', message: 'hi' },
    },
  },

  aiToolResult: {
    valid: { callId: 'c1', result: { ok: true, content: '' } },
    accepts: { 'largest content': { callId: 'c1', result: { ok: false, content: long(200_000) } } },
    rejects: {
      'missing ok': { callId: 'c1', result: { content: '' } },
      'overlong content': { callId: 'c1', result: { ok: true, content: long(200_001) } },
      'empty call id': { callId: '', result: { ok: true, content: '' } },
    },
  },

  aiConversationTitle: {
    valid: { id: 'c1', title: 'Chat' },
    rejects: { 'empty title': { id: 'c1', title: '' }, 'overlong title': { id: 'c1', title: long(121) } },
  },

  projectId: { valid: { id: 'p1' }, rejects: { 'empty id': { id: '' } } },

  projectLayer: {
    valid: layer,
    accepts: { 'text layer': { ...layer, kind: 'text', text: 'Hello', opacity: 0 } },
    rejects: {
      'three-number bbox': { ...layer, bbox: [0, 0, 1] },
      'five-number bbox': { ...layer, bbox: [0, 0, 1, 1, 1] },
      'string in bbox': { ...layer, bbox: [0, 0, '1', 1] },
      'opacity above 1': { ...layer, opacity: 1.01 },
      'negative opacity': { ...layer, opacity: -0.01 },
      'unknown kind': { ...layer, kind: 'mask' },
      'overlong caption': { ...layer, caption: long(4001) },
    },
  },

  projectSave: {
    valid: { name: 'Project', canvases: [] },
    accepts: {
      'with a canvas': { name: 'Project', canvases: [canvas], selectedCanvasId: 'c1', page: 1 },
      'last page': { name: 'Project', canvases: [], page: 9999 },
      'result canvas with every field': {
        name: 'Project',
        canvases: [
          {
            ...canvas,
            kind: 'result',
            x: -100000,
            y: 100000,
            width: 64,
            height: 4096,
            sourceCanvasId: 'c0',
            jobId: 'j1',
            jobState: 'running',
            progress: { stage: 'denoise', current: 1, total: 20, percent: 5 },
            outputs: [{ path: '/o.png', width: 1024, height: 1024, seed: 1 }],
            error: { code: 'E', message: 'boom' },
            adapters: [{ id: 'a', strength: 2 }],
          },
        ],
      },
      'a control image linked before an adapter is picked': {
        name: 'Project',
        canvases: [{ ...canvas, inputs: { control: { adapterId: '', images: [{ kind: 'depth', link: { canvasId: 'x' }, strength: 1, start: 0, end: 1 }] } } }],
      },
      'image canvas and a layout with every input': {
        name: 'Project',
        canvases: [
          { ...canvas, id: 'img', kind: 'image', imagePath: '/p/assets/a.png', imageSize: { width: 6000, height: 4000 } },
          {
            ...canvas,
            inputs: {
              init: { link: { canvasId: 'img' }, strength: 0.6, resize: 'fit' },
              mask: { path: '/p/assets/mask-c1-x.png' },
              control: { adapterId: 'control-1', loraStrength: 1, images: [{ kind: 'depth', link: { canvasId: 'img', output: 1 }, strength: 1, start: 0, end: 1 }] },
              references: { links: [{ canvasId: 'img' }], maxEdge: 1024 },
            },
            baseSize: { width: 1024, height: 1024 },
            sampling: { sampler: 'euler', scheduler: 'karras', shift: 3, hires: { width: 1536, height: 1536, steps: 10, strength: 0.4 }, stepCache: 'fbcache', cfgTruncation: 0.5 },
          },
        ],
      },
    },
    rejects: {
      'empty name': { name: '', canvases: [] },
      'page 0': { name: 'P', canvases: [], page: 0 },
      'page 10000': { name: 'P', canvases: [], page: 10000 },
      'canvas too small': { name: 'P', canvases: [{ ...canvas, width: 63 }] },
      'canvas too large': { name: 'P', canvases: [{ ...canvas, height: 4097 }] },
      'canvas off the board': { name: 'P', canvases: [{ ...canvas, x: 100001 }] },
      'fractional position': { name: 'P', canvases: [{ ...canvas, y: 0.5 }] },
      'steps 0': { name: 'P', canvases: [{ ...canvas, steps: 0 }] },
      'cfg above 20': { name: 'P', canvases: [{ ...canvas, cfg: 20.5 }] },
      'unknown job state': { name: 'P', canvases: [{ ...canvas, jobState: 'idle' }] },
      'unknown summary canvas': { name: 'P', canvases: [{ ...canvas, summary: { ...canvas.summary, canvas: 'grid' } }] },
      '17 adapters': { name: 'P', canvases: [{ ...canvas, adapters: Array.from({ length: 17 }, (_, i) => ({ id: `a${i}`, strength: 1 })) }] },
      'adapter strength above 2': { name: 'P', canvases: [{ ...canvas, adapters: [{ id: 'a', strength: 2.5 }] }] },
      'invalid layer': { name: 'P', canvases: [{ ...canvas, layers: [{ ...layer, opacity: 2 }] }] },
      'empty device uuid': { name: 'P', canvases: [{ ...canvas, deviceUuid: '' }] },
      'unknown canvas kind': { name: 'P', canvases: [{ ...canvas, kind: 'mask' }] },
      'five reference links': { name: 'P', canvases: [{ ...canvas, inputs: { references: { links: Array.from({ length: 5 }, () => ({ canvasId: 'x' })) } } }] },
      'init strength above 1': { name: 'P', canvases: [{ ...canvas, inputs: { init: { link: { canvasId: 'x' }, strength: 1.5 } } }] },
      'fractional image size': { name: 'P', canvases: [{ ...canvas, kind: 'image', imageSize: { width: 10.5, height: 10 } }] },
      'base size too small': { name: 'P', canvases: [{ ...canvas, baseSize: { width: 32, height: 1024 } }] },
      'hires not a multiple of 16': { name: 'P', canvases: [{ ...canvas, sampling: { hires: { width: 1000, height: 1024 } } }] },
    },
  },

  caseSave: {
    valid: { instanceId: 'i1', workspace: 'clover', deviceId: 'cuda:0', profile: 'dmd8' },
    rejects: {
      'other workspace': { instanceId: 'i1', workspace: 'other', deviceId: 'cuda:0', profile: 'base' },
      'empty device': { instanceId: 'i1', workspace: 'clover', deviceId: '', profile: 'base' },
      'unknown profile': { instanceId: 'i1', workspace: 'clover', deviceId: 'cuda:0', profile: 'turbo' },
    },
  },

  caseRemove: { valid: { id: 'c1' }, rejects: { 'empty id': { id: '' }, 'overlong id': { id: long(81) } } },

  sshTerminalOpen: { valid: { hostId: 'h1' }, rejects: { 'empty host': { hostId: '' } } },

  sshTerminalInput: {
    valid: { id: 't1', data: '' },
    accepts: { 'largest chunk': { id: 't1', data: long(65536) } },
    rejects: { 'overlong chunk': { id: 't1', data: long(65537) }, 'missing data': { id: 't1' } },
  },

  sshTerminalClose: { valid: { id: 't1' }, rejects: { 'empty id': { id: '' } } },

  jobStart: {
    valid: job,
    output: { ...job, negativePrompt: '', profile: 'base', mode: 'runner' },
    accepts: {
      'size bounds': { ...job, width: 256, height: 2048 },
      'seed bounds': { ...job, seed: 4294967295 },
      'steps 100 and cfg 20': { ...job, steps: 100, cfg: 20 },
      'every option': { ...job, profile: 'dmd8', mode: 'simulate', workspace: 'clover', kind: 'training', caseId: 'c', caseName: 'n', deviceId: 'd' },
    },
    rejects: {
      'width not multiple of 16': { ...job, width: 520 },
      'width below 256': { ...job, width: 240 },
      'height above 2048': { ...job, height: 2064 },
      'steps 0': { ...job, steps: 0 },
      'steps 101': { ...job, steps: 101 },
      'cfg above 20': { ...job, cfg: 20.01 },
      'negative seed': { ...job, seed: -1 },
      'seed above uint32': { ...job, seed: 4294967296 },
      'fractional seed': { ...job, seed: 1.5 },
      'overlong prompt': { ...job, prompt: long(32769) },
      'overlong negative prompt': { ...job, negativePrompt: long(8193) },
      'unknown mode': { ...job, mode: 'cloud' },
      'other workspace': { ...job, workspace: 'comfy' },
    },
  },

  jobId: { valid: { id: 'j1' }, rejects: { 'empty id': { id: '' } } },

  engineFeatures: {
    valid: {},
    accepts: { 'a gpu': { deviceUuid: 'GPU-1' }, 'a host': { hostId: 'h1' } },
    rejects: { 'empty gpu': { deviceUuid: '' }, 'overlong host': { hostId: long(81) } },
  },

  studioImportImage: {
    valid: { projectId: 'project-1', path: '/pics/a.png' },
    accepts: { bytes: { projectId: 'project-1', bytes: new Uint8Array([1, 2]) } },
    rejects: {
      'traversal project id': { projectId: '..', path: '/pics/a.png' },
      'neither path nor bytes': { projectId: 'project-1' },
      'both path and bytes': { projectId: 'project-1', path: '/a.png', bytes: new Uint8Array([1]) },
      'bytes as an array': { projectId: 'project-1', bytes: [1, 2] },
    },
  },

  studioSaveMask: {
    valid: { projectId: 'project-1', canvasId: 'c1', png: new Uint8Array([137, 80]) },
    rejects: {
      'bad project id': { projectId: 'a/b', canvasId: 'c1', png: new Uint8Array([1]) },
      'empty canvas id': { projectId: 'p', canvasId: '', png: new Uint8Array([1]) },
      'png as base64': { projectId: 'p', canvasId: 'c1', png: 'iVBOR' },
    },
  },

  controlAdapterAdd: { valid: { path: '/m/control.safetensors' }, rejects: { 'blank path': { path: ' ' } } },

  controlAdapterRemove: { valid: { id: 'control-1' }, rejects: { 'empty id': { id: '' } } },

  jobInput: {
    valid: { id: 'j1', text: 'y' },
    rejects: { 'overlong text': { id: 'j1', text: long(4097) }, 'missing text': { id: 'j1' } },
  },

  diagnosticsDismiss: { valid: { id: 'd1' }, rejects: { 'empty id': { id: '' } } },

  galleryList: {
    valid: {},
    output: { limit: 48 },
    accepts: {
      'every option': { cursor: long(32), limit: 120, query: 'cat', root: '/g', projectId: 'p1', since: 0 },
    },
    rejects: {
      'empty projectId': { projectId: '' },
      'negative since': { since: -1 },
      'fractional since': { since: 1.5 },
      'overlong cursor': { cursor: long(33) },
      'limit 0': { limit: 0 },
      'limit 121': { limit: 121 },
      'overlong query': { query: long(201) },
    },
  },

  galleryItem: { valid: { path: ' /g/a.png ' }, output: { path: '/g/a.png' }, rejects: { 'blank path': { path: ' ' } } },
  galleryReveal: { valid: { path: '/g/a.png' }, rejects: { 'blank path': { path: '' } } },
  galleryTrash: { valid: { path: ' /g/a.png ' }, output: { path: '/g/a.png' }, rejects: { 'blank path': { path: ' ' }, 'missing path': {} } },

  pickImages: {
    valid: {},
    accepts: { title: { title: 'Pick' } },
    rejects: { 'overlong title': { title: long(121) } },
  },

  pickDialog: {
    valid: {},
    output: { kind: 'folder' },
    accepts: { file: { kind: 'file', title: 'Pick' } },
    rejects: { 'unknown kind': { kind: 'drive' } },
  },

  openPath: { valid: { path: '\t/home/user\n' }, output: { path: '/home/user' }, rejects: { 'blank path': { path: '\n' } } },

  openExternal: {
    valid: { url: 'https://example.com' },
    accepts: { http: { url: 'http://localhost:8080/x' } },
    rejects: {
      javascript: { url: 'javascript:alert(1)' },
      file: { url: 'file:///etc/passwd' },
      mailto: { url: 'mailto:someone@example.com' },
      'too short': { url: 'http://' },
      'overlong url': { url: `https://${long(2041)}` },
      'uppercase scheme': { url: 'HTTPS://example.com' },
    },
  },
} satisfies Record<keyof Schemas, SchemaCase>

const schemaFor = (name: keyof Schemas) => schemas[name] as unknown as z.ZodType

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const STRICT = new Set<keyof Schemas>(['engineSystemCuda', 'mossInferCudaLibs'])

describe('schemas table', () => {
  it('covers every exported schema', () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(schemas).sort())
  })
})

for (const [name, spec] of Object.entries(cases) as Array<[keyof Schemas, SchemaCase]>) {
  describe(`schemas.${name}`, () => {
    const schema = schemaFor(name)

    it('parses the minimal valid input', () => {
      const parsed = schema.safeParse(spec.valid)
      expect(parsed.error?.issues).toBeUndefined()
      expect(parsed.data).toEqual('output' in spec ? spec.output : spec.valid)
    })

    for (const [label, input] of Object.entries(spec.accepts ?? {})) {
      it(`accepts ${label}`, () => {
        expect(schema.safeParse(input).error?.issues).toBeUndefined()
      })
    }

    for (const [label, input] of Object.entries(spec.rejects)) {
      it(`rejects ${label}`, () => {
        const parsed = schema.safeParse(input)
        expect(parsed.success).toBe(false)
        expect(parsed.error?.issues.length).toBeGreaterThan(0)
      })
    }

    const base = spec.valid
    if (isPlainObject(base)) {
      if (STRICT.has(name)) {
        it('rejects unknown keys', () => {
          const parsed = schema.safeParse({ ...base, unexpected: 1 })
          expect(parsed.error?.issues[0]?.code).toBe('unrecognized_keys')
        })
      } else {
        it('strips unknown keys', () => {
          const parsed = schema.safeParse({ ...base, unexpected: 1 })
          expect(parsed.success).toBe(true)
          expect(parsed.data).not.toHaveProperty('unexpected')
        })
      }
    }
  })
}

describe('settingsUpdate field rules', () => {
  const parse = (input: unknown) => schemas.settingsUpdate.safeParse(input)

  it('trims an HF endpoint and allows clearing it', () => {
    expect(parse({ hfEndpoint: '  https://hf-mirror.com  ' }).data).toEqual({ hfEndpoint: 'https://hf-mirror.com' })
    expect(parse({ hfEndpoint: '' }).data).toEqual({ hfEndpoint: '' })
    expect(parse({ hfEndpoint: '   ' }).data).toEqual({ hfEndpoint: '' })
    expect(parse({ hfEndpoint: 'http://10.0.0.1:8080/hf/' }).success).toBe(true)
  })

  it.each([
    ['non-http scheme', 'ftp://hf-mirror.com'],
    ['credentials', 'https://user:pass@hf-mirror.com'],
    ['username only', 'https://user@hf-mirror.com'],
    ['query string', 'https://hf-mirror.com/?x=1'],
    ['fragment', 'https://hf-mirror.com/#x'],
    ['not a url', 'hf-mirror.com'],
  ])('rejects an HF endpoint with %s and explains why', (_label, value) => {
    const parsed = parse({ hfEndpoint: value })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('请输入有效的 HTTP/HTTPS HF 地址')
    expect(parsed.error?.issues[0]?.path).toEqual(['hfEndpoint'])
  })

  it('rejects an HF token with line breaks or NUL', () => {
    expect(parse({ hfToken: ' hf_abc ' }).data).toEqual({ hfToken: 'hf_abc' })
    for (const bad of ['hf_\nabc', 'hf_\rabc', 'hf_\0abc']) {
      expect(parse({ hfToken: bad }).error?.issues[0]?.message).toBe('Token 不能包含换行或 NUL')
    }
    expect(parse({ hfToken: long(2049) }).success).toBe(false)
  })

  it('does not apply defaults on a partial update', () => {
    expect(parse({ theme: 'light' }).data).toEqual({ theme: 'light' })
  })

  it('validates the per-GPU override map', () => {
    expect(parse({ gpuProfileOverrides: { [long(200)]: { memoryMode: 'max_speed' } } }).success).toBe(true)
    expect(parse({ gpuProfileOverrides: { [long(201)]: {} } }).success).toBe(false)
    expect(parse({ gpuProfileOverrides: { g: { memoryMode: 'huge' } } }).success).toBe(false)
  })
})

describe('host download proxy rules', () => {
  const parse = (downloadProxy: string) => schemas.hostSave.safeParse({ ...host, downloadProxy })

  it.each([
    'http://127.0.0.1:7890',
    'https://proxy.example.com',
    'socks4://10.0.0.1:1080',
    'socks4a://10.0.0.1:1080',
    'socks5://user:pass@10.0.0.1:1080',
    'socks5h://10.0.0.1:1080/',
    '',
  ])('accepts %s', (value) => {
    expect(parse(value).success).toBe(true)
  })

  it('trims the proxy', () => {
    expect(parse('  http://127.0.0.1:7890  ').data?.downloadProxy).toBe('http://127.0.0.1:7890')
  })

  it.each([
    ['ftp scheme', 'ftp://proxy.example.com'],
    ['a path', 'http://proxy.example.com/pac'],
    ['a query', 'http://proxy.example.com/?a=1'],
    ['a fragment', 'http://proxy.example.com/#a'],
    ['no host', 'socks5://'],
    ['not a url', '127.0.0.1:7890'],
  ])('rejects a proxy with %s', (_label, value) => {
    const parsed = parse(value)
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('代理需使用 HTTP/HTTPS/SOCKS4/SOCKS4a/SOCKS5/SOCKS5h 地址')
  })
})

describe('refinement messages', () => {
  it('explains a gbcRun without images', () => {
    expect(schemas.gbcRun.safeParse({ providerId: 'p1' }).error?.issues[0]?.message).toBe('需要选择图片目录或图片文件')
  })

  it('explains an aiChat without a message', () => {
    expect(schemas.aiChat.safeParse({ providerId: 'p1' }).error?.issues[0]?.message).toBe('需要消息或重新生成标记')
  })

  it('explains a blank path', () => {
    expect(schemas.openPath.safeParse({ path: '  ' }).error?.issues[0]?.message).toBe('目录路径不能为空')
  })

  it('explains a host password with a line break', () => {
    expect(schemas.hostSave.safeParse({ ...host, password: 'a\nb' }).error?.issues[0]?.message).toBe('密码不能包含换行或 NUL')
  })
})

describe('defaults do not override explicit values', () => {
  it('keeps explicit jobStart options', () => {
    expect(schemas.jobStart.parse({ ...job, negativePrompt: 'blurry', profile: 'dmd8', mode: 'simulate' })).toMatchObject({
      negativePrompt: 'blurry',
      profile: 'dmd8',
      mode: 'simulate',
    })
  })

  it('keeps explicit limits and kinds', () => {
    expect(schemas.gitCommits.parse({ branch: 'main', limit: 5 }).limit).toBe(5)
    expect(schemas.galleryList.parse({ limit: 1 }).limit).toBe(1)
    expect(schemas.gbcThumbnails.parse({ paths: [], width: 32 }).width).toBe(32)
    expect(schemas.pickDialog.parse({ kind: 'image' }).kind).toBe('image')
    expect(schemas.instanceCreate.parse({ branch: 'main', commit: 'abcdef0', runtimeMode: 'isolated' }).runtimeMode).toBe('isolated')
  })

  it('leaves gbcCommits limit unset when omitted', () => {
    expect(schemas.gbcCommits.parse({ branch: 'main' })).toEqual({ branch: 'main' })
  })
})

describe('jobInputsSchema paths', () => {
  it('keeps a path exactly as given (no trimming) and refuses a blank one', () => {
    expect(jobInputsSchema.parse({ initImage: { path: ' /a b.png ', strength: 0.5 } }).initImage?.path).toBe(' /a b.png ')
    expect(jobInputsSchema.safeParse({ references: { paths: ['   '] } }).error?.issues[0]?.message).toBe('图片路径不能为空')
  })
})
