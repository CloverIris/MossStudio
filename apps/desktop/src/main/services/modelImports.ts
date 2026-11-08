import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

export type ImportedModelRole = 'full' | 'dit' | 'text_encoder' | 'vae' | 'support'

export interface ImportedModelFile {
  id: string
  name: string
  path: string
  relativePath: string
  /** Missing for files registered by a directory scan: hashing 27 GB up front is unusable. */
  sha256?: string
  size: number
  mtimeMs: number
  role: ImportedModelRole
  /** Set by a directory scan: a diffusers folder vs a single ComfyUI weights file. */
  layout?: 'comfyui-single-file' | 'diffusers-folder'
  importedAt: string
}

interface ImportIndex {
  schema_version: 1 | 2
  models: ImportedModelFile[]
}

export interface ImportFolderResult {
  added: number
  duplicates: number
}

const modelExtensions = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'])
const skippedDirectories = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', 'cache', 'input', 'output', 'temp'])
const maxDepth = 12
const maxFiles = 5000

function isImportedModelFile(value: unknown): value is ImportedModelFile {
  if (!value || typeof value !== 'object') return false
  const model = value as Partial<ImportedModelFile>
  return (
    typeof model.id === 'string' &&
    typeof model.name === 'string' &&
    typeof model.path === 'string' &&
    typeof model.relativePath === 'string' &&
    (model.sha256 === undefined || /^[a-f0-9]{64}$/.test(model.sha256)) &&
    Number.isSafeInteger(model.size) &&
    (model.size ?? 0) > 0 &&
    typeof model.mtimeMs === 'number' &&
    Number.isFinite(model.mtimeMs) &&
    ['full', 'dit', 'text_encoder', 'vae', 'support'].includes(model.role ?? '') &&
    (model.layout === undefined || ['comfyui-single-file', 'diffusers-folder'].includes(model.layout)) &&
    typeof model.importedAt === 'string'
  )
}

export async function readImportedModels(indexFile: string): Promise<ImportedModelFile[]> {
  let content: string
  try {
    content = await readFile(indexFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const index = JSON.parse(content) as Partial<ImportIndex>
  if (
    (index.schema_version !== 1 && index.schema_version !== 2) ||
    !Array.isArray(index.models) ||
    !index.models.every(isImportedModelFile)
  ) {
    throw new Error('本地模型导入记录无效')
  }
  return index.models
}

async function writeImportedModels(indexFile: string, models: ImportedModelFile[]): Promise<void> {
  await mkdir(dirname(indexFile), { recursive: true })
  const temporary = `${indexFile}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ schema_version: 2, models }, null, 2), 'utf8')
    await rename(temporary, indexFile)
  } finally {
    await rm(temporary, { force: true })
  }
}

function roleFor(relativePath: string): ImportedModelRole {
  const directories = relativePath
    .split(/[\\/]/)
    .slice(0, -1)
    .map((part) => part.toLowerCase())
  if (directories.some((part) => /^(vae|vaes)$/.test(part))) return 'vae'
  if (directories.some((part) => /^(text[_-]?encoders?|clip)$/.test(part))) return 'text_encoder'
  if (directories.some((part) => /^(diffusion[_-]?models?|unet|checkpoints?)$/.test(part))) return 'dit'
  return 'full'
}

async function scanDirectory(root: string): Promise<string[]> {
  const found: string[] = []
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !skippedDirectories.has(entry.name.toLowerCase())) {
          await visit(join(directory, entry.name), depth + 1)
        }
      } else if (entry.isFile() && modelExtensions.has(extname(entry.name).toLowerCase())) {
        found.push(join(directory, entry.name))
        if (found.length > maxFiles) throw new Error(`所选目录中模型文件超过 ${maxFiles} 个，请选择更具体的文件夹`)
      }
    }
  }
  await visit(root, 0)
  return found
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export async function importModelFolder(directory: string, indexFile: string): Promise<ImportFolderResult> {
  const root = await realpath(resolve(directory))
  if (!(await stat(root)).isDirectory()) throw new Error('请选择模型文件夹')
  const files = await scanDirectory(root)
  if (files.length === 0) throw new Error('所选目录中没有可导入的模型文件')

  const models = await readImportedModels(indexFile)
  const byHash = new Map(models.filter((model) => model.sha256).map((model) => [model.sha256 as string, model]))
  let added = 0
  let duplicates = 0
  for (const file of files) {
    const before = await stat(file)
    if (!before.isFile() || before.size <= 0) continue
    const sha256 = await hashFile(file)
    const after = await stat(file)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`模型文件在导入时发生变化：${relative(root, file)}`)
    }
    const existing = byHash.get(sha256)
    if (existing) {
      try {
        if (existing.path === file || ((await stat(existing.path)).isFile() && (await hashFile(existing.path)) === sha256)) {
          duplicates += 1
          continue
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const relativePath = relative(root, file)
    const record: ImportedModelFile = {
      id: `local-file-${sha256.slice(0, 20)}`,
      name: basename(file),
      path: file,
      relativePath,
      sha256,
      size: after.size,
      mtimeMs: after.mtimeMs,
      role: roleFor(relativePath),
      importedAt: new Date().toISOString(),
    }
    if (existing) models.splice(models.indexOf(existing), 1, record)
    else models.push(record)
    byHash.set(sha256, record)
    added += 1
  }
  if (!added && !duplicates) throw new Error('没有找到可读取的非空模型文件')
  await writeImportedModels(indexFile, models)
  return { added, duplicates }
}

/* ------------------------------------------------------------------ */
/* Diffusers folders, registered in place                              */
/* ------------------------------------------------------------------ */

export interface DiffusersFolderInfo {
  /** Bytes of every file in the folder (what the registration checks later). */
  size: number
  mtimeMs: number
  /** Which MOSS-Image this is, from README's title or the folder name; null when unknown. */
  flavor: 'sft' | 'base' | null
  /** Weight dtype read from the transformer's safetensors header: `bf16`, `fp16`, `fp32`. */
  dtype: string | null
  /** Every file, relative to the folder, with its size (what the catalog components are matched against). */
  files: Array<{ path: string; size: number }>
}

const DTYPES: Record<string, string> = { BF16: 'bf16', F16: 'fp16', F32: 'fp32' }

/** The dtype of the first tensor in a safetensors file: 8-byte header length, then a JSON header. */
async function safetensorsDtype(file: string): Promise<string | null> {
  try {
    const handle = await open(file, 'r')
    try {
      const head = Buffer.alloc(8)
      await handle.read(head, 0, 8, 0)
      const length = Number(head.readBigUInt64LE(0))
      if (!Number.isSafeInteger(length) || length <= 0 || length > 64 * 1024 * 1024) return null
      const json = Buffer.alloc(length)
      await handle.read(json, 0, length, 8)
      const header = JSON.parse(json.toString('utf8')) as Record<string, { dtype?: string; data_offsets?: [number, number] }>
      // The dtype holding most of the bytes (norms and scales are often kept in fp32).
      const bytes = new Map<string, number>()
      for (const [name, tensor] of Object.entries(header)) {
        if (name === '__metadata__' || !tensor?.dtype) continue
        const [start, end] = tensor.data_offsets ?? [0, 0]
        bytes.set(tensor.dtype, (bytes.get(tensor.dtype) ?? 0) + Math.max(0, end - start))
      }
      const top = [...bytes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      return top ? (DTYPES[top] ?? top.toLowerCase()) : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function listFolder(root: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const files: Array<{ path: string; size: number; mtimeMs: number }> = []
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 4) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !skippedDirectories.has(entry.name.toLowerCase())) await visit(absolute, depth + 1)
      } else if (entry.isFile()) {
        const info = await stat(absolute)
        files.push({ path: relative(root, absolute).split(/[\\/]/).join('/'), size: info.size, mtimeMs: info.mtimeMs })
      }
      if (files.length > maxFiles) throw new Error(`模型文件夹里的文件超过 ${maxFiles} 个`)
    }
  }
  await visit(root, 0)
  return files
}

/**
 * A complete diffusers folder: model_index.json, and transformer/,
 * text_encoder/ and vae/ each with config.json and safetensors weights.
 * Null for anything else.
 */
export async function inspectDiffusersFolder(directory: string): Promise<DiffusersFolderInfo | null> {
  let files: Array<{ path: string; size: number; mtimeMs: number }>
  try {
    if (!(await stat(directory)).isDirectory()) return null
    files = await listFolder(directory)
  } catch {
    return null
  }
  const has = (path: string): boolean => files.some((file) => file.path === path && file.size > 0)
  if (!has('model_index.json')) return null
  for (const part of ['transformer', 'text_encoder', 'vae']) {
    if (!has(`${part}/config.json`)) return null
    if (!files.some((file) => file.path.startsWith(`${part}/`) && file.path.endsWith('.safetensors') && file.size > 0)) return null
  }
  let flavor: DiffusersFolderInfo['flavor'] = null
  try {
    const title = /^#\s+(.+)$/m.exec(await readFile(join(directory, 'README.md'), 'utf8'))?.[1] ?? ''
    if (/MOSS-Image-SFT/i.test(title)) flavor = 'sft'
    else if (/MOSS-Image-Base/i.test(title)) flavor = 'base'
  } catch {
    /* no README */
  }
  if (!flavor) {
    const name = basename(directory).toLowerCase()
    if (/(^|[^a-z])sft([^a-z]|$)/.test(name)) flavor = 'sft'
    else if (/(^|[^a-z])base([^a-z]|$)/.test(name)) flavor = 'base'
  }
  const shard = files
    .filter((file) => file.path.startsWith('transformer/') && file.path.endsWith('.safetensors'))
    .sort((a, b) => a.path.localeCompare(b.path))[0]
  const index = files.find((file) => file.path === 'model_index.json')!
  return {
    size: files.reduce((sum, file) => sum + file.size, 0),
    mtimeMs: index.mtimeMs,
    flavor,
    dtype: shard ? await safetensorsDtype(join(directory, shard.path)) : null,
    files: files.map(({ path, size }) => ({ path, size })),
  }
}

/** What people see for a diffusers folder: the MOSS-Image it is, or the folder name. */
export function diffusersFolderName(directory: string, flavor: DiffusersFolderInfo['flavor']): string {
  if (flavor === 'sft') return `MOSS-Image SFT（${basename(directory)}）`
  if (flavor === 'base') return `MOSS-Image Base（${basename(directory)}）`
  return basename(directory)
}

export async function removeImportedModel(indexFile: string, id: string): Promise<void> {
  const models = await readImportedModels(indexFile)
  const next = models.filter((model) => model.id !== id)
  if (next.length === models.length) throw new Error('本地导入模型记录不存在')
  await writeImportedModels(indexFile, next)
}

export interface ScannedRegistration {
  path: string
  role: ImportedModelRole
  name?: string
  relativePath?: string
  layout?: 'comfyui-single-file' | 'diffusers-folder'
}

export interface RegisterScanResult {
  added: number
  updated: number
  missing: string[]
  /** The registered entry id of each item, in order; null for an item whose file is gone. */
  ids: Array<string | null>
}

/**
 * Register files found by `modelScan`. No hashing and no copying: the user's
 * ComfyUI folder is only read, and the record points at the original file.
 * Re-registering the same path updates its role/size instead of adding a row.
 */
export async function registerScannedModels(indexFile: string, items: ScannedRegistration[]): Promise<RegisterScanResult> {
  const models = await readImportedModels(indexFile)
  const byPath = new Map(models.map((model) => [model.path.toLowerCase(), model]))
  const result: RegisterScanResult = { added: 0, updated: 0, missing: [], ids: [] }
  for (const item of items) {
    let path: string
    try {
      path = await realpath(resolve(item.path))
    } catch {
      result.missing.push(item.path)
      result.ids.push(null)
      continue
    }
    const existing = byPath.get(path.toLowerCase())
    const layout = item.layout ?? existing?.layout
    // A diffusers folder is one model, used where it is (nothing copied); a weights file is one file.
    let size: number
    let mtimeMs: number
    let name = item.name
    if (layout === 'diffusers-folder') {
      const folder = await inspectDiffusersFolder(path)
      if (!folder) {
        result.missing.push(item.path)
        result.ids.push(null)
        continue
      }
      size = folder.size
      mtimeMs = folder.mtimeMs
      if (!name || name === '.') name = diffusersFolderName(path, folder.flavor)
    } else {
      const info = await stat(path).catch(() => null)
      if (!info || !info.isFile() || info.size <= 0) {
        result.missing.push(item.path)
        result.ids.push(null)
        continue
      }
      size = info.size
      mtimeMs = info.mtimeMs
    }
    const relativePath = item.relativePath && item.relativePath !== '.' ? item.relativePath : basename(path)
    const record: ImportedModelFile = {
      id: existing?.id ?? `local-scan-${createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 20)}`,
      name: name ?? basename(path),
      path,
      relativePath,
      size,
      mtimeMs,
      role: item.role,
      importedAt: existing?.importedAt ?? new Date().toISOString(),
      ...(layout ? { layout } : {}),
      ...(existing?.sha256 ? { sha256: existing.sha256 } : {}),
    }
    if (existing) {
      models.splice(models.indexOf(existing), 1, record)
      result.updated += 1
    } else {
      models.push(record)
      result.added += 1
    }
    byPath.set(path.toLowerCase(), record)
    result.ids.push(record.id)
  }
  if (result.added || result.updated) await writeImportedModels(indexFile, models)
  return result
}

export async function verifyImportedModelFile(model: ImportedModelFile, sha256: string, size: number): Promise<boolean> {
  // Records registered by a scan carry no hash; they cannot be matched to an HF
  // blob by content, so the caller falls back to downloading it.
  if (!model.sha256 || model.sha256 !== sha256 || model.size !== size) return false
  try {
    const info = await stat(model.path)
    return info.isFile() && info.size === size && (await hashFile(model.path)) === sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
