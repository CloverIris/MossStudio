import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeInfo, RuntimeMode, Settings } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { firstLine, run, runStream, tail } from '../lib/run'
import { pythonVersion } from '../lib/python'
import { getLastNetwork } from './network'

export const MOSS_DEPS = ['torch>=2.9', 'diffusers>=0.38', 'transformers>=5.3', 'accelerate>=1.10', 'safetensors>=0.6', 'Pillow>=10']

type Logger = (line: string, stream?: 'stdout' | 'stderr') => void

function logFor(runtimeId: string, instanceId: string, logger?: Logger): Logger {
  return (line, stream = 'stdout') => {
    logger?.(line, stream)
    emit(Events.runtimeLog, { runtimeId, instanceId, line, stream, at: new Date().toISOString() })
  }
}

export function venvPython(dir: string): string {
  return process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python3')
}

export function depsFile(runtimeId: string): string {
  return join(paths.runtime(runtimeId), 'runtime.json')
}

export async function readRuntime(runtimeId: string): Promise<RuntimeInfo | null> {
  try {
    return JSON.parse(await readFile(depsFile(runtimeId), 'utf8')) as RuntimeInfo
  } catch {
    return null
  }
}

async function writeRuntime(runtime: RuntimeInfo): Promise<void> {
  await mkdir(paths.runtime(runtime.id), { recursive: true })
  await writeFile(depsFile(runtime.id), JSON.stringify(runtime, null, 2), 'utf8')
}

/** Persist the local shadow record for a remote venv (state/path live remotely). */
export async function writeRemoteRuntime(runtime: RuntimeInfo): Promise<void> {
  await writeRuntime(runtime)
}

export async function listRuntimes(): Promise<RuntimeInfo[]> {
  try {
    const entries = await readdir(paths.runtimes(), { withFileTypes: true })
    const out: RuntimeInfo[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'python') continue
      const runtime = await readRuntime(entry.name)
      if (runtime) out.push(runtime)
    }
    return out
  } catch {
    return []
  }
}

async function which(name: string): Promise<string | null> {
  const result = await run(process.platform === 'win32' ? 'where' : 'which', [name], { timeoutMs: 3000 })
  return result.code === 0 ? firstLine(result.stdout) || null : null
}

export async function pickPython(settings: Settings): Promise<{ path: string; version: string }> {
  if (settings.pythonPath) {
    const version = await pythonVersion(settings.pythonPath)
    if (version) return { path: settings.pythonPath, version }
  }
  // Windows' `py` launcher can point at an interpreter that is not on PATH.
  if (process.platform === 'win32') {
    const py = await which('py')
    if (py) {
      const located = await run(py, ['-3', '-c', 'import sys;print(sys.executable)'], { timeoutMs: 5000 })
      const path = firstLine(located.stdout)
      const version = path ? await pythonVersion(path) : null
      if (version) return { path, version }
    }
  }
  const names = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python']
  for (const name of names) {
    const path = await which(name)
    if (!path) continue
    const version = await pythonVersion(path)
    if (version) return { path, version }
  }
  if (process.platform === 'win32') {
    const roots = [
      process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Programs', 'Python') : '',
      process.env['ProgramFiles'] ? join(process.env['ProgramFiles'], 'Python') : '',
      'C:\\Python312',
      'C:\\Python311',
      'C:\\Python310',
    ].filter(Boolean)
    for (const root of roots) {
      const candidates = [root]
      try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (entry.isDirectory() && /^Python3\d+$/.test(entry.name)) candidates.push(join(root, entry.name))
        }
      } catch {
        // root does not exist
      }
      for (const candidate of candidates) {
        const path = join(candidate, 'python.exe')
        const version = await pythonVersion(path)
        if (version) return { path, version }
      }
    }
  }
  throw new Error('未找到 Python 3.10+。可在设置中指定解释器，或稍后安装受管 Python。')
}

export function parseDepsFromPyproject(instanceDir: string): string[] {
  let deps = [...MOSS_DEPS]
  try {
    const text = readFileSync(join(instanceDir, 'pyproject.toml'), 'utf8')
    const project = text.match(/\[project\][\s\S]*?(?=\n\[|$)/)
    if (project) {
      const declared = project[0].match(/dependencies\s*=\s*\[([\s\S]*?)\]/)
      if (declared) {
        const list = [...declared[1]!.matchAll(/["']([^"']+)["']/g)]
          .map((match) => match[1]!)
          .filter((dep) => !dep.startsWith('-e') && dep.trim().length > 0)
        if (list.length) deps = list
      }
    }
  } catch {
    // fall through
  }
  return deps
}

function lockHash(pythonVersionText: string, deps: string[], torchIndex: string | null): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ python: pythonVersionText, platform: process.platform, arch: process.arch, deps: [...deps].sort(), torchIndex }),
    )
    .digest('hex')
}

export async function hasUv(): Promise<boolean> {
  return (await which('uv')) !== null
}

async function hasNvidia(): Promise<boolean> {
  const result = await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeoutMs: 5000 })
  return result.code === 0 && Boolean(firstLine(result.stdout))
}

/**
 * PyPI's Windows torch wheel is CPU-only. Select the CUDA wheel index explicitly
 * when the user has an NVIDIA GPU; macOS keeps PyPI wheels for MPS support.
 */
export async function resolveTorchIndex(settings: Settings): Promise<string | null> {
  if (settings.torchIndex?.trim()) return settings.torchIndex.trim().replace(/\/$/, '')
  if (settings.torchBackend === 'cpu') return 'https://download.pytorch.org/whl/cpu'
  if (settings.torchBackend === 'cuda') {
    if (process.platform === 'darwin') throw new Error('macOS 不支持 CUDA PyTorch；请选择 CPU/自动或使用 MPS')
    return 'https://download.pytorch.org/whl/cu128'
  }
  if (process.platform === 'darwin') return null
  return (await hasNvidia()) ? 'https://download.pytorch.org/whl/cu128' : 'https://download.pytorch.org/whl/cpu'
}

async function createVenv(runtime: RuntimeInfo, python: string, logger: Logger): Promise<void> {
  const target = paths.runtime(runtime.id)
  if (existsSync(venvPython(target))) {
    logger(`复用已有虚拟环境：${target}`)
    return
  }
  await mkdir(paths.runtimes(), { recursive: true })
  const env = {
    UV_CACHE_DIR: join(paths.cache(), 'uv'),
    PIP_CACHE_DIR: join(paths.cache(), 'pip'),
  }
  const uv = await hasUv()
  logger(uv ? `使用 uv 创建运行时（Python ${runtime.pythonVersion}）` : `使用 venv 创建运行时（Python ${runtime.pythonVersion}）`)
  const result = uv
    ? await runStream('uv', ['venv', target, '--python', python], { timeoutMs: 180_000, env }, (line, stream) => logger(line, stream))
    : await runStream(python, ['-m', 'venv', target], { timeoutMs: 180_000, env }, (line, stream) => logger(line, stream))
  if (result.code !== 0) throw new Error(`创建虚拟环境失败：${tail(result.stderr)}`)
}

export interface EnsureRuntimeInput {
  instanceId: string
  instanceDir: string
  mode: RuntimeMode
  settings: Settings
  python?: { path: string; version: string }
  logger?: Logger
}

export async function ensureRuntime(input: EnsureRuntimeInput): Promise<RuntimeInfo> {
  const deps = parseDepsFromPyproject(input.instanceDir)
  const python = input.python ?? (await pickPython(input.settings))
  const torchIndex = await resolveTorchIndex(input.settings)
  const lock = lockHash(python.version, deps, torchIndex)

  if (input.mode === 'shared') {
    const existing = (await listRuntimes()).find(
      (runtime) => runtime.kind === 'shared' && runtime.lockHash === lock && runtime.state !== 'error',
    )
    if (existing) {
      if (!existing.instanceIds.includes(input.instanceId)) {
        existing.instanceIds.push(input.instanceId)
        await writeRuntime(existing)
      }
      return existing
    }
  }

  const id =
    input.mode === 'shared'
      ? `py${python.version.replace(/\./g, '')}-${lock.slice(0, 8)}`
      : `py${python.version.replace(/\./g, '')}-${lock.slice(0, 8)}-${randomBytes(3).toString('hex')}`

  const runtime: RuntimeInfo = {
    id,
    instanceId: input.instanceId,
    instanceIds: [input.instanceId],
    path: paths.runtime(id),
    python: python.path,
    pythonVersion: python.version,
    lockHash: lock,
    kind: input.mode,
    state: 'created',
    deps,
    torchIndex,
    createdAt: new Date().toISOString(),
  }

  const logger = logFor(id, input.instanceId, input.logger)
  await createVenv(runtime, python.path, logger)
  await writeRuntime(runtime)
  return runtime
}

export async function installDeps(runtimeId: string, settings: Settings, logger?: Logger, instanceDir?: string): Promise<RuntimeInfo> {
  const runtime = await readRuntime(runtimeId)
  if (!runtime) throw new Error('运行时不存在')
  const loggerForRun = logFor(runtimeId, runtime.instanceId, logger)

  const source = instanceDir ?? paths.instance(runtime.instanceId)
  runtime.deps = existsSync(join(source, 'pyproject.toml')) ? parseDepsFromPyproject(source) : runtime.deps
  const torchIndex = await resolveTorchIndex(settings)
  runtime.torchIndex = torchIndex
  runtime.lockHash = lockHash(runtime.pythonVersion, runtime.deps, torchIndex)
  runtime.state = 'installing'
  await writeRuntime(runtime)

  const index = settings.pipIndex ?? getLastNetwork()?.selected.pip ?? 'https://pypi.org/simple'
  const python = venvPython(paths.runtime(runtimeId))
  const env = {
    PIP_CACHE_DIR: join(paths.cache(), 'pip'),
    UV_CACHE_DIR: join(paths.cache(), 'uv'),
  }

  const uv = await hasUv()
  const torchDep = runtime.deps.find((dep) => /^torch(?:\s|[<>=!~]|$)/.test(dep)) ?? 'torch>=2.9'
  const rest = runtime.deps.filter((dep) => dep !== torchDep)
  loggerForRun(
    torchIndex
      ? `PyTorch 使用 ${torchIndex}（${settings.torchBackend}）`
      : `PyTorch 使用默认 PyPI（${process.platform === 'darwin' ? 'MPS' : 'auto'}）`,
  )
  const install = async (targetIndex: string, deps: string[], extraIndex?: string) =>
    uv
      ? runStream(
          'uv',
          [
            'pip',
            'install',
            '--python',
            python,
            '--index-url',
            targetIndex,
            ...(extraIndex ? ['--extra-index-url', extraIndex, '--index-strategy', 'unsafe-best-match'] : []),
            ...deps,
          ],
          { timeoutMs: 3_600_000, env },
          (line, stream) => loggerForRun(line, stream),
        )
      : runStream(
          python,
          ['-m', 'pip', 'install', '--index-url', targetIndex, ...(extraIndex ? ['--extra-index-url', extraIndex] : []), ...deps],
          { timeoutMs: 3_600_000, env },
          (line, stream) => loggerForRun(line, stream),
        )

  let result
  if (!uv) {
    const upgrade = await runStream(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], { timeoutMs: 300_000, env }, (line, stream) =>
      loggerForRun(line, stream),
    )
    if (upgrade.code !== 0) loggerForRun('升级 pip 失败，继续尝试安装', 'stderr')
  }
  if (torchIndex) {
    result = await install(torchIndex, [torchDep], index)
    if (result.code !== 0) {
      runtime.state = 'error'
      await writeRuntime(runtime)
      throw new Error(`PyTorch 安装失败（${torchIndex}）：${tail(result.stderr || result.stdout)}`)
    }
    result = rest.length ? await install(index, rest) : { code: 0, stdout: '', stderr: '', timedOut: false }
  } else {
    result = await install(index, runtime.deps)
  }

  if (result.code !== 0) {
    runtime.state = 'error'
    await writeRuntime(runtime)
    throw new Error(`依赖安装失败：${tail(result.stderr || result.stdout)}`)
  }

  runtime.state = 'ready'
  await writeRuntime(runtime)
  loggerForRun('依赖安装完成')
  return runtime
}

export async function setRuntimeState(runtimeId: string, state: RuntimeInfo['state']): Promise<void> {
  const runtime = await readRuntime(runtimeId)
  if (!runtime) return
  runtime.state = state
  await writeRuntime(runtime)
}
