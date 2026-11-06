import { createHash } from 'node:crypto'
import { join, posix } from 'node:path'
import type { AdapterEntry, DownloadTask, ModelEntry, TrainingHost } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { getHfToken } from './hfCredentials'
import { atomicWriteJson, getSettings, readJson } from './settings'
import { getTrainingHost, listTrainingHosts, updateTrainingHostModelPath } from './trainingHosts'
import { posixQuote, sshExec } from './ssh'
import { resolveFiles, safePath, selectFiles, type ModelFile } from './modelFiles'
import rawWorkerSource from './remoteModelWorker.sh?raw'

const workerSource = rawWorkerSource.replace(/\r\n/g, '\n')
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const workerName = `worker-${digest(workerSource).slice(0, 16)}.sh`
const deployments = new Map<string, Promise<void>>()
const commands = new Map<string, Promise<unknown>>()
const polling = new Map<string, Promise<DownloadTask[]>>()
const preparing = new Map<string, Promise<void>>()
let cache: DownloadTask[] | undefined
let monitorStarted = false
const cacheFile = (): string => join(paths.root(), 'remote-downloads.json')

interface Manifest {
  sha: string
  files: ModelFile[]
  path: string
  cache: string
}
interface Metadata {
  task: DownloadTask
  repo: string
  revision: string
  files?: string[]
  modelsRoot: string
  manifest?: Manifest
}
interface RecordEntry {
  name: string
  meta: Metadata
  task: DownloadTask
  generation: number
  desired: string
  legacy: boolean
}
const records = new Map<string, RecordEntry[]>()
type Network = { endpoint: string; proxy?: string; token?: string; concurrency: number }

export function listRemoteDownloads(): DownloadTask[] {
  cache ??= readJson<DownloadTask[]>(cacheFile(), []).map((task) => ({
    ...task,
    speedBps: 0,
    connectionError: ['running', 'verifying', 'queued'].includes(task.state) ? '正在重新连接远端，显示上次记录的进度' : undefined,
  }))
  return cache.filter((task) => task.state !== 'canceled')
}

function networkFor(host: TrainingHost): Network {
  const settings = getSettings()
  return {
    endpoint: (host.hfEndpoint || settings.hfEndpoint || 'https://huggingface.co').replace(/\/+$/, ''),
    proxy: host.downloadProxy || undefined,
    token: getHfToken(host.id) || getHfToken(),
    concurrency: Math.max(1, Math.min(16, host.downloadConcurrency ?? settings.modelDownloadConcurrency ?? 4)),
  }
}

function curlConfig(network: Network): string {
  const quote = (value: string): string => {
    // eslint-disable-next-line no-control-regex -- rejects control characters that would break the curl config
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('下载代理或 token 包含无效字符')
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return (
    [
      network.proxy ? `proxy = ${quote(network.proxy)}\nnoproxy = ""` : '',
      network.token ? `header = ${quote(`Authorization: Bearer ${network.token}`)}` : '',
    ]
      .filter(Boolean)
      .join('\n') + '\n'
  )
}

function cleanError(message: string, network: Network): string {
  for (const secret of [network.proxy, network.token]) if (secret) message = message.split(secret).join('[redacted]')
  return message.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1[redacted]@').slice(-1600)
}

async function shell(host: TrainingHost, script: string, timeout = 30_000): Promise<string> {
  if (host.kind !== 'ssh') throw new Error('请选择 SSH 设备')
  const result = await sshExec(host, 'bash -s', timeout, script)
  if (result.code !== 0)
    throw new Error(
      result.timedOut
        ? 'SSH 请求超时；已开始的远端下载会继续，稍后自动重连'
        : cleanError(result.stderr.trim() || '远端下载命令失败', networkFor(host)),
    )
  return result.stdout
}

// Scripts and credentials travel over stdin, never through SSH process arguments.
const write = (path: string, content: string): string =>
  `printf '%s' ${posixQuote(Buffer.from(content).toString('base64'))} | base64 -d > ${path}.tmp.$$\nmv ${path}.tmp.$$ ${path}\n`
const preamble = 'set -e\nset -o pipefail\numask 077\nroot="$HOME/.mossstudio/downloads"\n'

async function deploy(host: TrainingHost): Promise<void> {
  const key = JSON.stringify([host.id, host.user, host.host, host.port])
  let pending = deployments.get(key)
  if (!pending) {
    pending = shell(
      host,
      `${preamble}
test "\${BASH_VERSINFO[0]}" -ge 4 || { echo '远端下载需要 Bash 4 或更新版本' >&2; exit 127; }
for tool in curl flock setsid nohup stat sha256sum sha1sum base64 tr awk date df mkdir mv rm cat sleep dirname readlink chmod; do
  command -v "$tool" >/dev/null 2>&1 || { echo "远端下载缺少系统命令：$tool" >&2; exit 127; }
done
mkdir -p "$root/slots"
${write(`"$root/${workerName}"`, workerSource)}
chmod 700 "$root/${workerName}"
printf '%s\\n' "$root/${workerName}" > "$root/current-shell-worker.tmp.$$"
mv "$root/current-shell-worker.tmp.$$" "$root/current-shell-worker"
`,
    ).then(() => undefined)
    deployments.set(key, pending)
    void pending.catch(() => deployments.delete(key))
  }
  await pending
}

async function serial<T>(host: TrainingHost, action: () => Promise<T>): Promise<T> {
  const previous = commands.get(host.id) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(action)
  commands.set(host.id, current)
  try {
    return await current
  } finally {
    if (commands.get(host.id) === current) commands.delete(host.id)
  }
}

async function worker(host: TrainingHost, operation = ''): Promise<RecordEntry[]> {
  await deploy(host)
  const network = networkFor(host)
  const stdout = await shell(
    host,
    `${preamble}
${write('"$root/network.curl"', curlConfig(network))}
${write(
  '"$root/redact"',
  [network.proxy, network.token]
    .filter(Boolean)
    .map((value) => Buffer.from(value!).toString('base64'))
    .join('\n') + '\n',
)}
${write('"$root/concurrency"', `${network.concurrency}\n`)}
${operation}
nohup setsid bash "$root/${workerName}" serve </dev/null >> "$root/shell-manager.log" 2>&1 6>&- 7>&- 8>&- 9>&- &
bash "$root/${workerName}" list
`,
  )
  return parseSnapshot(host, stdout)
}

const decode = (text = ''): string => (text === '-' ? '' : Buffer.from(text, 'base64').toString('utf8'))
function parseSnapshot(host: TrainingHost, stdout: string): RecordEntry[] {
  const entries: RecordEntry[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const [format, name, ...fields] = line.split('\t')
    if (!['NATIVE', 'LEGACY'].includes(format!) || !/^task-[a-f0-9]{64}$/.test(name ?? '')) continue
    if (format === 'LEGACY') {
      const task = JSON.parse(decode(fields[0])) as DownloadTask & { generation?: number }
      const request = fields[1] !== '-' ? (JSON.parse(decode(fields[1])) as Metadata) : undefined
      if (!request || !task.id || digest(task.id) !== name!.slice(5)) continue
      const control = fields[3] !== '-' ? (JSON.parse(decode(fields[3])) as { desired?: string; generation?: number }) : {}
      const generation = control.generation ?? 0
      if (['paused', 'canceled'].includes(control.desired ?? '')) task.state = control.desired as DownloadTask['state']
      else if (generation !== task.generation) task.state = 'queued'
      delete task.generation
      if (task.state !== 'running') task.speedBps = 0
      request.manifest = fields[2] !== '-' ? (JSON.parse(decode(fields[2])) as Manifest) : undefined
      entries.push({ name: name!, meta: request, task, generation, desired: control.desired || 'paused', legacy: true })
    } else {
      const meta = JSON.parse(decode(fields[0])) as Metadata
      if (!meta.task?.id || digest(meta.task.id) !== name!.slice(5)) continue
      const generation = Number(fields[1])
      const desired = fields[2]!
      const [stateGeneration, state, bytes, speed, filesDone, current, error, timestamp] = fields.slice(3)
      const valid =
        Number(stateGeneration) === generation &&
        ['queued', 'running', 'verifying', 'done', 'error', 'paused', 'canceled'].includes(state ?? '')
      const task: DownloadTask = {
        ...meta.task,
        ...(meta.manifest
          ? {
              remotePath: meta.manifest.path,
              revision: meta.manifest.sha,
              totalBytes: meta.manifest.files.reduce((sum, file) => sum + file.size, 0),
              filesTotal: meta.manifest.files.length,
            }
          : {}),
        state: valid ? (state as DownloadTask['state']) : 'queued',
        bytes: valid ? Number(bytes) || 0 : meta.task.bytes,
        speedBps: valid ? Number(speed) || 0 : 0,
        filesDone: valid ? Number(filesDone) || 0 : meta.task.filesDone,
        currentFile: valid ? decode(current) || undefined : undefined,
        error: valid ? decode(error) || undefined : undefined,
        updatedAt: valid && Number(timestamp) > 0 ? new Date(Number(timestamp) * 1000).toISOString() : meta.task.updatedAt,
      }
      if (desired === 'paused' || desired === 'canceled') {
        task.state = desired
        task.speedBps = 0
      }
      if (task.state !== 'running') task.speedBps = 0
      entries.push({ name: name!, meta, task, generation, desired, legacy: false })
    }
  }
  records.set(host.id, entries)
  return entries
}

function validate(meta: Metadata): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(meta.repo)) throw new Error('HF 仓库名称无效')
  // eslint-disable-next-line no-control-regex -- rejects control characters in remote paths
  if (/[\x00-\x1f\x7f]/.test(meta.modelsRoot + meta.revision)) throw new Error('远端模型路径或 revision 无效')
  const manifest = meta.manifest
  if (!manifest) return
  if (!/^[a-f0-9]{40,64}$/.test(manifest.sha) || !manifest.path.startsWith('/') || !manifest.cache.startsWith('/'))
    throw new Error('远端模型清单无效')
  if (!manifest.files.length) throw new Error('模型清单没有匹配文件')
  const seen = new Set<string>()
  for (const file of manifest.files) {
    safePath('/model-cache', file.path)
    if (
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      // eslint-disable-next-line no-control-regex -- rejects control characters in manifest file paths
      /[\x00-\x1f\x7f]/.test(file.path) ||
      seen.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      (file.oid && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.oid))
    )
      throw new Error('远端模型文件清单无效')
    seen.add(file.path)
  }
}

function spec(meta: Metadata, endpoint: string): string {
  validate(meta)
  const manifest = meta.manifest!
  const array = (key: string, values: string[]): string => `${key}=(${values.map(posixQuote).join(' ')})\n`
  return (
    `snapshot=${posixQuote(manifest.path)}\ncache=${posixQuote(manifest.cache)}\nsha=${posixQuote(manifest.sha)}\n` +
    `ref_name=${posixQuote(meta.revision.replace(/[^A-Za-z0-9_.-]/g, '_'))}\ntotal_bytes=${manifest.files.reduce((sum, file) => sum + file.size, 0)}\n` +
    array(
      'file_paths',
      manifest.files.map((file) => file.path),
    ) +
    array(
      'file_sizes',
      manifest.files.map((file) => String(file.size)),
    ) +
    array(
      'file_hashes',
      manifest.files.map((file) => file.oid || ''),
    ) +
    array(
      'file_urls',
      manifest.files.map(
        (file) => `${endpoint}/${meta.repo}/resolve/${manifest.sha}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
      ),
    )
  )
}

// Share the legacy request/file locks so existing partial files can be resumed safely.
function persist(entry: RecordEntry, desired: string, endpoint: string): string {
  const generation = entry.generation + 1
  validate(entry.meta)
  return `directory="$root/${entry.name}"\nmkdir -p "$directory"\n(
flock -x 6
${entry.legacy ? write('"$directory/control.json"', JSON.stringify({ desired: 'paused', generation })) : ''}
${write('"$directory/shell-meta.json"', JSON.stringify({ ...entry.meta, task: entry.task }))}
${entry.meta.manifest ? write('"$directory/shell-spec"', spec(entry.meta, endpoint)) : ''}
${write('"$directory/shell-control"', `${generation} ${desired}\n`)}
) 6> "$directory/request.lock"\n`
}

async function remoteHttp(host: TrainingHost, url: string, network: Network): Promise<{ body: string; headers: Record<string, string> }> {
  const target = new URL(url)
  const base = new URL(network.endpoint)
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.origin !== base.origin ||
    !target.pathname.startsWith(base.pathname.replace(/\/+$/, '') + '/')
  )
    throw new Error('HF 查询地址必须使用配置的 endpoint')
  const stdout = await shell(
    host,
    `set -e\nset -o pipefail\numask 077
for tool in curl base64 mktemp tr rm cat mv; do command -v "$tool" >/dev/null 2>&1 || { echo "远端 HF 查询缺少系统命令：$tool" >&2; exit 127; }; done
directory=$(mktemp -d)
trap 'rm -rf -- "$directory"' EXIT
${write('"$directory/curl"', curlConfig(network))}
curl -q --config "$directory/curl" --location --fail --silent --show-error --proto '=http,https' --proto-redir '=http,https' --connect-timeout 15 --max-time 180 --max-filesize 2097152 --dump-header "$directory/headers" --output "$directory/body" --url ${posixQuote(url)}
printf 'HEADERS\\t'; base64 < "$directory/headers" | tr -d '\\n'; printf '\\nBODY\\t'; base64 < "$directory/body" | tr -d '\\n'; printf '\\n'
`,
    210_000,
  )
  const fields = new Map(
    stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [key, value] = line.split('\t')
        return [key!, decode(value)]
      }),
  )
  const body = fields.get('BODY')
  if (body === undefined || Buffer.byteLength(body) > 2097152) throw new Error('远端 HF 响应无效或超过 2 MiB')
  const block = (fields.get('HEADERS') || '')
    .trim()
    .split(/\r?\n\r?\n/)
    .filter((item) => /^HTTP\//.test(item))
    .at(-1)
  const headers: Record<string, string> = {}
  for (const line of block?.split(/\r?\n/).slice(1) || []) {
    const split = line.indexOf(':')
    if (split > 0) headers[line.slice(0, split).toLowerCase()] = line.slice(split + 1).trim()
  }
  return { body, headers }
}

function prepare(host: TrainingHost, entry: RecordEntry): void {
  if (entry.legacy || entry.desired !== 'running' || entry.meta.manifest || entry.task.state !== 'queued') return
  const key = `${host.id}:${entry.name}:${entry.generation}`
  if (preparing.has(key)) return
  const pending = (async () => {
    try {
      const network = networkFor(host)
      const snapshot = await resolveFiles(network.endpoint, entry.meta.repo, entry.meta.revision, undefined, async (url) => {
        if (records.get(host.id)?.find((item) => item.name === entry.name)?.generation !== entry.generation)
          throw new Error('下载请求已变更')
        const result = await remoteHttp(host, url, network)
        return new Response(result.body, { headers: result.headers })
      })
      const rootOutput = await shell(
        host,
        `${preamble}model_root=${posixQuote(entry.meta.modelsRoot)}
case "$model_root" in '~/'*) model_root="$HOME/\${model_root:2}";; '~') model_root="$HOME";; esac
readlink -m -- "$model_root"
`,
      )
      const modelRoot = rootOutput.trim()
      if (!modelRoot.startsWith('/') || /[\r\n]/.test(modelRoot)) throw new Error('远端模型目录无效')
      const cache = posix.join(modelRoot, 'hf', 'hub', `models--${entry.meta.repo.replace('/', '--')}`)
      const meta: Metadata = {
        ...entry.meta,
        manifest: {
          sha: snapshot.sha,
          files: selectFiles(snapshot.files, entry.meta.files),
          cache,
          path: posix.join(cache, 'snapshots', snapshot.sha),
        },
      }
      validate(meta)
      await serial(host, async () => {
        const operation = `directory="$root/${entry.name}"\n(
flock -x 6
read -r generation desired < "$directory/shell-control"
if test "$generation" = ${entry.generation} && test "$desired" = running; then
${write('"$directory/shell-meta.json"', JSON.stringify(meta))}
${write('"$directory/shell-spec"', spec(meta, network.endpoint))}
fi
) 6> "$directory/request.lock"\n`
        updateTasks(
          host,
          (await worker(host, operation)).map((item) => item.task),
        )
      })
    } catch (error) {
      await serial(host, async () => {
        const message = cleanError(error instanceof Error ? error.message : String(error), networkFor(host))
        const state = `${entry.generation}\terror\t${entry.task.bytes}\t0\t${entry.task.filesDone}\t-\t${Buffer.from(message).toString('base64')}\t${Math.floor(Date.now() / 1000)}\n`
        const operation = `directory="$root/${entry.name}"\n(
flock -x 6
read -r generation desired < "$directory/shell-control"
if test "$generation" = ${entry.generation} && test "$desired" = running; then
${write('"$directory/shell-state"', state)}fi
) 6> "$directory/request.lock"\n`
        updateTasks(
          host,
          (await worker(host, operation)).map((item) => item.task),
        )
      }).catch(() => undefined)
    }
  })()
  preparing.set(key, pending)
  void pending.finally(() => preparing.delete(key))
}

function updateTasks(host: TrainingHost, tasks: DownloadTask[]): DownloadTask[] {
  listRemoteDownloads()
  const incoming = tasks.map((task) => ({ ...task, hostId: host.id, hostName: host.name, connectionError: undefined }))
  const before = new Map(cache!.map((task) => [task.id, task]))
  cache = [...cache!.filter((task) => task.hostId !== host.id), ...incoming]
  atomicWriteJson(cacheFile(), cache)
  for (const task of incoming) {
    if (JSON.stringify(task) === JSON.stringify(before.get(task.id))) continue
    if (
      task.state === 'done' &&
      before.get(task.id)?.state !== 'done' &&
      task.targetId === 'default-sft' &&
      task.remotePath &&
      !incoming.some((other) => other.targetId === 'default-sft' && other.state === 'done' && other.updatedAt > task.updatedAt)
    ) {
      updateTrainingHostModelPath(host.id, task.remotePath)
      emit(Events.hostsChanged, { id: host.id })
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
  const pending = serial(host, async () => {
    try {
      let entries = await worker(host)
      const activeLegacy = entries.filter(
        (entry) => entry.legacy && entry.desired === 'running' && ['queued', 'running', 'verifying'].includes(entry.task.state),
      )
      if (activeLegacy.length)
        entries = await worker(host, activeLegacy.map((entry) => persist(entry, 'running', networkFor(host).endpoint)).join('\n'))
      for (const entry of entries) prepare(host, entry)
      return updateTasks(
        host,
        entries.map((entry) => entry.task),
      )
    } catch (error) {
      listRemoteDownloads()
      cache = cache!.map((task) =>
        task.hostId === hostId ? { ...task, speedBps: 0, connectionError: error instanceof Error ? error.message : String(error) } : task,
      )
      atomicWriteJson(cacheFile(), cache)
      for (const task of cache.filter((task) => task.hostId === hostId)) emit(Events.download, task)
      throw error
    }
  })
  polling.set(hostId, pending)
  try {
    return await pending
  } finally {
    polling.delete(hostId)
  }
}

export function startRemoteDownloadMonitor(): void {
  if (monitorStarted) return
  monitorStarted = true
  listRemoteDownloads()
  const poll = async (): Promise<void> => {
    await Promise.allSettled(
      listTrainingHosts(getSettings())
        .filter((host) => host.kind === 'ssh')
        .map((host) => refreshRemoteDownloads(host.id)),
    )
    setTimeout(() => {
      void poll()
    }, 3000).unref()
  }
  void poll()
}

export async function startRemoteDownload(
  host: TrainingHost,
  model: Pick<ModelEntry | AdapterEntry, 'id' | 'name' | 'repo' | 'revision' | 'files' | 'sizeBytes'>,
  kind: DownloadTask['kind'] = 'model',
): Promise<DownloadTask> {
  return serial(host, async () => {
    const task: DownloadTask = {
      id: `remote:${host.id}:${model.id}:${digest(`${host.modelsRoot || '~/.mossstudio/models'}:${model.repo}@${model.revision || 'main'}`).slice(0, 12)}`,
      hostId: host.id,
      hostName: host.name,
      kind,
      targetId: model.id,
      label: model.name,
      state: 'queued',
      bytes: 0,
      totalBytes: model.sizeBytes,
      speedBps: 0,
      filesDone: 0,
      filesTotal: 0,
      updatedAt: new Date().toISOString(),
    }
    const entries = await worker(host)
    let entry = entries.find((item) => item.task.id === task.id)
    if (entry && ['running', 'verifying', 'queued'].includes(entry.task.state) && entry.desired === 'running') {
      prepare(host, entry)
      updateTasks(
        host,
        entries.map((item) => item.task),
      )
      startRemoteDownloadMonitor()
      return entry.task
    }
    entry ??= {
      name: `task-${digest(task.id)}`,
      task,
      meta: {
        task,
        repo: model.repo,
        revision: model.revision || 'main',
        files: model.files,
        modelsRoot: host.modelsRoot || '~/.mossstudio/models',
      },
      generation: 0,
      desired: 'running',
      legacy: false,
    }
    const updated = await worker(host, persist(entry, 'running', networkFor(host).endpoint))
    for (const item of updated) prepare(host, item)
    const tasks = updateTasks(
      host,
      updated.map((item) => item.task),
    )
    startRemoteDownloadMonitor()
    return tasks.find((item) => item.id === task.id)!
  })
}

export async function controlRemoteDownload(
  hostId: string,
  taskId: string,
  operation: 'pause' | 'resume' | 'cancel',
): Promise<DownloadTask[]> {
  const host = getTrainingHost(getSettings(), hostId)
  if (!host || host.kind !== 'ssh') throw new Error('远端设备不存在')
  return serial(host, async () => {
    const entry = (await worker(host)).find((item) => item.task.id === taskId)
    if (!entry) throw new Error('远端下载任务不存在')
    const desired = { pause: 'paused', resume: 'running', cancel: 'canceled' }[operation]
    const entries = await worker(host, persist(entry, desired, networkFor(host).endpoint))
    for (const item of entries) prepare(host, item)
    startRemoteDownloadMonitor()
    return updateTasks(
      host,
      entries.map((item) => item.task),
    )
  })
}

export async function queryRemoteHf(
  hostId: string,
  url: string,
  endpoint?: string,
  token?: string,
): Promise<{ body: string; headers: Record<string, string> }> {
  const host = getTrainingHost(getSettings(), hostId)
  if (!host || host.kind !== 'ssh') throw new Error('HF 查询回退设备不存在')
  const network = networkFor(host)
  const base = endpoint?.replace(/\/+$/, '')
  if (base && !host.hfEndpoint) network.endpoint = base
  if (base && !url.startsWith(base + '/')) throw new Error('HF 查询地址无效')
  const remoteUrl = base ? network.endpoint + url.slice(base.length) : url
  if (token && !getHfToken(host.id)) network.token = token
  const result = await remoteHttp(host, remoteUrl, network)
  if (base && result.headers.link) result.headers.link = result.headers.link.split(network.endpoint).join(base)
  return result
}
