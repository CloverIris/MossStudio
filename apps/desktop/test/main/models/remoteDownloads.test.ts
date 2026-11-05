import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import type { DownloadTask, TrainingHost } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'

const sshExec = vi.hoisted(() => vi.fn())
const hosts = vi.hoisted(() => ({ list: [] as TrainingHost[] }))
const updateTrainingHostModelPath = vi.hoisted(() => vi.fn())
vi.mock('@main/services/ssh', () => ({
  posixQuote: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
  sshExec,
}))
vi.mock('@main/services/trainingHosts', () => ({
  getTrainingHost: (_settings: unknown, id: string) => hosts.list.find((host) => host.id === id),
  listTrainingHosts: () => hosts.list,
  updateTrainingHostModelPath,
}))

const dataRoot = useTempDataRoot()
type Remote = typeof import('@main/services/remoteDownloads')
let remote: Remote
let emitted: Array<{ channel: string; payload: unknown }>

const host: TrainingHost = {
  id: 'gpu', name: 'GPU box', kind: 'ssh', host: 'h', user: 'u', trainerRoot: '~/t', status: 'ok',
  hfEndpoint: 'https://hf.example/', downloadProxy: 'http://user:pw@proxy.example:3128',
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const b64 = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64')
const ok = (stdout = ''): { code: number; stdout: string; stderr: string; timedOut: boolean } => ({ code: 0, stdout, stderr: '', timedOut: false })

function task(id: string, patch: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id, kind: 'model', targetId: 'm', label: 'Model', state: 'queued', filesTotal: 0, filesDone: 0,
    bytes: 0, totalBytes: 100, speedBps: 0, updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
  }
}

const manifest = {
  sha: 'a'.repeat(40), path: '/home/u/m/hf/hub/models--org--m/snapshots/' + 'a'.repeat(40), cache: '/home/u/m/hf/hub/models--org--m',
  files: [{ path: 'w.safetensors', size: 60, oid: null }, { path: 'config.json', size: 40, oid: null }],
}

/** One `NATIVE` row as the remote worker's `list` prints it. */
function native(
  t: DownloadTask,
  state: { generation?: number; desired?: string; stateGeneration?: number; state?: string; bytes?: number; speed?: number; filesDone?: number; current?: string; error?: string; timestamp?: number; manifest?: boolean } = {},
): string {
  const meta = { task: t, repo: 'org/m', revision: 'main', modelsRoot: '~/m', ...(state.manifest === false ? {} : { manifest }) }
  const generation = state.generation ?? 1
  return [
    'NATIVE', `task-${digest(t.id)}`, b64(meta), String(generation), state.desired ?? 'running',
    String(state.stateGeneration ?? generation), state.state ?? 'running', String(state.bytes ?? 50), String(state.speed ?? 10),
    String(state.filesDone ?? 1), state.current ? b64(state.current) : '-', state.error ? b64(state.error) : '-', String(state.timestamp ?? 1_767_225_600),
  ].join('\t')
}

beforeEach(async () => {
  vi.resetModules()
  sshExec.mockReset()
  updateTrainingHostModelPath.mockReset()
  hosts.list = [host, { ...host, id: 'local', kind: 'local' }]
  remote = await import('@main/services/remoteDownloads')
  const { onEmit } = await import('@main/lib/events')
  emitted = []
  onEmit((channel, payload) => emitted.push({ channel, payload }))
})

afterEach(async () => {
  // start/control kick off the background monitor; let its first poll finish inside
  // this test and leave later polls (3 s, unref'd) with no SSH hosts to talk to.
  await new Promise((resolve) => setTimeout(resolve, 10))
  hosts.list = []
})

/** Deploy succeeds, then the worker `list` prints `rows`. */
function workerPrints(rows: string[]): void {
  sshExec.mockImplementation(async (_host: unknown, _command: string, _timeout: number, script: string) =>
    ok(script.includes(' list\n') ? `${rows.join('\n')}\n` : ''))
}

describe('listRemoteDownloads', () => {
  it('restores the last snapshot, marks active tasks as reconnecting and hides canceled ones', () => {
    writeFileSync(join(dataRoot(), 'remote-downloads.json'), JSON.stringify([
      task('r1', { state: 'running', speedBps: 99 }),
      task('r2', { state: 'done' }),
      task('r3', { state: 'canceled' }),
    ]))
    const list = remote.listRemoteDownloads()
    expect(list.map((t) => [t.id, t.state, t.speedBps, Boolean(t.connectionError)])).toEqual([
      ['r1', 'running', 0, true],
      ['r2', 'done', 0, false],
    ])
  })

  it('is empty without a snapshot file or with a corrupt one', () => {
    expect(remote.listRemoteDownloads()).toEqual([])
  })
})

describe('refreshRemoteDownloads', () => {
  it('rejects unknown and non-SSH hosts', async () => {
    await expect(remote.refreshRemoteDownloads('nope')).rejects.toThrow('远端设备不存在')
    await expect(remote.refreshRemoteDownloads('local')).rejects.toThrow('远端设备不存在')
    expect(sshExec).not.toHaveBeenCalled()
  })

  it('parses the worker snapshot into tasks, persists and emits them', async () => {
    const id = 'remote:gpu:m:abc'
    workerPrints([
      native(task(id), { current: 'w.safetensors', bytes: 55, speed: 12, filesDone: 1 }),
      'garbage line',
      `NATIVE\ttask-${'0'.repeat(64)}\t${b64({ task: task('other') })}`,
    ])
    const tasks = await remote.refreshRemoteDownloads('gpu')
    expect(tasks).toEqual([{
      ...task(id), hostId: 'gpu', hostName: 'GPU box', connectionError: undefined,
      state: 'running', bytes: 55, speedBps: 12, filesDone: 1, currentFile: 'w.safetensors', error: undefined,
      remotePath: manifest.path, revision: manifest.sha, totalBytes: 100, filesTotal: 2,
      updatedAt: new Date(1_767_225_600_000).toISOString(),
    }])
    expect(JSON.parse(readFileSync(join(dataRoot(), 'remote-downloads.json'), 'utf8'))).toHaveLength(1)
    expect(emitted.filter((e) => e.channel === Events.download)).toHaveLength(1)

    // An identical snapshot is not re-emitted.
    await remote.refreshRemoteDownloads('gpu')
    expect(emitted.filter((e) => e.channel === Events.download)).toHaveLength(1)
  })

  it('a stale state generation falls back to the stored task progress as queued', async () => {
    const id = 'remote:gpu:m:stale'
    workerPrints([native(task(id, { bytes: 7, filesDone: 0 }), { generation: 3, stateGeneration: 2, state: 'running', bytes: 99 })])
    const [parsed] = await remote.refreshRemoteDownloads('gpu')
    expect(parsed).toMatchObject({ state: 'queued', bytes: 7, speedBps: 0, filesDone: 0, currentFile: undefined, updatedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('a paused or canceled desire wins over the worker state and zeroes the speed', async () => {
    workerPrints([
      native(task('remote:gpu:a:1'), { desired: 'paused', state: 'running', speed: 50 }),
      native(task('remote:gpu:b:1'), { desired: 'canceled', state: 'running', speed: 50 }),
      native(task('remote:gpu:c:1'), { state: 'verifying', speed: 50 }),
    ])
    const tasks = await remote.refreshRemoteDownloads('gpu')
    expect(tasks.map((t) => [t.state, t.speedBps])).toEqual([['paused', 0], ['canceled', 0], ['verifying', 0]])
    expect(remote.listRemoteDownloads().map((t) => t.id)).toEqual(['remote:gpu:a:1', 'remote:gpu:c:1'])
  })

  it('parses legacy rows with their control file', async () => {
    const id = 'remote:gpu:legacy:1'
    const request = { task: task(id), repo: 'org/m', revision: 'main', modelsRoot: '~/m' }
    const row = (control: unknown, state = 'running'): string =>
      ['LEGACY', `task-${digest(id)}`, b64({ ...task(id, { state: state as DownloadTask['state'], speedBps: 5 }), generation: 1 }), b64(request), '-', control === null ? '-' : b64(control)].join('\t')
    workerPrints([row({ desired: 'paused', generation: 1 })])
    expect((await remote.refreshRemoteDownloads('gpu'))[0]).toMatchObject({ state: 'paused', speedBps: 0 })
    workerPrints([row({ desired: 'running', generation: 1 }, 'done')])
    expect((await remote.refreshRemoteDownloads('gpu'))[0]).toMatchObject({ state: 'done' })
  })

  it('records the remote path of a finished default model on the host', async () => {
    const id = 'remote:gpu:default-sft:1'
    workerPrints([native(task(id, { targetId: 'default-sft' }), { state: 'done' })])
    await remote.refreshRemoteDownloads('gpu')
    expect(updateTrainingHostModelPath).toHaveBeenCalledWith('gpu', manifest.path)
    expect(emitted.some((e) => e.channel === Events.hostsChanged)).toBe(true)
  })

  it('keeps the last snapshot with a connection error and redacts credentials when SSH fails', async () => {
    const id = 'remote:gpu:m:1'
    workerPrints([native(task(id))])
    await remote.refreshRemoteDownloads('gpu')
    sshExec.mockResolvedValue({ code: 1, stdout: '', stderr: `curl: proxy http://user:pw@proxy.example:3128 refused`, timedOut: false })
    const error = await remote.refreshRemoteDownloads('gpu').catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('pw@')
    expect((error as Error).message).toContain('[redacted]')
    const [stored] = remote.listRemoteDownloads()
    expect(stored).toMatchObject({ id, speedBps: 0, connectionError: (error as Error).message })
  })

  it('reports an SSH timeout as a reconnect hint', async () => {
    sshExec.mockResolvedValue({ code: 124, stdout: '', stderr: '', timedOut: true })
    await expect(remote.refreshRemoteDownloads('gpu')).rejects.toThrow(/SSH 请求超时/)
  })

  it('sends scripts and credentials over stdin, never as SSH arguments', async () => {
    workerPrints([])
    await remote.refreshRemoteDownloads('gpu')
    for (const [, command, , script] of sshExec.mock.calls) {
      expect(command).toBe('bash -s')
      expect(String(script)).not.toContain('user:pw')
    }
    const scripts = sshExec.mock.calls.map((call) => String(call[3])).join('\n')
    expect(scripts).toContain(b64('proxy = "http://user:pw@proxy.example:3128"\nnoproxy = ""\n'))
  })

  it('deploys the worker once per host connection', async () => {
    workerPrints([])
    await remote.refreshRemoteDownloads('gpu')
    await remote.refreshRemoteDownloads('gpu')
    const deploys = sshExec.mock.calls.filter((call) => String(call[3]).includes('current-shell-worker'))
    expect(deploys).toHaveLength(1)
  })

  it('shares one in-flight poll between concurrent callers', async () => {
    workerPrints([])
    const [a, b] = [remote.refreshRemoteDownloads('gpu'), remote.refreshRemoteDownloads('gpu')]
    expect(await a).toBe(await b)
  })
})

describe('controlRemoteDownload', () => {
  it('rejects an unknown task', async () => {
    workerPrints([])
    await expect(remote.controlRemoteDownload('gpu', 'nope', 'pause')).rejects.toThrow('远端下载任务不存在')
  })

  it('writes the next generation and the desired state under the request lock', async () => {
    const id = 'remote:gpu:m:1'
    workerPrints([native(task(id), { generation: 4 })])
    await remote.controlRemoteDownload('gpu', id, 'pause')
    const script = String(sshExec.mock.calls.at(-1)![3])
    expect(script).toContain(`directory="$root/task-${digest(id)}"`)
    expect(script).toContain('flock -x 6')
    expect(script).toContain(b64('5 paused\n'))
  })
})

describe('queryRemoteHf', () => {
  function respond(headers: string, body: string): void {
    sshExec.mockResolvedValue(ok(`HEADERS\t${b64(headers)}\nBODY\t${b64(body)}\n`))
  }

  it('fetches through the host endpoint and maps pagination links back to the caller endpoint', async () => {
    respond(
      'HTTP/1.1 302 Found\r\nLocation: x\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\nLink: <https://hf.example/api/next>; rel="next"\r\n\r\n',
      '[1]',
    )
    const result = await remote.queryRemoteHf('gpu', 'https://mirror.local/api/models/a/b', 'https://mirror.local/')
    expect(result.body).toBe('[1]')
    expect(result.headers).toEqual({ 'content-type': 'application/json', link: '<https://mirror.local/api/next>; rel="next"' })
    expect(String(sshExec.mock.calls[0]![3])).toContain(`--url 'https://hf.example/api/models/a/b'`)
  })

  it('rejects URLs outside the given endpoint and unknown hosts', async () => {
    await expect(remote.queryRemoteHf('gpu', 'https://evil.example/x', 'https://mirror.local')).rejects.toThrow('HF 查询地址无效')
    await expect(remote.queryRemoteHf('gpu', 'https://evil.example/x')).rejects.toThrow('HF 查询地址必须使用配置的 endpoint')
    await expect(remote.queryRemoteHf('nope', 'https://hf.example/x')).rejects.toThrow('HF 查询回退设备不存在')
    expect(sshExec).not.toHaveBeenCalled()
  })

  it('rejects a malformed or oversized remote response', async () => {
    sshExec.mockResolvedValue(ok('HEADERS\t-\n'))
    await expect(remote.queryRemoteHf('gpu', 'https://hf.example/api/x')).rejects.toThrow(/响应无效/)
  })
})

describe('startRemoteDownload', () => {
  it('creates a deterministic task id per host, root and revision and persists the request', async () => {
    let rows: string[] = []
    sshExec.mockImplementation(async (_h: unknown, _c: string, _t: number, script: string) => {
      const match = script.match(/shell-meta\.json"[^\n]*\n/)
      if (script.includes('shell-control') && match) {
        const meta = JSON.parse(Buffer.from(script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$directory\/shell-meta\.json/)![1]!, 'base64').toString())
        rows = [native(meta.task as DownloadTask, { manifest: false, state: 'queued', generation: 1, stateGeneration: 0 })]
      }
      return ok(script.includes(' list\n') ? `${rows.join('\n')}\n` : '')
    })
    const model = { id: 'm', name: 'Model', repo: 'org/m', revision: 'main', files: ['w.safetensors'], sizeBytes: 100 }
    const created = await remote.startRemoteDownload({ ...host, modelsRoot: '/data' }, model)
    expect(created.id).toBe(`remote:gpu:m:${digest('/data:org/m@main').slice(0, 12)}`)
    expect(created).toMatchObject({ hostId: 'gpu', state: 'queued', label: 'Model' })
    expect(existsSync(join(dataRoot(), 'remote-downloads.json'))).toBe(true)
  })

  it('rejects an invalid repository name before touching the host state', async () => {
    workerPrints([])
    await expect(
      remote.startRemoteDownload(host, { id: 'm', name: 'M', repo: 'not a repo', revision: 'main', sizeBytes: 0 }),
    ).rejects.toThrow('HF 仓库名称无效')
  })
})
