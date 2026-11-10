import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOptions, RunResult } from '@main/lib/run'
import type { GbcGraph, GbcParseProgress } from '@shared/gbc'
import { useTempDir } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

const root = useTempDir('gbc-run-')

type Behaviour = (args: string[], options: RunOptions, onLine: (line: string) => void) => Promise<Partial<RunResult>>
const state = {
  settings: settingsFixture({ gbcEnabled: true, gbcDetector: 'sam3' }),
  providers: [
    { id: 'local', name: 'Ollama', kind: 'ollama', baseUrl: '', model: 'llava', temperature: 0.7, hasKey: true },
    {
      id: 'claude',
      name: 'Claude',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet',
      temperature: 0.7,
      hasKey: true,
    },
  ],
  emitted: [] as Array<[string, unknown]>,
  configs: [] as string[],
  behaviour: (async () => ({})) as Behaviour,
}

/** What GBC writes for one picture: the image vertex and one object under it. */
const graph: GbcGraph = {
  vertices: [
    { vertex_id: '', label: 'image', descs: [{ text: 'a cat on a sill', label: 'detail' }] },
    {
      vertex_id: 'cat',
      label: 'entity',
      bbox: { left: 0.2, top: 0.4, right: 0.6, bottom: 0.8 },
      descs: [{ text: 'a sleeping cat', label: 'short' }],
      in_edges: [{ source: '' }],
    },
  ],
}

/** The graphs file the generated machine config names. */
function sinkOf(config: string): string {
  return /"kind": "graphs", "path": "([^"]+)"/.exec(readFileSync(config, 'utf8'))![1]!.replace(/\\\\/g, '\\')
}

const writes =
  (written: GbcGraph | null): Behaviour =>
  async (args) => {
    if (written) writeFileSync(sinkOf(args[1]!), `${JSON.stringify(written)}\n`)
    return {}
  }

vi.mock('@main/lib/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/lib/run')>()),
  // No NVIDIA here: GBC runs on the CPU.
  run: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }),
  runStream: async (_command: string, args: string[], options: RunOptions, onLine: (line: string) => void) => {
    state.configs.push(readFileSync(args[1]!, 'utf8'))
    const result = await state.behaviour(args, options, onLine)
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...result }
  },
}))
vi.mock('@main/lib/paths', () => ({ paths: { root: () => root(), cache: () => root() } }))
vi.mock('@main/lib/events', () => ({ emit: (channel: string, payload: unknown) => state.emitted.push([channel, payload]) }))
vi.mock('@main/services/settings', () => ({ getSettings: () => state.settings, updateSettings: vi.fn() }))
vi.mock('@main/services/ai', () => ({
  listProviders: () => state.providers,
  getProviderSecret: (id: string) => {
    const provider = state.providers.find((item) => item.id === id)
    return provider ? { kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model, apiKey: 'sk-test' } : null
  },
}))
vi.mock('@main/services/gbcGit', () => ({ listGbcVersions: async () => [], listGbcBranches: vi.fn(), createGbcVersion: vi.fn() }))
vi.mock('@main/services/runtimes', () => ({ pickPython: vi.fn(), resolveTorchIndex: vi.fn() }))

const load = () => import('@main/services/gbc')
const picture = (): string => {
  const path = `${root()}/cat.png`
  writeFileSync(path, 'png')
  return path
}
const progress = (): GbcParseProgress[] =>
  state.emitted.filter(([channel]) => channel === 'event:gbc-parse').map(([, payload]) => payload as GbcParseProgress)

beforeEach(() => {
  vi.resetModules()
  state.settings = settingsFixture({ gbcEnabled: true, gbcDetector: 'sam3' })
  state.emitted = []
  state.configs = []
  state.behaviour = writes(graph)
})

describe('拆成区域', () => {
  it('reads one picture into a description and regions, with the chosen detector and the first model that can read pictures', async () => {
    const { parseRegions } = await load()
    expect(await parseRegions('run-1', picture())).toEqual({
      summary: 'a cat on a sill',
      regions: [{ caption: 'a sleeping cat', bbox: { x: 0.2, y: 0.4, w: expect.closeTo(0.4), h: expect.closeTo(0.4) } }],
    })
    const config = state.configs[0]!
    expect(config).toContain('"protocol": "anthropic"')
    expect(config).toContain('"model": "claude-sonnet"')
    expect(config).toContain('"model": "facebook/sam3"')
    expect(config).toContain('"devices": ["cpu"]')
    // The key goes to the process environment, never into the config file.
    expect(config).not.toContain('sk-test')
  })

  it('uses the model 设置 chose', async () => {
    state.providers.push({
      id: 'gpt',
      name: 'GPT',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-x',
      temperature: 1,
      hasKey: true,
    })
    state.settings = settingsFixture({ gbcEnabled: true, gbcProviderId: 'gpt' })
    const { parseRegions } = await load()
    await parseRegions('run-1', picture())
    expect(state.configs[0]).toContain('"model": "gpt-x"')
    expect(state.configs[0]).toContain('"model": "google/owlv2-base-patch16-ensemble"')
    state.providers.pop()
  })

  it('removes the run folder once the graph is read', async () => {
    let folder = ''
    state.behaviour = async (args, options, onLine) => {
      folder = dirname(args[1]!)
      return writes(graph)(args, options, onLine)
    }
    const { parseRegions } = await load()
    await parseRegions('run-1', picture())
    await vi.waitFor(() => expect(existsSync(folder)).toBe(false))
  })

  it('tells the card when the first run downloads models, then that it reads', async () => {
    state.behaviour = async (args, options, onLine) => {
      onLine('model.safetensors:  10%|#         | 62M/620M')
      onLine('model.safetensors:  10%|#         | 63M/620M')
      onLine('model.safetensors:  55%|#####     | 341M/620M')
      onLine('loading weights')
      return writes(graph)(args, options, onLine)
    }
    const { parseRegions } = await load()
    await parseRegions('run-1', picture())
    // The same step twice is sent once, and a log line right after a download bar does not flip it back.
    expect(progress()).toEqual([
      { runId: 'run-1', phase: 'reading' },
      { runId: 'run-1', phase: 'download', percent: 10 },
      { runId: 'run-1', phase: 'download', percent: 55 },
    ])
  })

  it('resolves to null when 停止 ends the run', async () => {
    state.behaviour = (_args, options) =>
      new Promise((resolve) => options.signal!.addEventListener('abort', () => resolve({ code: -1, aborted: true })))
    const { cancelParse, parseRegions } = await load()
    const pending = parseRegions('run-1', picture())
    await vi.waitFor(() => expect(state.configs).toHaveLength(1))
    cancelParse('run-1')
    expect(await pending).toBeNull()
  })

  it('ends every run when the app quits', async () => {
    state.behaviour = (_args, options) =>
      new Promise((resolve) => options.signal!.addEventListener('abort', () => resolve({ code: -1, aborted: true })))
    const { parseRegions, stopGbcProcesses } = await load()
    const pending = parseRegions('run-1', picture())
    await vi.waitFor(() => expect(state.configs).toHaveLength(1))
    stopGbcProcesses()
    expect(await pending).toBeNull()
  })

  it('says why it cannot read', async () => {
    const { parseRegions } = await load()
    await expect(parseRegions('run-1', `${root()}/gone.png`)).rejects.toThrow('找不到这张图片')
    state.behaviour = writes({ vertices: [{ vertex_id: '', label: 'image', descs: [] }] })
    await expect(parseRegions('run-2', picture())).rejects.toThrow('没在这张图里找到物体')
    state.behaviour = async () => ({ code: 1, stderr: 'Traceback\nRuntimeError: CUDA out of memory' })
    await expect(parseRegions('run-3', picture())).rejects.toThrow('CUDA out of memory')
    state.behaviour = async () => ({ code: -1, timedOut: true })
    await expect(parseRegions('run-4', picture())).rejects.toThrow('超过 30 分钟')
    const providers = state.providers
    state.providers = providers.filter((provider) => provider.kind === 'ollama')
    await expect(parseRegions('run-5', picture())).rejects.toThrow('先给助手加一个能用的模型')
    state.providers = providers
  })
})

describe('parseProgressLine', () => {
  it('reads a download percentage from a Hugging Face progress bar', async () => {
    const { parseProgressLine } = await load()
    expect(parseProgressLine('model.safetensors:  42%|████▏     | 260M/620M [00:12<00:17]')).toEqual({ phase: 'download', percent: 42 })
    expect(parseProgressLine('Downloading (…)okenizer.json')).toEqual({ phase: 'download' })
    expect(parseProgressLine('vlm  12%|█  | 3/25')).toBeNull()
    expect(parseProgressLine('admitted 1 job')).toBeNull()
  })
})
