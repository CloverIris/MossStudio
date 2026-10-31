import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GbcCheck, GbcGraph, GbcRunInput, GbcRunResult, GbcStatus, GbcVertex } from '@shared/gbc'
import { paths } from '../lib/paths'
import { firstLine, run, tail } from '../lib/run'
import { getProviderSecret } from './ai'
import { listGbcVersions } from './gbcGit'
import { getSettings } from './settings'

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

export async function gbcStatus(versionId?: string): Promise<GbcStatus> {
  const settings = getSettings()
  const version = versionId ? (await listGbcVersions(settings)).find((item) => item.id === versionId) : null
  const bundled = version ? versionBinary(version) : ''
  const venvPython = version ? versionPython(version) : ''
  const external = process.env['CLOVER_GBC_BIN'] || 'gbc'
  const binary = bundled && existsSync(bundled) ? bundled : external
  const checks: GbcCheck[] = []
  const add = (id: string, label: string, ok: boolean, detail: string): void => { checks.push({ id, label, ok, detail }) }

  add('clone', 'GBC 版本/代码', Boolean(version) || Boolean(process.env['CLOVER_GBC_BIN']), version ? version.path : '未选择克隆版本')
  const help = await run(binary, ['--help'], { timeoutMs: 8000 })
  add('binary', 'gbc 可执行文件', help.code === 0, help.code === 0 ? firstLine(help.stdout).slice(0, 160) : (help.stderr || help.stdout).trim().slice(-300) || `exit ${help.code}`)
  const python = venvPython && existsSync(venvPython) ? venvPython : settings.pythonPath || 'python3'
  const py = await run(python, ['--version'], { timeoutMs: 8000 })
  add('python', 'Python 环境', py.code === 0, (py.stdout || py.stderr).trim() || '未找到 Python')
  const imports = await run(python, ['-c', 'import torch, transformers, kohakugbc; print("torch", torch.__version__); print("transformers", transformers.__version__)'], { timeoutMs: 15_000 })
  add('deps', 'torch / transformers / kohakugbc', imports.code === 0, imports.code === 0 ? imports.stdout.trim().slice(-500) : (imports.stderr || imports.stdout).trim().slice(-500) || '依赖导入失败')
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

export async function installGbcEnv(versionId: string): Promise<{ ok: boolean; output: string; status: GbcStatus }> {
  const settings = getSettings()
  const version = (await listGbcVersions(settings)).find((item) => item.id === versionId)
  if (!version) throw new Error('GBC 版本不存在')
  const base = settings.pythonPath || (process.platform === 'win32' ? 'python' : 'python3')
  const venv = join(version.path, '.venv')
  const py = versionPython(version)
  const lines: string[] = []
  const runStep = async (command: string, args: string[], timeoutMs: number): Promise<void> => {
    const result = await run(command, args, { cwd: version.path, timeoutMs })
    lines.push(`$ ${command} ${args.join(' ')}`)
    if (result.stdout) lines.push(result.stdout.trim())
    if (result.stderr) lines.push(result.stderr.trim())
    if (result.code !== 0) throw new Error(`安装步骤失败：${tail(result.stderr || result.stdout, 30)}`)
  }
  if (!existsSync(py)) await runStep(base, ['-m', 'venv', venv], 180_000)
  await runStep(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], 300_000)
  const local = await run(py, ['-c', 'import pathlib; print(pathlib.Path("pyproject.toml").exists())'], { cwd: version.path, timeoutMs: 5000 })
  if (local.stdout.trim() === 'True') await runStep(py, ['-m', 'pip', 'install', '-e', '.[torch]'], 30 * 60_000)
  else await runStep(py, ['-m', 'pip', 'install', 'kohakugbc[torch]'], 30 * 60_000)
  return { ok: true, output: lines.join('\n').slice(-12000), status: await gbcStatus(versionId) }
}

function configFor(input: GbcRunInput, provider: { kind: string; baseUrl: string; model: string }, out: string, keyEnv: string, device: string, sourceSpec: Record<string, string>): string {
  const protocol = provider.kind === 'anthropic' ? 'anthropic' : 'openai'
  const dtype = device === 'cpu' ? 'float32' : 'float16'
  const outJson = JSON.stringify(out)
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

export async function runGbc(input: GbcRunInput): Promise<GbcRunResult> {
  const selectedFiles = (input.files ?? []).filter((path) => path.trim())
  const folder = input.folder?.trim() ?? ''
  if (!selectedFiles.length && (!folder || !existsSync(folder))) throw new Error('GBC 图片目录/文件不存在')
  const provider = getProviderSecret(input.providerId)
  if (!provider) throw new Error('请先在 Agent 设置中配置一个 AI Provider')
  if (!provider.apiKey) throw new Error('GBC 的 API Provider 需要 API Key')
  const gpu = (await run('nvidia-smi', ['-L'], { timeoutMs: 5000 })).code === 0
  const device = gpu ? 'cuda:0' : 'cpu'
  const id = `gbc-${randomUUID().slice(0, 8)}`
  const out = join(paths.root(), 'gbc', id)
  await mkdir(out, { recursive: true })
  const keyEnv = 'MOSSTUDIO_GBC_API_KEY'
  const sourceMap = new Map<string, string>()
  let sourceSpec: Record<string, string>
  if (selectedFiles.length) {
    for (const path of selectedFiles) sourceMap.set(path.split(/[\\/]/).pop() ?? path, path)
    const sourcePath = join(out, 'source.jsonl')
    await writeFile(sourcePath, selectedFiles.map((path) => JSON.stringify({ image: path, key: path.split(/[\\/]/).pop() ?? path })).join('\n') + '\n', 'utf8')
    sourceSpec = { kind: 'jsonl', path: sourcePath }
  } else {
    sourceSpec = { kind: 'folder', path: folder }
  }
  const configPath = join(out, 'machine.py')
  await writeFile(configPath, configFor(input, provider, out, keyEnv, device, sourceSpec), 'utf8')
  const version = input.versionId ? (await listGbcVersions(getSettings())).find((item) => item.id === input.versionId) : null
  const bundled = version ? versionBinary(version) : ''
  const command = bundled && existsSync(bundled) ? bundled : process.env['CLOVER_GBC_BIN'] || 'gbc'
  const result = await run(command, ['run', configPath], {
    cwd: version?.path ?? out,
    env: { [keyEnv]: provider.apiKey, PYTHONUNBUFFERED: '1' },
    timeoutMs: 30 * 60_000,
  })
  const graphsFile = join(out, 'graphs.jsonl')
  if (result.code !== 0) {
    const failures = join(out, 'graphs.failures.jsonl')
    const detail = tail(result.stderr || result.stdout, 20) || (existsSync(failures) ? tail(readFileSync(failures, 'utf8'), 10) : '')
    throw new Error(`GBC 运行失败：${detail || `exit ${result.code}`}`)
  }
  if (!existsSync(graphsFile)) throw new Error('GBC 没有输出 graph')
  const lines = readFileSync(graphsFile, 'utf8').split('\n').filter(Boolean)
  if (!lines.length) {
    const failures = join(out, 'graphs.failures.jsonl')
    throw new Error(`GBC 没有输出 graph${existsSync(failures) ? `：${tail(readFileSync(failures, 'utf8'), 6)}` : ''}`)
  }
  const statsFile = join(out, 'graphs.stats.jsonl')
  const stats = existsSync(statsFile) ? readFileSync(statsFile, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) as { key?: string } } catch { return {} }
  }) : []
  const images = lines.map((line, index) => {
    const graph = JSON.parse(line) as GbcGraph
    const key = stats[index]?.key ?? (selectedFiles[index]?.split(/[\\/]/).pop() ?? `image-${index + 1}`)
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
        const rows = image.vertices.map((vertex) => `- ${vertex.label ?? 'object'}: ${vertex.descs?.[0]?.text ?? ''}${vertex.bbox ? ` [${vertex.bbox.left.toFixed(3)}, ${vertex.bbox.top.toFixed(3)}, ${vertex.bbox.right.toFixed(3)}, ${vertex.bbox.bottom.toFixed(3)}]` : ''}`)
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
