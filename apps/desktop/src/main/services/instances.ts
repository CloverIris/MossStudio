import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstanceInfo, InstancePlacement, ModelBinding, RuntimeInfo, Settings } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import {
  DEFAULT_SOURCE,
  branchStableSha,
  commitExists,
  createWorktree,
  ensureMirror,
  isDirty,
  listCommits,
  checkout,
  removeWorktree,
} from './git'
import { ensureRuntime, readRuntime } from './runtimes'
import {
  createRemoteRuntime,
  createRemoteWorktree,
  ensureRemoteMirror,
  remoteCheckout,
  remoteCommits,
  remoteInstancePath,
  remoteMirrorPath,
  remoteRoots,
} from './remoteInstances'
import { posixQuote, sshExec } from './ssh'
import { validateBinding } from './modelBundles'

export interface InstanceRecord {
  schemaVersion: 1
  id: string
  name: string
  source: string
  branch: string
  commit: string
  shortCommit: string
  commitDate: string
  subject: string
  author: string
  channel: InstanceInfo['channel']
  runtimeId: string
  runtimeMode: InstanceInfo['runtimeMode']
  placement?: InstancePlacement
  models: string[]
  modelBinding?: ModelBinding
  adapters: string[]
  adapterBindings?: Array<{ id: string; enabled: boolean; strength: number }>
  createdAt: string
  lastUsedAt: string | null
}

function recordFile(id: string): string {
  return join(paths.instance(id), 'instance.json')
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'instance'
  )
}

async function readRecord(id: string): Promise<InstanceRecord | null> {
  try {
    return JSON.parse(await readFile(recordFile(id), 'utf8')) as InstanceRecord
  } catch {
    return null
  }
}

async function writeRecord(record: InstanceRecord): Promise<void> {
  await mkdir(paths.instance(record.id), { recursive: true })
  await writeFile(recordFile(record.id), JSON.stringify(record, null, 2), 'utf8')
}

function channelFor(branch: string, commit: string, mainSha: string | null): InstanceInfo['channel'] {
  if (branch === 'main' && commit === mainSha) return 'stable'
  return branch === 'main' ? 'experimental' : 'custom'
}

async function toInfo(record: InstanceRecord): Promise<InstanceInfo> {
  const placement: InstancePlacement = record.placement ?? { kind: 'local' }
  const localDir = paths.instance(record.id)
  const dir = placement.kind === 'local' ? localDir : placement.root
  const runtime = await readRuntime(record.runtimeId)
  const mainSha = await branchStableSha(record.source)
  const exists = placement.kind === 'local' ? existsSync(localDir) && existsSync(join(localDir, 'pyproject.toml')) : true
  const dirty = placement.kind === 'local' && exists ? await isDirty(localDir) : false
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    branch: record.branch,
    commit: record.commit,
    shortCommit: record.shortCommit,
    commitDate: record.commitDate,
    subject: record.subject,
    author: record.author,
    channel: channelFor(record.branch, record.commit, mainSha),
    runtimeId: record.runtimeId,
    runtimeMode: record.runtimeMode,
    runtimeState: runtime?.state ?? 'missing',
    placement,
    hostId: placement.kind === 'ssh' ? placement.hostId : undefined,
    models: record.models,
    modelBinding: record.modelBinding,
    adapters: record.adapters,
    adapterBindings: record.adapterBindings ?? [],
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    path: dir,
    dirty,
    status: !exists ? 'missing' : !runtime ? 'runtime-missing' : 'ok',
  }
}

export async function listInstances(): Promise<InstanceInfo[]> {
  try {
    const entries = await readdir(paths.instances(), { withFileTypes: true })
    const records: InstanceRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const record = await readRecord(entry.name)
      if (record) records.push(record)
    }
    return Promise.all(records.map(toInfo))
  } catch {
    return []
  }
}

export async function getInstance(id: string): Promise<InstanceInfo | null> {
  const record = await readRecord(id)
  return record ? toInfo(record) : null
}

export interface CreateInstanceInput {
  branch: string
  commit: string
  name?: string
  runtimeMode: 'shared' | 'isolated'
  source?: string
  hostId?: string
}

export async function createInstance(input: CreateInstanceInput, settings: Settings): Promise<InstanceInfo> {
  if (input.hostId) return createRemoteInstance(input, settings)
  const source = input.source ?? DEFAULT_SOURCE
  await ensureMirror(settings, source)
  if (!(await commitExists(input.commit, source))) throw new Error('该提交不在本地镜像中，请先刷新分支')

  const commits = await listCommits(input.branch, 100, source)
  const commit = commits.find((item) => item.sha === input.commit || item.sha.startsWith(input.commit))
  const sha = commit?.sha ?? input.commit
  const short = sha.slice(0, 7)
  const name = (input.name?.trim() || `moss-${input.branch}-${short}`).slice(0, 60)

  let id = slugify(name)
  let suffix = 1
  while (existsSync(paths.instance(id))) {
    suffix += 1
    id = `${slugify(name)}-${suffix}`
  }

  const destination = paths.instance(id)
  await mkdir(paths.instances(), { recursive: true })
  await createWorktree(sha, destination, source)

  const runtime = await ensureRuntime({
    instanceId: id,
    instanceDir: destination,
    mode: input.runtimeMode,
    settings,
  })

  const record: InstanceRecord = {
    schemaVersion: 1,
    id,
    name,
    source,
    branch: input.branch,
    commit: sha,
    shortCommit: short,
    commitDate: commit?.date ?? new Date().toISOString(),
    subject: commit?.subject ?? '',
    author: commit?.author ?? '',
    channel: channelFor(input.branch, sha, await branchStableSha(source)),
    runtimeId: runtime.id,
    runtimeMode: input.runtimeMode,
    placement: { kind: 'local' },
    modelBinding: { bundleId: 'moss-sft', dit: 'moss-sft-dit', textEncoder: 'qwen35-encoder', vae: 'flux2-vae-small' },
    models: ['moss-sft-dit', 'qwen35-encoder', 'flux2-vae-small', 'moss-pipeline'],
    adapters: [],
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  }
  await writeRecord(record)
  emit(Events.instancesChanged, { id })
  return toInfo(record)
}

async function createRemoteInstance(input: CreateInstanceInput, settings: Settings): Promise<InstanceInfo> {
  if (!input.hostId) throw new Error('缺少远端 host')
  const roots = await remoteRoots(settings, input.hostId)
  const source = input.source ?? DEFAULT_SOURCE
  await ensureRemoteMirror(roots, source)
  const commits = await remoteCommits(roots, input.branch, 200, source)
  const commit = commits.find((item) => item.sha === input.commit || item.sha.startsWith(input.commit))
  const sha = commit?.sha ?? input.commit
  const short = sha.slice(0, 7)
  const name = (input.name?.trim() || `moss-${input.branch}-${short}`).slice(0, 60)
  let id = slugify(name)
  let suffix = 1
  while (existsSync(paths.instance(id))) {
    suffix += 1
    id = `${slugify(name)}-${suffix}`
  }
  const remotePath = remoteInstancePath(roots, id)
  await createRemoteWorktree(roots, id, sha, source)
  const runtime = await createRemoteRuntime(roots, id, sha)
  const record: InstanceRecord = {
    schemaVersion: 1,
    id,
    name,
    source,
    branch: input.branch,
    commit: sha,
    shortCommit: short,
    commitDate: commit?.date ?? new Date().toISOString(),
    subject: commit?.subject ?? '',
    author: commit?.author ?? '',
    channel: channelFor(input.branch, sha, await branchStableSha(source)),
    runtimeId: runtime.id,
    runtimeMode: 'isolated',
    placement: {
      kind: 'ssh',
      hostId: roots.host.id,
      hostName: roots.host.name,
      root: remotePath,
    },
    models: [],
    adapters: [],
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  }
  await writeRecord(record)
  emit(Events.instancesChanged, { id })
  return toInfo(record)
}

export async function deleteInstance(id: string, keepOutputs: boolean, settings?: Settings): Promise<void> {
  const record = await readRecord(id)
  if (record?.placement?.kind === 'ssh') {
    if (!settings) throw new Error('缺少设置，无法清理远端实例')
    const placement = record.placement
    const roots = await remoteRoots(settings, placement.hostId)
    const mirror = remoteMirrorPath(roots, record.source)
    const backup = `${roots.instanceRoot.replace(/\/$/, '')}/outputs-kept/${id}`
    const command = [
      keepOutputs
        ? `mkdir -p ${posixQuote(backup)} && cp -R ${posixQuote(`${placement.root}/outputs/.`)} ${posixQuote(`${backup}/`)} 2>/dev/null || true`
        : ':',
      `git -C ${posixQuote(mirror)} worktree remove --force ${posixQuote(placement.root)} 2>/dev/null || { rm -rf ${posixQuote(placement.root)}; git -C ${posixQuote(mirror)} worktree prune; }`,
    ].join('\n')
    const result = await sshExec(roots.host, command, 120_000)
    if (result.code !== 0) {
      throw new Error(`远端实例删除失败：${(result.stderr || result.stdout).trim().slice(-1200)}`)
    }
    await rm(paths.instance(id), { recursive: true, force: true })
    if (record) await rm(paths.runtime(record.runtimeId), { recursive: true, force: true })
    emit(Events.instancesChanged, { id })
    return
  }
  const dir = paths.instance(id)
  if (keepOutputs && existsSync(join(dir, 'outputs'))) {
    const backup = join(paths.root(), 'outputs-kept', id)
    await mkdir(backup, { recursive: true })
    await cp(join(dir, 'outputs'), backup, { recursive: true, force: true })
  }
  await removeWorktree(dir, record?.source)
  if (record) {
    const runtime = await readRuntime(record.runtimeId)
    if (runtime) {
      runtime.instanceIds = runtime.instanceIds.filter((item) => item !== id)
      await writeFile(join(paths.runtime(runtime.id), 'runtime.json'), JSON.stringify(runtime, null, 2), 'utf8')
    }
  }
  await rm(dir, { recursive: true, force: true })
  emit(Events.instancesChanged, { id })
}

export async function updateInstance(id: string, commit: string, settings?: Settings): Promise<InstanceInfo> {
  const record = await readRecord(id)
  if (!record) throw new Error('实例不存在')
  let info: { sha: string; date: string; subject: string; author: string } | undefined
  if (record.placement?.kind === 'ssh') {
    if (!settings) throw new Error('缺少设置，无法切换远端实例版本')
    const roots = await remoteRoots(settings, record.placement.hostId)
    const commits = await remoteCommits(roots, record.branch, 200, record.source)
    info = commits.find((item) => item.sha === commit || item.sha.startsWith(commit))
    const sha = info?.sha ?? commit
    await remoteCheckout(roots, id, sha)
    record.commit = sha
  } else {
    await checkout(paths.instance(id), commit)
    const commits = await listCommits(record.branch, 100, record.source)
    info = commits.find((item) => item.sha === commit || item.sha.startsWith(commit))
    record.commit = info?.sha ?? commit
  }
  record.shortCommit = record.commit.slice(0, 7)
  record.commitDate = info?.date ?? new Date().toISOString()
  record.subject = info?.subject ?? ''
  record.author = info?.author ?? ''
  record.channel = channelFor(record.branch, record.commit, await branchStableSha(record.source))
  await writeRecord(record)
  emit(Events.instancesChanged, { id })
  return toInfo(record)
}

export async function isolateInstance(id: string, settings: Settings): Promise<RuntimeInfo> {
  const record = await readRecord(id)
  if (!record) throw new Error('实例不存在')
  if (record.placement?.kind === 'ssh') throw new Error('远端实例已经是独立 venv；不支持本地 isolate')
  const previous = await readRuntime(record.runtimeId)
  const runtime = await ensureRuntime({
    instanceId: id,
    instanceDir: paths.instance(id),
    mode: 'isolated',
    settings,
  })
  record.runtimeId = runtime.id
  record.runtimeMode = 'isolated'
  await writeRecord(record)
  if (previous) {
    previous.instanceIds = previous.instanceIds.filter((item) => item !== id)
    await writeFile(join(paths.runtime(previous.id), 'runtime.json'), JSON.stringify(previous, null, 2), 'utf8')
  }
  emit(Events.instancesChanged, { id })
  return runtime
}

export async function updateAdapterBindings(
  id: string,
  bindings: Array<{ id: string; enabled: boolean; strength: number }>,
): Promise<InstanceInfo> {
  const record = await readRecord(id)
  if (!record) throw new Error('实例不存在')
  record.adapterBindings = bindings
  record.adapters = bindings.filter((item) => item.enabled).map((item) => item.id)
  await writeRecord(record)
  emit(Events.instancesChanged, { id })
  return toInfo(record)
}

export async function updateModelBinding(id: string, binding: ModelBinding | null, settings: Settings): Promise<InstanceInfo> {
  const record = await readRecord(id)
  if (!record) throw new Error('实例不存在')
  if (record.placement?.kind === 'ssh') throw new Error('组件绑定目前仅支持本地实例')
  if (binding) {
    const bundle = await validateBinding(binding, settings)
    record.models = [binding.dit, binding.textEncoder, binding.vae, bundle.support]
  } else record.models = []
  record.modelBinding = binding ?? undefined
  await writeRecord(record)
  emit(Events.instancesChanged, { id })
  return toInfo(record)
}

export async function markUsed(id: string): Promise<void> {
  const record = await readRecord(id)
  if (!record) return
  record.lastUsedAt = new Date().toISOString()
  await writeRecord(record)
}
