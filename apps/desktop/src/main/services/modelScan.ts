import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import type { ModelScanResult, ScannedModel } from '@shared/types'
import { diffusersFolderName, inspectDiffusersFolder, type ImportedModelRole } from './modelImports'

/**
 * Read-only discovery of model files a user already has on disk.
 *
 * Nothing here writes, hashes or copies: pointing MossStudio at an existing
 * ComfyUI tree must not create folders in it, and hashing 27 GB before showing
 * anything is unusable. Registration happens in a second, explicit step; hashes
 * are computed later, only when a file is actually used or the user asks for one.
 */
export type ScanResult = ModelScanResult

const modelExtensions = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'])
const weightsExtension = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf'])
const skippedDirectories = new Set([
  '.git',
  '.cache',
  '.clover',
  'blobs',
  'snapshots',
  'refs',
  'hf',
  'node_modules',
  'venv',
  '.venv',
  '__pycache__',
  'input',
  'output',
  'temp',
  'custom_nodes',
  'user',
  'logs',
  'sessions',
  'clip_vision',
  'controlnet',
  'embeddings',
  'upscale_models',
  'style_models',
  'gligen',
  'hypernetworks',
  'photomaker',
  'vae_approx',
  'diffusers',
])

const maxDepth = 6
const maxFiles = 4000

interface RoleRule {
  role: ImportedModelRole
  /** Directory names ComfyUI and diffusers layouts use for this role. */
  directories: RegExp[]
  /** Cheap file-name hints, used when the directory does not give the role. */
  names: RegExp[]
}

const rules: RoleRule[] = [
  {
    role: 'dit',
    directories: [/^diffusion[_-]?models?$/, /^unet$/, /^checkpoints?$/, /^transformer$/],
    names: [/moss[_-]?image/, /moss[_-]?(sft|base)/, /diffusion[_-]?model/],
  },
  {
    role: 'text_encoder',
    directories: [/^text[_-]?encoders?$/, /^clip$/, /^text_encoder$/],
    names: [/qwen3?\.?5/, /text[_-]?encoder/, /^clip/],
  },
  {
    role: 'vae',
    directories: [/^vaes?$/, /^vae$/],
    names: [/vae/, /flux2[_-]?vae/],
  },
  {
    role: 'support',
    directories: [/^support$/, /^scheduler$/, /^pipeline$/, /^configs?$/],
    names: [/moss[_-]?pipeline/, /scheduler/, /runtime[_-]?config/],
  },
]

function segments(relativePath: string): string[] {
  return relativePath
    .split(/[\\/]/)
    .slice(0, -1)
    .map((part) => part.toLowerCase())
}

/** A directory name wins over a file name; the file name is a weaker signal. */
function detectRole(relativePath: string): { role: ImportedModelRole | 'lora'; confidence: ScannedModel['confidence']; hint: string } {
  const directories = segments(relativePath)
  for (const rule of rules) {
    for (const pattern of rule.directories) {
      const hit = directories.find((part) => pattern.test(part))
      if (hit) return { role: rule.role, confidence: 'high', hint: `目录 ${hit}` }
    }
  }
  if (directories.some((part) => /^(loras?|lycoris)$/.test(part))) {
    return { role: 'lora', confidence: 'high', hint: '目录 loras' }
  }
  const name = basename(relativePath).toLowerCase()
  for (const rule of rules) {
    const pattern = rule.names.find((candidate) => candidate.test(name))
    if (pattern) return { role: rule.role, confidence: 'medium', hint: `文件名 ${name}` }
  }
  return { role: 'full', confidence: 'low', hint: '未识别角色，需要手动指定' }
}

function isDiffusersFolder(entries: string[]): boolean {
  const lower = entries.map((name) => name.toLowerCase())
  return lower.includes('model_index.json') || lower.includes('transformer/config.json')
}

async function walk(root: string, result: ScanResult, directory = root, depth = 0): Promise<void> {
  if (depth > maxDepth) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    result.skipped.push({
      path: directory,
      reason: error instanceof Error ? error.message : String(error),
    })
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  if (isDiffusersFolder(entries.map((entry) => entry.name))) {
    // The picked folder itself: show its name, not ".".
    const relativePath = relative(root, directory) || basename(directory)
    const info = await stat(directory).catch(() => null)
    const folder = await inspectDiffusersFolder(directory)
    if (info) {
      result.candidates.push({
        path: directory,
        relativePath,
        name: diffusersFolderName(directory, folder?.flavor ?? null),
        size: folder?.size ?? 0,
        mtimeMs: info.mtimeMs,
        role: 'full',
        layout: 'diffusers-folder',
        confidence: 'high',
        hint: 'diffusers 文件夹',
      })
    }
    return
  }
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      const lower = entry.name.toLowerCase()
      if (entry.name.startsWith('.') || skippedDirectories.has(lower)) continue
      await walk(root, result, absolute, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    const extension = extname(entry.name).toLowerCase()
    if (!modelExtensions.has(extension)) continue
    if (result.files >= maxFiles) {
      result.skipped.push({ path: directory, reason: `文件超过 ${maxFiles} 个，已停止扫描` })
      return
    }
    const info = await stat(absolute).catch(() => null)
    if (!info || !info.isFile() || info.size <= 0) continue
    result.files += 1
    const relativePath = relative(root, absolute)
    const detected = detectRole(relativePath)
    result.candidates.push({
      path: absolute,
      relativePath,
      name: entry.name,
      size: info.size,
      mtimeMs: info.mtimeMs,
      role: detected.role,
      layout: 'comfyui-single-file',
      confidence: detected.confidence,
      hint: detected.hint,
    })
  }
}

export async function scanModelDirectory(directory: string): Promise<ScanResult> {
  const root = await realpath(resolve(directory))
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('请选择模型文件夹')
  const result: ScanResult = {
    root,
    scannedAt: new Date().toISOString(),
    files: 0,
    candidates: [],
    skipped: [],
  }
  await walk(root, result)
  result.candidates.sort((a, b) => {
    if (a.role !== b.role) return a.role.localeCompare(b.role)
    return b.size - a.size
  })
  return result
}

export function isScannableWeights(extension: string): boolean {
  return weightsExtension.has(extension.toLowerCase())
}
