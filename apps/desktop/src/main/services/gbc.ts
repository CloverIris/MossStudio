import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Events } from '@shared/channels'
import {
  gbcCanUse,
  regionsFromGraph,
  type GbcCheck,
  type GbcGraph,
  type GbcParseProgress,
  type GbcParseResult,
  type GbcRunInput,
  type GbcRunResult,
  type GbcSetupProgress,
  type GbcStatus,
} from '@shared/gbc'
import type { Settings } from '@shared/types'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { firstLine, run, runStream, tail } from '../lib/run'
import { getProviderSecret, listProviders } from './ai'
import { createGbcVersion, listGbcBranches, listGbcVersions } from './gbcGit'
import { pickPython, resolveTorchIndex } from './runtimes'
import { getSettings, updateSettings } from './settings'

function detectorModel(detector: GbcRunInput['detector']): string {
  return detector === 'sam3' ? 'facebook/sam3' : 'google/owlv2-base-patch16-ensemble'
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
function isImage(path: string): boolean {
  return IMAGE_EXT.has(path.slice(path.lastIndexOf('.')).toLowerCase())
}

export async function listGbcImages(folder: string): Promise<{ path: string; images: Array<{ path: string; name: string }> }> {
  if (!folder.trim() || !existsSync(folder)) throw new Error('图片目录不存在')
  const files: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile() && isImage(path)) files.push(path)
    }
  }
  await walk(folder, 0)
  files.sort((a, b) => a.localeCompare(b))
  return { path: folder, images: files.map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? path })) }
}

export type { GbcCheck, GbcStatus } from '@shared/gbc'

function versionBinary(version: { path: string }): string {
  return process.platform === 'win32' ? join(version.path, '.venv', 'Scripts', 'gbc.exe') : join(version.path, '.venv', 'bin', 'gbc')
}
function versionPython(version: { path: string }): string {
  return process.platform === 'win32' ? join(version.path, '.venv', 'Scripts', 'python.exe') : join(version.path, '.venv', 'bin', 'python')
}

/** KohakuGBC's pyproject: `requires-python = ">=3.11"`. */
const MIN_PYTHON_MINOR = 11

/** Every GBC process this app started: 停止 and quitting end them. */
const owned = new Set<AbortController>()
/** 拆成区域 runs by the id the renderer gave them, for 停止. */
const parses = new Map<string, AbortController>()
let setup: Promise<GbcStatus> | null = null

function ownedController(): AbortController {
  const controller = new AbortController()
  owned.add(controller)
  return controller
}

/** Quitting ends every GBC run and install still going. */
export function stopGbcProcesses(): void {
  for (const controller of owned) controller.abort()
  owned.clear()
  parses.clear()
}

/** The checks spawn Python and import torch, which takes seconds; they are kept until something changes. */
const statusCache = new Map<string, Promise<GbcStatus>>()

export function forgetGbcStatus(): void {
  statusCache.clear()
}

/**
 * Whether GBC can run. `versionId` defaults to the version 设置 › 功能 uses;
 * `fresh` checks again instead of answering from the last check.
 */
export function gbcStatus(versionId?: string, fresh = false): Promise<GbcStatus> {
  const id = versionId ?? getSettings().gbcVersionId ?? ''
  const cached = statusCache.get(id)
  if (cached && !fresh) return cached
  const next = checkGbc(id || undefined)
  statusCache.set(id, next)
  next.catch(() => statusCache.delete(id))
  return next
}

async function checkGbc(versionId?: string): Promise<GbcStatus> {
  const settings = getSettings()
  const version = versionId ? (await listGbcVersions(settings)).find((item) => item.id === versionId) : null
  const bundled = version ? versionBinary(version) : ''
  const venvPython = version ? versionPython(version) : ''
  const external = process.env['CLOVER_GBC_BIN'] || 'gbc'
  const binary = bundled && existsSync(bundled) ? bundled : external
  const checks: GbcCheck[] = []
  const add = (id: string, label: string, ok: boolean, detail: string): void => {
    checks.push({ id, label, ok, detail })
  }

  add('clone', 'GBC 版本/代码', Boolean(version) || Boolean(process.env['CLOVER_GBC_BIN']), version ? version.path : '未选择克隆版本')
  const help = await run(binary, ['--help'], { timeoutMs: 8000 })
  add(
    'binary',
    'gbc 可执行文件',
    help.code === 0,
    help.code === 0 ? firstLine(help.stdout).slice(0, 160) : (help.stderr || help.stdout).trim().slice(-300) || `exit ${help.code}`,
  )
  const python = venvPython && existsSync(venvPython) ? venvPython : settings.pythonPath || 'python3'
  const py = await run(python, ['--version'], { timeoutMs: 8000 })
  add('python', 'Python 环境', py.code === 0, (py.stdout || py.stderr).trim() || '未找到 Python')
  const imports = await run(
    python,
    ['-c', 'import torch, transformers, kohakugbc; print("torch", torch.__version__); print("transformers", transformers.__version__)'],
    { timeoutMs: 15_000 },
  )
  add(
    'deps',
    'torch / transformers / kohakugbc',
    imports.code === 0,
    imports.code === 0 ? imports.stdout.trim().slice(-500) : (imports.stderr || imports.stdout).trim().slice(-500) || '依赖导入失败',
  )
  const gpu = await run('nvidia-smi', ['-L'], { timeoutMs: 5000 })
  add('gpu', 'NVIDIA CUDA', gpu.code === 0, gpu.code === 0 ? firstLine(gpu.stdout) : '未检测到 NVIDIA（GBC 会回退 CPU，较慢）')

  return {
    available: help.code === 0 && imports.code === 0,
    version: version ? `${version.name} · ${version.shortCommit}` : firstLine(help.stdout).slice(0, 120) || undefined,
    error: help.code === 0 && imports.code === 0 ? undefined : 'GBC 尚未安装完整环境；请查看下方检查项并安装环境。',
    python,
    venv: version ? join(version.path, '.venv') : undefined,
    checks,
    versionId: version?.id,
  }
}

/**
 * The Python environment of one version: a venv beside its code, PyTorch from
 * the index the trainer uses (PyPI's Windows wheel is CPU only), then the
 * version itself with its torch extra. KohakuGBC is not on PyPI, so it is
 * always installed from its code.
 */
export async function installGbcEnv(versionId: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string; status: GbcStatus }> {
  const settings = getSettings()
  const version = (await listGbcVersions(settings)).find((item) => item.id === versionId)
  if (!version) throw new Error('GBC 版本不存在')
  if (!existsSync(join(version.path, 'pyproject.toml'))) throw new Error('这个 GBC 版本缺少 pyproject.toml，无法安装')
  const controller = signal ? null : ownedController()
  const abort = signal ?? controller!.signal
  const venv = join(version.path, '.venv')
  const py = versionPython(version)
  const env = { PIP_CACHE_DIR: join(paths.cache(), 'pip') }
  const lines: string[] = []
  const runStep = async (command: string, args: string[], timeoutMs: number): Promise<void> => {
    lines.push(`$ ${command} ${args.join(' ')}`)
    const result = await runStream(command, args, { cwd: version.path, timeoutMs, env, signal: abort }, (line) => lines.push(line))
    if (result.aborted) throw new Error('安装已停止')
    if (result.code !== 0) throw new Error(`安装步骤失败：${tail(result.stderr || result.stdout, 30)}`)
  }
  try {
    if (!existsSync(py)) {
      const base = await pickPython(settings)
      const minor = Number.parseInt(base.version.split('.')[1] ?? '0', 10)
      if (minor < MIN_PYTHON_MINOR) throw new Error(`看图需要 Python 3.${MIN_PYTHON_MINOR} 或更新版本，现在找到的是 ${base.version}`)
      await runStep(base.path, ['-m', 'venv', venv], 180_000)
    }
    await runStep(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], 300_000)
    const torchIndex = await resolveTorchIndex(settings)
    if (torchIndex) await runStep(py, ['-m', 'pip', 'install', '--index-url', torchIndex, 'torch', 'torchvision'], 60 * 60_000)
    const pipIndex = settings.pipIndex ? ['--index-url', settings.pipIndex] : []
    await runStep(py, ['-m', 'pip', 'install', ...pipIndex, '-e', '.[torch]'], 60 * 60_000)
  } finally {
    if (controller) owned.delete(controller)
    forgetGbcStatus()
  }
  return { ok: true, output: lines.join('\n').slice(-12000), status: await gbcStatus(versionId, true) }
}

function setupProgress(progress: GbcSetupProgress): void {
  emit(Events.gbcSetup, progress)
}

/**
 * 安装 in 设置 › 功能: the version chosen there, or the newest commit of
 * KohakuGBC's default branch when none is, made ready to run. A second click
 * while it runs waits for the same install.
 */
export function installGbc(): Promise<GbcStatus> {
  if (setup) return setup
  const controller = ownedController()
  setup = (async () => {
    try {
      setupProgress({ phase: 'code' })
      const settings = getSettings()
      const versions = await listGbcVersions(settings)
      let version = versions.find((item) => item.id === settings.gbcVersionId)
      if (!version) {
        const branches = await listGbcBranches(settings)
        const branch = branches.find((item) => item.isDefault) ?? branches[0]!
        version = await createGbcVersion(settings, branch.name, branch.sha)
        emit(Events.settingsChanged, updateSettings({ gbcVersionId: version.id }))
      }
      if (controller.signal.aborted) throw new Error('安装已停止')
      setupProgress({ phase: 'packages' })
      const { status } = await installGbcEnv(version.id, controller.signal)
      setupProgress({ phase: 'done' })
      return status
    } catch (error) {
      setupProgress({ phase: 'failed', error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      owned.delete(controller)
      setup = null
    }
  })()
  return setup
}

/** The 助手 model 设置 › 功能 chose, or the first one GBC can use. */
function readingProvider(settings: Settings): string {
  const usable = listProviders().filter(gbcCanUse)
  const chosen = usable.find((provider) => provider.id === settings.gbcProviderId) ?? usable[0]
  if (!chosen) throw new Error('先给助手加一个能用的模型')
  return chosen.id
}

function configFor(
  input: GbcRunInput,
  provider: { kind: string; baseUrl: string; model: string },
  out: string,
  keyEnv: string,
  device: string,
  sourceSpec: Record<string, string>,
): string {
  const protocol = provider.kind === 'anthropic' ? 'anthropic' : 'openai'
  const dtype = device === 'cpu' ? 'float32' : 'float16'
  return `# generated by MossStudio GBC bridge
engines = {
    "vlm": {
        "entry": "api",
        "protocol": ${JSON.stringify(protocol)},
        "flavour": "vllm",
        "model": ${JSON.stringify(provider.model)},
        "endpoints": [{"base_url": ${JSON.stringify(provider.baseUrl)}, "api_key_env": ${JSON.stringify(keyEnv)}, "max_inflight": 16}],
        "timeout_s": 180,
    },
    "detect": {"entry": "torch", "model": ${JSON.stringify(detectorModel(input.detector))}, "dtype": ${JSON.stringify(dtype)}, "devices": [${JSON.stringify(device)}], "max_batch": 4},
    "embed": {"entry": "torch", "devices": [${JSON.stringify(device)}], "max_batch": 16},
    "cpu": {"entry": "python", "workers": 4},
}
machine = {"vlm_waiting": 16, "report": ${JSON.stringify(join(out, 'report'))}}
source = ${JSON.stringify(sourceSpec)}
sink = {"kind": "graphs", "path": ${JSON.stringify(join(out, 'graphs.jsonl'))}}
`
}

/** A run ended by 停止 or by quitting; not an error to show. */
export class GbcStopped extends Error {
  constructor() {
    super('已停止')
  }
}

export interface GbcRunControl {
  signal?: AbortSignal
  /** Every output line, progress bars included (they redraw with a carriage return). */
  onLine?: (line: string) => void
}

export async function runGbc(input: GbcRunInput, control: GbcRunControl = {}): Promise<GbcRunResult> {
  const selectedFiles = (input.files ?? []).filter((path) => path.trim())
  const folder = input.folder?.trim() ?? ''
  if (!selectedFiles.length && (!folder || !existsSync(folder))) throw new Error('GBC 图片目录/文件不存在')
  const provider = getProviderSecret(input.providerId)
  if (!provider) throw new Error('先给助手加一个能用的模型')
  if (!provider.apiKey) throw new Error('看图的模型还没有填 API Key')
  const gpu = (await run('nvidia-smi', ['-L'], { timeoutMs: 5000 })).code === 0
  const device = gpu ? 'cuda:0' : 'cpu'
  const id = `gbc-${randomUUID().slice(0, 8)}`
  const out = join(paths.root(), 'gbc', 'runs', id)
  await mkdir(out, { recursive: true })
  const keyEnv = 'MOSSTUDIO_GBC_API_KEY'
  const sourceMap = new Map<string, string>()
  let sourceSpec: Record<string, string>
  if (selectedFiles.length) {
    for (const path of selectedFiles) sourceMap.set(path.split(/[\\/]/).pop() ?? path, path)
    const sourcePath = join(out, 'source.jsonl')
    await writeFile(
      sourcePath,
      selectedFiles.map((path) => JSON.stringify({ image: path, key: path.split(/[\\/]/).pop() ?? path })).join('\n') + '\n',
      'utf8',
    )
    sourceSpec = { kind: 'jsonl', path: sourcePath }
  } else {
    sourceSpec = { kind: 'folder', path: folder }
  }
  const configPath = join(out, 'machine.py')
  await writeFile(configPath, configFor(input, provider, out, keyEnv, device, sourceSpec), 'utf8')
  const version = input.versionId ? (await listGbcVersions(getSettings())).find((item) => item.id === input.versionId) : null
  const bundled = version ? versionBinary(version) : ''
  const command = bundled && existsSync(bundled) ? bundled : process.env['CLOVER_GBC_BIN'] || 'gbc'
  const controller = ownedController()
  const stop = (): void => controller.abort()
  control.signal?.addEventListener('abort', stop, { once: true })
  if (control.signal?.aborted) stop()
  let result
  try {
    result = await runStream(
      command,
      ['run', configPath],
      {
        cwd: version?.path ?? out,
        env: { [keyEnv]: provider.apiKey, PYTHONUNBUFFERED: '1' },
        timeoutMs: 30 * 60_000,
        signal: controller.signal,
        splitCarriageReturn: true,
      },
      (line) => control.onLine?.(line),
    )
  } finally {
    owned.delete(controller)
    control.signal?.removeEventListener('abort', stop)
  }
  if (result.aborted) throw new GbcStopped()
  const graphsFile = join(out, 'graphs.jsonl')
  if (result.code !== 0) {
    const failures = join(out, 'graphs.failures.jsonl')
    const detail = tail(result.stderr || result.stdout, 20) || (existsSync(failures) ? tail(readFileSync(failures, 'utf8'), 10) : '')
    throw new Error(result.timedOut ? 'GBC 运行超过 30 分钟，已停止' : `GBC 运行失败：${detail || `exit ${result.code}`}`)
  }
  if (!existsSync(graphsFile)) throw new Error('GBC 没有输出 graph')
  const lines = readFileSync(graphsFile, 'utf8').split('\n').filter(Boolean)
  if (!lines.length) {
    const failures = join(out, 'graphs.failures.jsonl')
    throw new Error(`GBC 没有输出 graph${existsSync(failures) ? `：${tail(readFileSync(failures, 'utf8'), 6)}` : ''}`)
  }
  const statsFile = join(out, 'graphs.stats.jsonl')
  const stats = existsSync(statsFile)
    ? readFileSync(statsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { key?: string }
          } catch {
            return {}
          }
        })
    : []
  const images = lines.map((line, index) => {
    const graph = JSON.parse(line) as GbcGraph
    const key = stats[index]?.key ?? selectedFiles[index]?.split(/[\\/]/).pop() ?? `image-${index + 1}`
    const image = graph.vertices?.find((vertex) => vertex.label === 'image')
    const imageVertices = (graph.vertices ?? []).filter((vertex) => vertex.label !== 'image')
    const summary = image?.descs?.[0]?.text ?? ''
    const sourcePath = selectedFiles.length ? (sourceMap.get(key) ?? selectedFiles[index] ?? '') : join(folder, key)
    return {
      key,
      name: key.split(/[\\/]/).pop() ?? key,
      path: sourcePath,
      summary,
      vertices: imageVertices,
      graph,
      graphCount: 1,
    }
  })
  const sidecarFiles: string[] = []
  if (input.sidecarJson || input.sidecarTxt) {
    for (const image of images) {
      if (!image.path || !existsSync(image.path)) continue
      const stem = image.path.replace(/\.[^./\\]+$/, '')
      if (input.sidecarJson) {
        const path = `${stem}.gbcout.json`
        await writeFile(path, JSON.stringify({ image: image.path, key: image.key, graph: image.graph }, null, 2), 'utf8')
        sidecarFiles.push(path)
      }
      if (input.sidecarTxt) {
        const path = `${stem}.gbcout.txt`
        const rows = image.vertices.map(
          (vertex) =>
            `- ${vertex.label ?? 'object'}: ${vertex.descs?.[0]?.text ?? ''}${vertex.bbox ? ` [${vertex.bbox.left.toFixed(3)}, ${vertex.bbox.top.toFixed(3)}, ${vertex.bbox.right.toFixed(3)}, ${vertex.bbox.bottom.toFixed(3)}]` : ''}`,
        )
        await writeFile(path, `${image.name}\n${image.summary}\n\n${rows.join('\n')}\n`, 'utf8')
        sidecarFiles.push(path)
      }
    }
  }
  const vertices = images.flatMap((image) => image.vertices)
  const summary = images[0]?.summary ?? ''
  return {
    id,
    outputDir: out,
    graphCount: images.length,
    vertexCount: images.reduce((count, image) => count + (image.graph?.vertices?.length ?? 0), 0),
    summary,
    vertices,
    images,
    sidecarFiles,
  }
}

/**
 * What a run's output line says about its progress. The first run downloads
 * the detector and embedder from Hugging Face; their progress bars carry a
 * percentage. Anything else means the picture is being read.
 */
export function parseProgressLine(line: string): Omit<GbcParseProgress, 'runId'> | null {
  const percent = /(\d{1,3})%\|/.exec(line)
  if (percent && /\.(safetensors|bin|json|model|txt)|download/i.test(line)) {
    return { phase: 'download', percent: Math.min(100, Number.parseInt(percent[1]!, 10)) }
  }
  if (/download/i.test(line)) return { phase: 'download' }
  return null
}

/** How long after the last download line the card says 正在看图 again. */
const READING_AFTER_MS = 3000

/**
 * 拆成区域: GBC reads one picture with the version, model and detector chosen
 * in 设置 › 功能. Resolves to null when 停止 ended it. Progress goes out as
 * `Events.gbcParse` under the renderer's `runId`.
 */
export async function parseRegions(runId: string, path: string): Promise<GbcParseResult | null> {
  if (!existsSync(path)) throw new Error('找不到这张图片')
  const settings = getSettings()
  const providerId = readingProvider(settings)
  const controller = new AbortController()
  parses.set(runId, controller)
  let last = ''
  let lastDownload = 0
  const report = (progress: Omit<GbcParseProgress, 'runId'>): void => {
    if (progress.phase === 'download') lastDownload = Date.now()
    // Log lines between two download bars must not flip the card back to 正在看图.
    else if (Date.now() - lastDownload < READING_AFTER_MS) return
    const key = `${progress.phase}:${progress.percent ?? ''}`
    if (key === last) return
    last = key
    emit(Events.gbcParse, { runId, ...progress } satisfies GbcParseProgress)
  }
  report({ phase: 'reading' })
  try {
    const result = await runGbc(
      { files: [path], providerId, detector: settings.gbcDetector, versionId: settings.gbcVersionId ?? undefined },
      {
        signal: controller.signal,
        onLine: (line) => {
          const progress = parseProgressLine(line)
          report(progress ?? { phase: 'reading' })
        },
      },
    )
    // Only the graph is needed; the run folder holds the picture's key and a copy of the config.
    void rm(result.outputDir, { recursive: true, force: true }).catch(() => undefined)
    const graph = result.images[0]?.graph
    const parsed = graph ? regionsFromGraph(graph) : { summary: '', regions: [] }
    if (!parsed.regions.length && !parsed.summary) throw new Error('没在这张图里找到物体')
    return parsed
  } catch (error) {
    if (error instanceof GbcStopped) return null
    throw error
  } finally {
    parses.delete(runId)
  }
}

/** 停止 on a 画面 that is still being read. */
export function cancelParse(runId: string): void {
  parses.get(runId)?.abort()
}
