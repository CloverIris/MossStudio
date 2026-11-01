import { fetchHf } from './hfNetwork'
import { getHfToken } from './hfCredentials'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  AdapterEntry,
  Catalog,
  DownloadTask,
  ModelEntry,
  ModelBundle,
  Settings,
} from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { assertFreeSpace } from '../lib/disk'
import { getLastNetwork } from './network'
import { localReleaseDir } from './updates'
import { listJobs } from './supervisor'
import packagedCatalog from '../../../../../release/models.json'
import {
  importModelFolder as importModelDirectory,
  readImportedModels,
  removeImportedModel,
  verifyImportedModelFile,
} from './modelImports'
import {
  downloadFile,
  fileSize,
  hashFile,
  materialize,
  resolveFiles,
  safePath,
  selectFiles,
  validateSnapshot,
  type ModelFile,
  type Snapshot,
} from './modelFiles'

interface RawModel {
  id: string
  name: string
  provider: 'hf'
  repo: string
  revision?: string
  role: ModelEntry['role']
  precision: string
  format?: ModelEntry['format']
  family?: string
  subfolder?: string
  size_bytes?: number
  files?: string[]
  license: string
  tags?: string[]
  notes?: string
  preview?: string
}

interface RawAdapter {
  id: string
  name: string
  provider: 'hf'
  repo: string
  revision?: string
  kind: AdapterEntry['kind']
  base?: string
  license: string
  files: string[]
  size_bytes?: number
  requires_profile?: string
  tags?: string[]
  notes?: string
}

interface LocalAdapterRecord {
  id: string
  name: string
  path: string
  kind: AdapterEntry['kind']
  base?: string
  license: string
  files: string[]
  sizeBytes: number
  createdAt: string
}

interface LocalAdapterIndex {
  schema_version: 1
  adapters: LocalAdapterRecord[]
}

interface RawCatalog {
  schema_version: number
  updated_at?: string
  models: RawModel[]
  bundles?: ModelBundle[]
  adapters?: RawAdapter[]
}

const BUILTIN = packagedCatalog as RawCatalog
let catalogRoot = ''

let catalogCache: Catalog | null = null

function localAdapterFile(settings: Settings): string {
  return join(paths.adapters(settings.modelsRoot, settings.modelDirectories), 'index.json')
}

async function readLocalAdapters(settings: Settings): Promise<LocalAdapterRecord[]> {
  try {
    const raw = JSON.parse(await readFile(localAdapterFile(settings), 'utf8')) as LocalAdapterIndex
    return Array.isArray(raw.adapters) ? raw.adapters : []
  } catch {
    return []
  }
}

export async function registerTrainedAdapter(
  settings: Settings,
  input: {
    id: string
    name: string
    sourcePath: string
    kind?: AdapterEntry['kind']
    base?: string
    license?: string
  },
): Promise<AdapterEntry> {
  const id = input.id.replace(/[^A-Za-z0-9._-]/g, '-')
  const destDir = join(paths.adapters(settings.modelsRoot, settings.modelDirectories), id)
  await mkdir(destDir, { recursive: true })
  const file = basename(input.sourcePath)
  await copyFile(input.sourcePath, join(destDir, file))
  const info = await stat(join(destDir, file))
  const record: LocalAdapterRecord = {
    id,
    name: input.name || id,
    path: destDir,
    kind: input.kind ?? 'lora',
    base: input.base,
    license: input.license ?? 'local',
    files: [file],
    sizeBytes: info.size,
    createdAt: new Date().toISOString(),
  }
  const existing = (await readLocalAdapters(settings)).filter((item) => item.id !== id)
  await writeFile(
    localAdapterFile(settings),
    JSON.stringify({ schema_version: 1, adapters: [...existing, record] }, null, 2),
    'utf8',
  )
  invalidateCatalog()
  return {
    id,
    name: record.name,
    provider: 'local',
    repo: record.path,
    revision: 'local',
    kind: record.kind,
    base: record.base,
    license: record.license,
    files: record.files,
    sizeBytes: record.sizeBytes,
    tags: ['trained'],
    notes: '由 Kohaku Trainer 产物登记',
    installed: true,
    installedBytes: record.sizeBytes,
  }
}

/** Resolve an installed adapter's weight file (LoRA safetensors) on disk; null when missing. */
export async function resolveAdapterFile(settings: Settings, id: string): Promise<string | null> {
  const dir = join(paths.adapters(settings.modelsRoot, settings.modelDirectories), id)
  try {
    const raw = JSON.parse(await readFile(join(dir, 'adapter.json'), 'utf8')) as { files?: string[] }
    const file = (raw.files ?? []).find((item) => item.endsWith('.safetensors'))
    if (file && (await fileSize(safePath(dir, file))) > 0) return safePath(dir, file)
  } catch {
    // no adapter.json (e.g. locally registered adapters) — fall through to directory scan
  }
  try {
    const file = (await readdir(dir)).find((name) => name.endsWith('.safetensors'))
    return file ? join(dir, file) : null
  } catch {
    return null
  }
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

function importedModelsIndex(settings: Settings): string {
  return join(paths.modelImports(settings.modelsRoot), 'index.json')
}

interface InstallRecord {
  version: 2
  id: string
  repo: string
  revision: string
  sha: string
  entries: ModelFile[]
  owned: string[]
}

function blobKey(file: ModelFile): string {
  if (file.oid && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.oid))
    throw new Error('缓存文件 hash 无效')
  return file.oid ?? createHash('sha1').update(file.path).digest('hex')
}

function cacheDir(settings: Settings, repo: string, role: ModelEntry['role'] = 'full'): string {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    repo.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('无效的模型仓库 ID')
  return join(paths.roleHub(role, settings.modelsRoot, settings.modelDirectories), `models--${repo.replace('/', '--')}`)
}
function legacyCacheDir(settings: Settings, repo: string): string {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    repo.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('无效的模型仓库 ID')
  return join(paths.hub(settings.modelsRoot), `models--${repo.replace('/', '--')}`)
}
function cacheLocations(settings: Settings, repo: string, role: ModelEntry['role']): string[] {
  return [...new Set([cacheDir(settings, repo, role), legacyCacheDir(settings, repo)])]
}
function markerAt(dir: string, id: string): string {
  return join(dir, `.clover-${id.replace(/[^A-Za-z0-9._-]/g, '-')}.json`)
}
function marker(settings: Settings, id: string, repo: string, role: ModelEntry['role'] = 'full'): string {
  return markerAt(cacheDir(settings, repo, role), id)
}
const installing = new Set<string>()
const deleting = new Set<string>()
interface InstallLocation {
  record: InstallRecord
  dir: string
}

async function findInstall(
  settings: Settings,
  model: Pick<ModelEntry, 'id' | 'repo' | 'revision' | 'role' | 'format' | 'subfolder'>,
): Promise<InstallLocation | null> {
  for (const dir of cacheLocations(settings, model.repo, model.role)) {
    try {
      const record = JSON.parse(await readFile(markerAt(dir, model.id), 'utf8')) as InstallRecord
      if (
        record.version !== 2 ||
        record.id !== model.id ||
        record.repo !== model.repo ||
        record.revision !== model.revision ||
        !/^[a-f0-9]{40,64}$/.test(record.sha)
      )
        continue
      const root = join(dir, 'snapshots', record.sha)
      if (
        !(await validateSnapshot(
          root,
          record.entries,
          model.format === 'comfyui' ? 'comfyui' : model.role,
          model.subfolder,
        ))
      )
        continue
      if (model.role === 'full') {
        let valid = true
        for (const [role, folder] of [
          ['dit', 'transformer'],
          ['text_encoder', 'text_encoder'],
          ['vae', 'vae'],
          ['support', ''],
        ]) {
          if (!(await validateSnapshot(root, record.entries, role!, folder))) {
            valid = false
            break
          }
        }
        if (!valid) continue
      }
      return { record, dir }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
  }
  return null
}

export async function getCatalog(settings: Settings, force = false): Promise<Catalog> {
  const key = JSON.stringify([paths.models(settings.modelsRoot), settings.modelDirectories])
  if (catalogCache && catalogRoot === key && !force) return catalogCache
  let raw = BUILTIN
  let source: Catalog['source'] = 'builtin'
  const local = localReleaseDir()
  try {
    if (local && existsSync(join(local, 'models.json'))) {
      raw = JSON.parse(await readFile(join(local, 'models.json'), 'utf8')) as RawCatalog
      source = 'local'
    } else {
      const base =
        getLastNetwork()?.selected.manifest ??
        'https://raw.githubusercontent.com/CloverIris/MossStudio/main'
      raw = JSON.parse(
        await fetchText(`${base.replace(/\/$/, '')}/release/models.json`),
      ) as RawCatalog
      source = 'remote'
    }
    if (!Array.isArray(raw.models)) throw new Error('无效目录')
  } catch {
    raw = BUILTIN
    source = 'builtin'
  }
  // Old remote catalogs cannot reintroduce whole-repo downloads for known models.
  if (raw.schema_version < 2) {
    const known = new Set([
      'moss-sft',
      'moss-base',
      'moss-comfy-repack',
      'moss-sft-int8',
      'moss-sft-int4',
      ...BUILTIN.models.map((m) => m.id),
    ])
    raw = {
      ...BUILTIN,
      models: [...BUILTIN.models, ...raw.models.filter((m) => !known.has(m.id))],
      adapters: raw.adapters ?? BUILTIN.adapters,
    }
  }
  const models: ModelEntry[] = await Promise.all(
    raw.models.map(async (model) => {
      const entry: ModelEntry = {
        id: model.id,
        name: model.name,
        provider: model.provider,
        repo: model.repo,
        revision: model.revision ?? 'main',
        role: model.role,
        precision: model.precision,
        format: model.format ?? 'diffusers',
        subfolder: model.subfolder,
        family: model.family ?? 'moss-image',
        sizeBytes: model.size_bytes ?? 0,
        files: model.files,
        license: model.license,
        tags: model.tags ?? [],
        notes: model.notes,
        preview: model.preview,
        installed: false,
        installedBytes: 0,
      }
      const location = await findInstall(settings, entry)
      const record = location?.record
      entry.installed = Boolean(record)
      entry.installedBytes = record?.entries.reduce((n, f) => n + f.size, 0) ?? 0
      const task = tasks.get(`model:${entry.id}`)
      const locations = cacheLocations(settings, entry.repo, entry.role)
      let partial = locations.some((dir) =>
        existsSync(`${markerAt(dir, entry.id)}.pending`) || existsSync(markerAt(dir, entry.id)),
      )
      for (const dir of locations) {
        try {
          const sha = (await readFile(join(dir, 'refs', entry.revision), 'utf8')).trim()
          if (/^[a-f0-9]{40,64}$/.test(sha)) {
            const snapshot = join(dir, 'snapshots', sha)
            partial ||= (
              await Promise.all(
                (entry.files ?? []).map((pattern) =>
                  fileSize(
                    safePath(
                      snapshot,
                      pattern.includes('*')
                        ? pattern.slice(0, pattern.indexOf('*')).replace(/\/$/, '')
                        : pattern,
                    ),
                  ),
                ),
              )
            ).some((size) => size >= 0)
          }
        } catch {
          /* No cached snapshot in this storage root. */
        }
        if (partial) break
      }
      entry.installState = entry.installed
        ? 'ready'
        : task?.state === 'error'
          ? 'error'
          : partial
            ? 'partial'
            : 'missing'
      entry.resolvedRevision = record?.sha
      return entry
    }),
  )
  for (const imported of await readImportedModels(importedModelsIndex(settings))) {
    let installed = false
    try {
      const info = await stat(imported.path)
      installed = info.isFile() && info.size === imported.size && info.mtimeMs === imported.mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    models.push({
      id: imported.id,
      name: imported.name,
      provider: 'local',
      repo: imported.path,
      revision: 'local',
      role: imported.role,
      precision: 'local',
      format: 'comfyui',
      family: 'local',
      sizeBytes: imported.size,
      files: [imported.relativePath],
      license: 'local',
      tags: ['local-import', 'comfyui', `sha256:${imported.sha256}`],
      notes: `外部文件引用；移除记录不会删除原文件。SHA256 ${imported.sha256}`,
      localPath: imported.path,
      installState: installed ? 'ready' : 'error',
      installed,
      installedBytes: installed ? imported.size : 0,
    })
  }
  const adapters: AdapterEntry[] = await Promise.all(
    (raw.adapters ?? []).map(async (adapter) => {
      const dir = join(paths.adapters(settings.modelsRoot, settings.modelDirectories), adapter.id)
      const ready = await Promise.all(adapter.files.map((f) => fileSize(safePath(dir, f))))
      const installed = existsSync(join(dir, 'adapter.json')) && ready.every((n) => n > 0)
      return {
        id: adapter.id,
        name: adapter.name,
        provider: adapter.provider,
        repo: adapter.repo,
        revision: adapter.revision ?? 'main',
        kind: adapter.kind,
        base: adapter.base,
        license: adapter.license,
        files: adapter.files,
        sizeBytes: adapter.size_bytes ?? 0,
        requiresProfile: adapter.requires_profile,
        tags: adapter.tags ?? [],
        notes: adapter.notes,
        installed,
        installedBytes: installed ? ready.reduce((n, size) => n + size, 0) : 0,
      }
    }),
  )
  for (const local of await readLocalAdapters(settings)) {
    adapters.push({
      ...local,
      provider: 'local',
      repo: local.path,
      revision: 'local',
      tags: ['trained'],
      installed: true,
      installedBytes: local.sizeBytes,
    })
  }
  catalogRoot = key
  catalogCache = {
    updatedAt: raw.updated_at ?? new Date().toISOString(),
    models,
    adapters,
    bundles: raw.bundles ?? BUILTIN.bundles ?? [],
    source,
  }
  return catalogCache
}

export function invalidateCatalog(): void {
  catalogCache = null
}
const tasks = new Map<string, DownloadTask>()
const controllers = new Map<string, AbortController>()
const completions = new Map<string, Promise<void>>()
export function listDownloads(): DownloadTask[] {
  // Map insertion order keeps the initial list consistent with live queue updates.
  return [...tasks.values()]
}
function touch(task: DownloadTask, patch: Partial<DownloadTask>): void {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() })
  invalidateCatalog()
  emit(Events.download, { ...task })
}
function endpoint(settings: Settings): string {
  return (settings.hfEndpoint ?? getLastNetwork()?.selected.hf ?? 'https://huggingface.co').replace(
    /\/$/,
    '',
  )
}
const repoRequests = new Map<string, Promise<Snapshot>>()
async function resolveRepo(repo: string, revision: string, settings: Settings): Promise<Snapshot> {
  const key = `${endpoint(settings)}/${repo}@${revision}`
  let request = repoRequests.get(key)
  if (!request) {
    request = resolveFiles(endpoint(settings), repo, revision, undefined, (url) => fetchHf(url, endpoint(settings), settings))
    repoRequests.set(key, request)
    void request.finally(() => repoRequests.delete(key)).catch(() => undefined)
  }
  return request
}

async function runModelDownload(
  task: DownloadTask,
  entry: ModelEntry,
  settings: Settings,
  signal: AbortSignal,
): Promise<void> {
  const { sha, files } = await resolveRepo(entry.repo, entry.revision, settings)
  signal.throwIfAborted()
  const selected = selectFiles(files, entry.files)
  if (!selected.length) throw new Error('模型文件不在仓库中')
  const dir = cacheDir(settings, entry.repo, entry.role)
  const root = join(dir, 'snapshots', sha)
  const total = selected.reduce((n, file) => n + file.size, 0)
  const oldLocation = await findInstall(settings, entry)
  const oldRecord = oldLocation?.dir === dir ? oldLocation.record : null
  let pendingOwned: string[] = []
  const pendingFile = `${marker(settings, entry.id, entry.repo, entry.role)}.pending`
  try {
    pendingOwned = JSON.parse(await readFile(pendingFile, 'utf8')).owned ?? []
  } catch {
    /* No partial installation. */
  }
  const owned = new Set([...(oldRecord?.owned ?? []), ...pendingOwned])
  const hubs = [...new Set([
    paths.hub(settings.modelsRoot),
    ...(['dit', 'text_encoder', 'vae', 'support'] as const).map((role) =>
      paths.roleHub(role, settings.modelsRoot, settings.modelDirectories),
    ),
  ])]
  const repos = (
    await Promise.all(
      hubs.map(async (hub) =>
        (await readdir(hub).catch(() => [] as string[]))
          .filter((name) => name.startsWith('models--'))
          .map((name) => join(hub, name)),
      ),
    )
  ).flat()
  const importedModels = await readImportedModels(importedModelsIndex(settings))
  // Reuse matching HF blobs from older full Base/SFT installations before requesting bytes.
  for (const file of selected) {
    const blob = join(dir, 'blobs', blobKey(file))
    if ((await fileSize(blob)) >= 0 || !file.oid) continue
    if (file.oid.length === 64) {
      const imported = importedModels.find((candidate) => candidate.sha256 === file.oid)
      if (
        imported &&
        (await verifyImportedModelFile(imported, file.oid, file.size))
      ) {
        const temporary = `${blob}.${randomUUID()}.importing`
        await mkdir(dirname(blob), { recursive: true })
        try {
          await copyFile(imported.path, temporary)
          if (
            (await fileSize(temporary)) === file.size &&
            (await hashFile(temporary)) === file.oid
          ) {
            await rename(temporary, blob)
            owned.add(file.path)
            continue
          }
        } finally {
          await rm(temporary, { force: true })
        }
      }
    }
    for (const repo of repos) {
      const candidate = join(repo, 'blobs', file.oid)
      if (candidate === blob || (await fileSize(candidate)) !== file.size) continue
      if (file.oid.length === 64 && (await hashFile(candidate)) !== file.oid) continue
      await materialize(candidate, blob)
      owned.add(file.path)
      break
    }
  }
  let missing = 0
  for (const file of selected) {
    const blob = join(dir, 'blobs', blobKey(file))
    if ((await fileSize(blob)) !== file.size)
      missing += Math.max(0, file.size - Math.max(0, await fileSize(`${blob}.part`)))
  }
  await assertFreeSpace(
    paths.roleRoot(entry.role, settings.modelsRoot, settings.modelDirectories),
    missing + (missing > 0 ? 1024 ** 3 : 0),
    `模型组件 ${entry.name}`,
  )
  touch(task, { filesTotal: selected.length, totalBytes: total, state: 'running' })
  let done = 0
  let last = Date.now()
  let lastBytes = 0
  for (let index = 0; index < selected.length; index += 1) {
    signal.throwIfAborted()
    const file = selected[index]!
    const blob = join(dir, 'blobs', blobKey(file))
    if ((await fileSize(blob)) < 0) {
      owned.add(file.path)
      await mkdir(join(dir, '.clover-owned'), { recursive: true })
      await writeFile(join(dir, '.clover-owned', basename(blob)), '')
    }
    await mkdir(dir, { recursive: true })
    await writeFile(
      pendingFile,
      JSON.stringify({
        version: 2,
        id: entry.id,
        repo: entry.repo,
        revision: entry.revision,
        sha,
        entries: selected,
        owned: [...owned],
      }),
    )
    touch(task, { currentFile: file.path, filesDone: index })
    await downloadFile(
      `${endpoint(settings)}/${entry.repo}/resolve/${sha}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
      blob,
      file,
      signal,
      (bytes, verifying) => {
        const now = Date.now()
        if (now - last > 300 || verifying !== (task.state === 'verifying')) {
          const value = done + bytes
          touch(task, {
            state: verifying ? 'verifying' : 'running',
            bytes: value,
            speedBps: verifying
              ? 0
              : Math.max(0, ((value - lastBytes) * 1000) / Math.max(1, now - last)),
          })
          last = now
          lastBytes = value
        }
      },
      { token: getHfToken(), concurrency: settings.modelDownloadConcurrency },
    )
    signal.throwIfAborted()
    const target = safePath(root, file.path)
    if ((await fileSize(target)) >= 0) await unlink(target)
    await materialize(blob, target)
    done += file.size
    touch(task, { state: 'running', bytes: done, filesDone: index + 1 })
  }
  if (
    !(await validateSnapshot(
      root,
      selected,
      entry.format === 'comfyui' ? 'comfyui' : entry.role,
      entry.subfolder,
    ))
  )
    throw new Error('组件配置或权重分片不完整')
  if (entry.role === 'full') {
    for (const [role, folder] of [
      ['dit', 'transformer'],
      ['text_encoder', 'text_encoder'],
      ['vae', 'vae'],
      ['support', ''],
    ]) {
      if (!(await validateSnapshot(root, selected, role!, folder)))
        throw new Error(`完整模型缺少 ${role}`)
    }
  }
  signal.throwIfAborted()
  await mkdir(join(dir, 'refs'), { recursive: true })
  // Do not overwrite refs/main when installing a different pinned revision.
  await mkdir(dirname(safePath(join(dir, 'refs'), entry.revision)), { recursive: true })
  await writeFile(safePath(join(dir, 'refs'), entry.revision), sha, 'utf8')
  const record: InstallRecord = {
    version: 2,
    id: entry.id,
    repo: entry.repo,
    revision: entry.revision,
    sha,
    entries: selected,
    owned: [...owned],
  }
  const dest = marker(settings, entry.id, entry.repo, entry.role)
  await writeFile(`${dest}.tmp`, JSON.stringify(record, null, 2))
  await rename(`${dest}.tmp`, dest)
  await unlink(pendingFile).catch(() => undefined)
}

async function runAdapterDownload(
  task: DownloadTask,
  entry: AdapterEntry,
  settings: Settings,
  signal: AbortSignal,
): Promise<void> {
  const { sha, files } = await resolveRepo(entry.repo, entry.revision, settings)
  const selected = selectFiles(files, entry.files)
  if (!selected.length) throw new Error('适配器文件不在仓库中')
  const total = selected.reduce((n, file) => n + file.size, 0)
  const dir = join(paths.adapters(settings.modelsRoot, settings.modelDirectories), entry.id)
  await assertFreeSpace(paths.adapters(settings.modelsRoot, settings.modelDirectories), total, `适配器 ${entry.name}`)
  touch(task, { filesTotal: selected.length, totalBytes: total, state: 'running' })
  let done = 0
  for (const [index, file] of selected.entries()) {
    signal.throwIfAborted()
    touch(task, { currentFile: file.path })
    await downloadFile(
      `${endpoint(settings)}/${entry.repo}/resolve/${sha}/${file.path}`,
      safePath(dir, file.path),
      file,
      signal,
      (bytes, verifying) =>
        touch(task, { state: verifying ? 'verifying' : 'running', bytes: done + bytes }),
      { token: getHfToken(), concurrency: settings.modelDownloadConcurrency },
    )
    done += file.size
    touch(task, { filesDone: index + 1 })
  }
  signal.throwIfAborted()
  await writeFile(join(dir, 'adapter.json'), JSON.stringify(entry, null, 2))
}

async function beginDownload(
  kind: 'model' | 'adapter',
  entry: ModelEntry | AdapterEntry,
  settings: Settings,
): Promise<DownloadTask> {
  const id = `${kind}:${entry.id}`
  if (deleting.size > 0) throw new Error('组件正在删除，请稍后重试')
  const existing = tasks.get(id)
  if (existing && ['running', 'verifying', 'queued'].includes(existing.state)) return existing
  // Let the old writer close its file before a paused task is resumed.
  await completions.get(id)?.catch(() => undefined)
  const current = tasks.get(id)
  if (current && ['running', 'verifying', 'queued'].includes(current.state)) return current
  const task: DownloadTask = {
    id,
    kind,
    targetId: entry.id,
    label: entry.name,
    state: 'queued',
    filesTotal: 0,
    filesDone: 0,
    bytes: 0,
    totalBytes: entry.sizeBytes,
    speedBps: 0,
    updatedAt: new Date().toISOString(),
  }
  const controller = new AbortController()
  tasks.set(id, task)
  controllers.set(id, controller)
  installing.add(entry.id)
  touch(task, {})
  const completion = (async () => {
    try {
      if (kind === 'model')
        await runModelDownload(task, entry as ModelEntry, settings, controller.signal)
      else await runAdapterDownload(task, entry as AdapterEntry, settings, controller.signal)
      touch(task, { state: 'done', bytes: task.totalBytes, speedBps: 0, currentFile: undefined })
    } catch (error) {
      if (task.state !== 'paused')
        touch(task, {
          state: 'error',
          speedBps: 0,
          error: error instanceof Error ? error.message : String(error),
        })
    } finally {
      if (controllers.get(id) === controller) controllers.delete(id)
      installing.delete(entry.id)
    }
  })()
  completions.set(id, completion)
  void completion.finally(() => {
    if (completions.get(id) === completion) completions.delete(id)
  })
  return task
}

export async function startDownload(
  kind: 'model' | 'adapter',
  id: string,
  settings: Settings,
): Promise<DownloadTask> {
  const catalog = await getCatalog(settings)
  const entry =
    kind === 'model'
      ? catalog.models.find((m) => m.id === id)
      : catalog.adapters.find((m) => m.id === id)
  if (!entry) throw new Error('目录中没有该条目')
  if (entry.provider === 'local') throw new Error('本地导入文件不能作为远程下载任务')
  return beginDownload(kind, entry, settings)
}

export async function importModelFolder(
  directory: string,
  settings: Settings,
): Promise<{ added: number; duplicates: number }> {
  const result = await importModelDirectory(directory, importedModelsIndex(settings))
  invalidateCatalog()
  return result
}
export async function installBundle(id: string, settings: Settings): Promise<DownloadTask[]> {
  const catalog = await getCatalog(settings, true)
  const bundle = catalog.bundles.find((b) => b.id === id)
  if (!bundle) throw new Error('模型组合不存在')
  const ids = [...Object.values(bundle.components), bundle.support]
  const result: DownloadTask[] = []
  for (const componentId of ids) {
    const model = catalog.models.find((m) => m.id === componentId)
    if (!model) throw new Error(`组合缺少组件：${componentId}`)
    if (!model.installed) result.push(await beginDownload('model', model, settings))
  }
  return result
}
export async function downloadCustomModel(repo: string, settings: Settings): Promise<DownloadTask> {
  return beginDownload(
    'model',
    {
      id: repo.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase(),
      name: repo,
      provider: 'hf',
      repo,
      revision: 'main',
      role: 'full',
      precision: 'bf16',
      format: 'diffusers',
      family: 'moss-image',
      sizeBytes: 0,
      license: 'unknown',
      tags: ['custom'],
      installed: false,
      installedBytes: 0,
    },
    settings,
  )
}
export async function cancelDownload(id: string): Promise<void> {
  const task = tasks.get(id)
  if (!task) return
  controllers.get(id)?.abort()
  controllers.delete(id)
  await completions.get(id)?.catch(() => undefined)
  tasks.delete(id)
  emit(Events.download, { ...task, state: 'canceled', speedBps: 0, currentFile: undefined })
}

export function pauseDownload(id: string): void {
  const task = tasks.get(id)
  if (!task || !['queued', 'running', 'verifying'].includes(task.state)) return
  touch(task, { state: 'paused', speedBps: 0 })
  controllers.get(id)?.abort()
}

export async function componentSnapshot(
  id: string,
  settings: Settings,
): Promise<{ model: ModelEntry; record: InstallRecord; root: string }> {
  const model = (await getCatalog(settings)).models.find((m) => m.id === id)
  if (!model) throw new Error(`组件不存在：${id}`)
  const location = await findInstall(settings, model)
  if (!location) throw new Error(`组件未就绪：${model.name}。请在模型库补齐组件。`)
  return {
    model,
    record: location.record,
    root: join(location.dir, 'snapshots', location.record.sha),
  }
}

export async function deleteModel(
  kind: 'model' | 'adapter',
  id: string,
  settings: Settings,
): Promise<void> {
  if (installing.size > 0) throw new Error('有组件正在下载或校验，请先暂停并稍后重试')
  deleting.add(id)
  try {
    const catalog = await getCatalog(settings)
    const entry =
      kind === 'model'
        ? catalog.models.find((m) => m.id === id)
        : catalog.adapters.find((m) => m.id === id)
    if (!entry) return
    if ((await listJobs()).some((job) => ['starting', 'running', 'canceling'].includes(job.state)))
      throw new Error('有任务正在运行，请结束任务后再删除模型文件')
    if (kind === 'adapter') {
      await rm(join(paths.adapters(settings.modelsRoot, settings.modelDirectories), id), { recursive: true, force: true })
      const adapters = (await readLocalAdapters(settings)).filter((a) => a.id !== id)
      await writeFile(
        localAdapterFile(settings),
        JSON.stringify({ schema_version: 1, adapters }, null, 2),
      )
      invalidateCatalog()
      return
    }
    const model = entry as ModelEntry
    if (model.provider === 'local') {
      await removeImportedModel(importedModelsIndex(settings), id)
      invalidateCatalog()
      return
    }
    let record: InstallRecord | null = null
    let dir = ''
    let markerFile = ''
    for (const candidate of cacheLocations(settings, model.repo, model.role)) {
      for (const path of [markerAt(candidate, id), `${markerAt(candidate, id)}.pending`]) {
        try {
          record = JSON.parse(await readFile(path, 'utf8')) as InstallRecord
          dir = candidate
          markerFile = markerAt(candidate, id)
          break
        } catch {
          continue
        }
      }
      if (record) break
    }
    if (
      !record ||
      record.version !== 2 ||
      record.id !== id ||
      record.repo !== model.repo ||
      !/^[a-f0-9]{40,64}$/.test(record.sha) ||
      !Array.isArray(record.entries) ||
      !Array.isArray(record.owned)
    )
      throw new Error('缓存安装记录不完整，请先点击修复组件以校验文件')
    const bundlesRoot = join(paths.models(settings.modelsRoot), 'bundles')
    for (const name of await readdir(bundlesRoot).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{24}(?:-[a-f0-9-]{8})?$/.test(name)) continue
      const view = safePath(bundlesRoot, name)
      try {
        const meta = JSON.parse(await readFile(join(view, 'clover_model.json'), 'utf8')) as {
          version: number
          components: Array<{ id: string }>
        }
        if (meta.version === 1 && meta.components.some((c) => c.id === id))
          await rm(view, { recursive: true, force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const otherRecords: InstallRecord[] = []
    const ownMarker = basename(markerFile)
    for (const name of await readdir(dir)) {
      if (
        !name.startsWith('.clover-') ||
        (!name.endsWith('.json') && !name.endsWith('.json.pending')) ||
        name === ownMarker ||
        name === `${ownMarker}.pending`
      )
        continue
      try {
        otherRecords.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as InstallRecord)
      } catch {
        throw new Error('共享组件记录损坏，未删除文件')
      }
    }
    // Unknown/legacy markers are conservative roots; never remove their shared files.
    const unknown = otherRecords.some((r) => r.version !== 2)
    for (const file of record.entries) {
      const blobName = blobKey(file)
      const ownership = join(dir, '.clover-owned', blobName)
      if (unknown || (!record.owned.includes(file.path) && !existsSync(ownership))) continue
      const shared = otherRecords.some((r) =>
        r.entries?.some(
          (f) => f.oid === file.oid || (r.sha === record.sha && f.path === file.path),
        ),
      )
      if (shared) continue
      // Only remove a snapshot link if no other snapshot can reference this blob.
      const snapshots = await readdir(join(dir, 'snapshots')).catch(() => [] as string[])
      if (snapshots.some((sha) => sha !== record.sha)) continue
      await unlink(safePath(join(dir, 'snapshots', record.sha), file.path)).catch(() => undefined)
      const blob = join(dir, 'blobs', blobKey(file))
      await unlink(blob).catch(() => undefined)
      await unlink(`${blob}.part`).catch(() => undefined)
      await unlink(ownership).catch(() => undefined)
    }
    await unlink(markerFile).catch(() => undefined)
    await unlink(`${markerFile}.pending`).catch(() => undefined)
    invalidateCatalog()
  } finally {
    deleting.delete(id)
  }
}
