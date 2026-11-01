import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AdapterEntry, DownloadTask, ModelEntry, TrainingHost } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { getHfToken } from './hfCredentials'
import { atomicWriteJson, getSettings, readJson } from './settings'
import { getTrainingHost, listTrainingHosts, updateTrainingHostModelPath } from './trainingHosts'
import { posixQuote, sshExec } from './ssh'
import workerSource from './remoteModelWorker.py?raw'

const workerName = `worker-${createHash('sha256').update(workerSource).digest('hex').slice(0, 16)}.py`
const workerPath = `"$HOME/.mossstudio/downloads/${workerName}"`
const deployments = new Map<string, Promise<void>>()
let cache: DownloadTask[] | undefined
let monitorStarted = false
const polling = new Map<string, Promise<DownloadTask[]>>()
const commands = new Map<string, Promise<unknown>>()
const cacheFile = (): string => join(paths.root(), 'remote-downloads.json')

export function listRemoteDownloads(): DownloadTask[] {
  cache ??= readJson<DownloadTask[]>(cacheFile(), []).map((task) => ({
    ...task, speedBps: 0,
    connectionError: task.state === 'running' || task.state === 'verifying' || task.state === 'queued'
      ? '正在重新连接远端，显示上次记录的进度' : undefined,
  }))
  return cache.filter((task) => task.state !== 'canceled')
}

function networkFor(host: TrainingHost): { endpoint: string; proxy?: string; token?: string; concurrency: number } {
  const settings = getSettings()
  return {
    endpoint: (host.hfEndpoint || settings.hfEndpoint || 'https://huggingface.co').replace(/\/+$/, ''),
    proxy: host.downloadProxy || undefined,
    token: getHfToken(host.id) || getHfToken(),
    concurrency: host.downloadConcurrency ?? settings.modelDownloadConcurrency ?? 4,
  }
}

async function deploy(host: TrainingHost): Promise<void> {
  const key = `${host.id}:${host.user}@${host.host}:${host.port}`
  let pending = deployments.get(key)
  if (!pending) {
    pending = (async () => {
      const script = 'import os,sys,pathlib;os.umask(0o077);p=pathlib.Path.home()/".mossstudio"/"downloads";p.mkdir(parents=True,exist_ok=True);f=p/'
        + JSON.stringify(workerName) + ';t=f.with_suffix(".upload-"+str(os.getpid()));t.write_text(sys.stdin.read());t.chmod(0o700);os.replace(t,f)'
      const result = await sshExec(host, `python3 -c ${posixQuote(script)}`, 30_000, workerSource)
      if (result.code !== 0) throw new Error(result.stderr.trim() || '远端下载需要 python3 和 curl')
    })()
    deployments.set(key, pending)
    void pending.catch(() => deployments.delete(key))
  }
  await pending
}

async function executeCommand<T>(host: TrainingHost, action: string, input: Record<string, unknown>): Promise<T> {
  if (host.kind !== 'ssh') throw new Error('请选择 SSH 设备')
  await deploy(host)
  const result = await sshExec(host, `python3 ${workerPath}`, action === 'http' ? 240_000 : 30_000,
    JSON.stringify({ action, network: networkFor(host), ...input }))
  let parsed: { ok: boolean; result: T; error?: string }
  try { parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!) }
  catch { throw new Error(result.timedOut ? 'SSH 请求超时；远端下载会继续，稍后自动重连' : '无法读取远端下载状态，请检查 python3/curl 与 SSH 连接') }
  if (!parsed.ok || result.code !== 0) throw new Error(parsed.error || '远端下载请求失败')
  return parsed.result
}

async function command<T>(host: TrainingHost, action: string, input: Record<string, unknown> = {}): Promise<T> {
  // Keep control responses and polling snapshots in order. HF queries can run
  // independently so a slow metadata request does not block pause/status calls.
  if (action === 'http') return executeCommand(host, action, input)
  const previous = commands.get(host.id) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => executeCommand<T>(host, action, input))
  commands.set(host.id, current)
  try { return await current }
  finally { if (commands.get(host.id) === current) commands.delete(host.id) }
}

function updateTasks(host: TrainingHost, tasks: DownloadTask[]): DownloadTask[] {
  listRemoteDownloads()
  const incoming = tasks.map((task) => ({ ...task, hostId: host.id, hostName: host.name, connectionError: undefined }))
  const before = new Map(cache!.map((task) => [task.id, task]))
  cache = [...cache!.filter((task) => task.hostId !== host.id), ...incoming]
  atomicWriteJson(cacheFile(), cache)
  for (const task of incoming) {
    if (JSON.stringify(task) === JSON.stringify(before.get(task.id))) continue
    if (task.state === 'done' && before.get(task.id)?.state !== 'done'
      && task.targetId === 'default-sft' && task.remotePath
      && !incoming.some((other) => other.targetId === 'default-sft' && other.state === 'done' && other.updatedAt > task.updatedAt)) {
      updateTrainingHostModelPath(host.id, task.remotePath)
      if (before.get(task.id)?.state !== 'done') emit(Events.hostsChanged, { id: host.id })
    }
    emit(Events.download, task)
  }
  return incoming
}

export async function refreshRemoteDownloads(hostId: string): Promise<DownloadTask[]> {
  const existing = polling.get(hostId)
  if (existing) return existing
  const host = getTrainingHost(getSettings(), hostId)
  if (!host || host.kind !== 'ssh') throw new Error('远端设备不存在')
  const pending = (async () => {
    try { return updateTasks(host, await command<DownloadTask[]>(host, 'list')) }
    catch (error) {
      listRemoteDownloads()
      cache = cache!.map((task) => task.hostId === hostId ? {
        ...task, speedBps: 0, connectionError: error instanceof Error ? error.message : String(error),
      } : task)
      atomicWriteJson(cacheFile(), cache)
      for (const task of cache.filter((task) => task.hostId === hostId)) emit(Events.download, task)
      throw error
    }
  })()
  polling.set(hostId, pending)
  try { return await pending } finally { polling.delete(hostId) }
}

export function startRemoteDownloadMonitor(): void {
  if (monitorStarted) return
  monitorStarted = true
  listRemoteDownloads()
  const poll = async (): Promise<void> => {
    await Promise.allSettled(listTrainingHosts(getSettings()).filter((host) => host.kind === 'ssh')
      .map((host) => refreshRemoteDownloads(host.id)))
    setTimeout(() => { void poll() }, 3000).unref()
  }
  void poll()
}

export async function startRemoteDownload(
  host: TrainingHost,
  model: Pick<ModelEntry | AdapterEntry, 'id' | 'name' | 'repo' | 'revision' | 'files' | 'sizeBytes'>,
  kind: DownloadTask['kind'] = 'model',
): Promise<DownloadTask> {
  const task: DownloadTask = {
    id: `remote:${host.id}:${model.id}:${createHash('sha256').update(`${host.modelsRoot || '~/.mossstudio/models'}:${model.repo}@${model.revision || 'main'}`).digest('hex').slice(0, 12)}`,
    hostId: host.id, hostName: host.name,
    kind, targetId: model.id, label: model.name, state: 'queued',
    bytes: 0, totalBytes: model.sizeBytes, speedBps: 0, filesDone: 0, filesTotal: 0,
    updatedAt: new Date().toISOString(),
  }
  const tasks = updateTasks(host, await command<DownloadTask[]>(host, 'start', {
    spec: { repo: model.repo, revision: model.revision || 'main', files: model.files,
      modelsRoot: host.modelsRoot || '~/.mossstudio/models', task },
  }))
  startRemoteDownloadMonitor()
  return tasks.find((item) => item.id === task.id)!
}

export async function controlRemoteDownload(hostId: string, taskId: string, operation: 'pause' | 'resume' | 'cancel'): Promise<DownloadTask[]> {
  const host = getTrainingHost(getSettings(), hostId)
  if (!host || host.kind !== 'ssh') throw new Error('远端设备不存在')
  const tasks = updateTasks(host, await command<DownloadTask[]>(host, 'control', { taskId, operation }))
  startRemoteDownloadMonitor()
  return tasks
}

export async function queryRemoteHf(hostId: string, url: string, endpoint?: string, token?: string): Promise<{ body: string; headers: Record<string, string> }> {
  const host = getTrainingHost(getSettings(), hostId)
  if (!host || host.kind !== 'ssh') throw new Error('HF 查询回退设备不存在')
  const network = networkFor(host)
  const base = endpoint?.replace(/\/+$/, '')
  if (base && !host.hfEndpoint) network.endpoint = base
  if (base && !url.startsWith(base + '/')) throw new Error('HF 查询地址无效')
  const remoteUrl = base ? network.endpoint + url.slice(base.length) : url
  if (token && !getHfToken(host.id)) network.token = token
  const result = await command<{ body: string; headers: Record<string, string> }>(host, 'http', { url: remoteUrl, network })
  if (base && result.headers.link) result.headers.link = result.headers.link.split(network.endpoint).join(base)
  return result
}
