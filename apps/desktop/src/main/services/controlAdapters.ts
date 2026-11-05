import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Events } from '@shared/channels'
import type { ControlAdapterEntry } from '@shared/types'
import { codedError, errorCode } from '../lib/codedError'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { requestEngineOnce } from '../lib/probeEngine'
import { requestRunningEngine, resolveServerPath } from './mossInfer'
import { getSettings } from './settings'

/**
 * Control adapter files the person registered (模型 › 控制). Each file is
 * checked with the engine's `inspect` before it is listed, so only what the
 * engine itself calls a control adapter can be picked for a job.
 */

function registryFile(): string {
  return join(paths.root(), 'control-adapters.json')
}

function isEntry(value: unknown): value is ControlAdapterEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry['id'] === 'string' && typeof entry['path'] === 'string' && typeof entry['name'] === 'string' &&
    typeof entry['sizeBytes'] === 'number' && Array.isArray(entry['controlKinds']) &&
    (entry['controlKinds'] as unknown[]).every((kind) => typeof kind === 'string') && typeof entry['addedAt'] === 'string'
}

export function listControlAdapters(): ControlAdapterEntry[] {
  try {
    const raw = JSON.parse(readFileSync(registryFile(), 'utf8')) as unknown
    return Array.isArray(raw) ? raw.filter(isEntry) : []
  } catch {
    return []
  }
}

function writeRegistry(entries: ControlAdapterEntry[]): void {
  const file = registryFile()
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(entries, null, 2), 'utf8')
  renameSync(temporary, file)
}

/** What `inspect` says a file is, in words a person can act on. */
const WRONG_KIND: Record<string, string> = {
  lora: '这是 LoRA，请在 LoRA 中添加',
  dit: '这是主模型（DiT），请在模型中添加',
  text_encoder: '这是文本编码器，请在模型中添加',
  vae: '这是 VAE，请在模型中添加',
}

/** Asks the engine what the file is: a running moss-server if there is one, else a short-lived one. */
async function inspectFile(path: string): Promise<Record<string, unknown>> {
  const running = requestRunningEngine('inspect', { path })
  if (running) return running
  const serverPath = resolveServerPath(getSettings())
  if (!serverPath) throw codedError('E_ENGINE', '需要先准备 MossInfer 引擎，才能识别控制适配器')
  const { hello, result } = await requestEngineOnce(serverPath, 'inspect', { path })
  if (hello.capabilities['inspect'] === false) {
    throw codedError('E_NOT_SUPPORTED', '当前引擎版本不能识别控制适配器，请更新 MossInfer')
  }
  return result
}

function inspectFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('method_not_found')) {
    return codedError('E_NOT_SUPPORTED', '当前引擎版本不能识别控制适配器，请更新 MossInfer')
  }
  return codedError('E_INSPECT', `无法读取这个文件：${message.replace(/^[a-z_]+:\s*/, '')}`)
}

export async function addControlAdapter(input: { path: string }): Promise<ControlAdapterEntry> {
  let path: string
  let sizeBytes: number
  try {
    path = realpathSync.native(input.path)
    const info = statSync(path)
    if (!info.isFile()) throw new Error('not a file')
    sizeBytes = info.size
  } catch {
    throw codedError('E_INPUT_PATH', '找不到这个文件，请重新选择')
  }
  let report: Record<string, unknown>
  try {
    report = await inspectFile(path)
  } catch (error) {
    throw errorCode(error) ? error : inspectFailure(error)
  }
  const kind = String(report['kind'] ?? 'unknown')
  if (kind !== 'control_adapter') {
    const note = typeof report['note'] === 'string' && report['note'].trim() ? `（${report['note'].trim()}）` : ''
    throw codedError('E_NOT_CONTROL_ADAPTER', WRONG_KIND[kind] ?? `这个文件不是控制适配器${note}`)
  }
  if (report['loadable'] === false) {
    const note = typeof report['note'] === 'string' && report['note'].trim() ? `：${report['note'].trim()}` : ''
    throw codedError('E_NOT_CONTROL_ADAPTER', `引擎无法使用这个控制适配器${note}`)
  }
  const controlKinds = Array.isArray(report['control_kinds'])
    ? (report['control_kinds'] as unknown[]).filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
  const baseModel = typeof report['base_model'] === 'string' && report['base_model'].trim() ? report['base_model'].trim() : undefined
  const existing = listControlAdapters()
  const previous = existing.find((entry) => entry.path === path)
  const entry: ControlAdapterEntry = {
    id: previous?.id ?? `control-${createHash('sha1').update(path).digest('hex').slice(0, 12)}`,
    name: basename(path),
    path,
    sizeBytes: typeof report['file_bytes'] === 'number' ? (report['file_bytes'] as number) : sizeBytes,
    controlKinds,
    ...(baseModel ? { baseModel } : {}),
    addedAt: previous?.addedAt ?? new Date().toISOString(),
  }
  writeRegistry([...existing.filter((item) => item.path !== path), entry])
  emit(Events.modelsChanged, null)
  return entry
}

export function removeControlAdapter(input: { id: string }): null {
  const existing = listControlAdapters()
  const next = existing.filter((entry) => entry.id !== input.id)
  if (next.length !== existing.length) {
    writeRegistry(next)
    emit(Events.modelsChanged, null)
  }
  return null
}
