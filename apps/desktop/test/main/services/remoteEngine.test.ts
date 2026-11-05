import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobParams, TrainingHost } from '@shared/types'
import { useTempDir } from '@test/helpers/tempDir'

const spawn = vi.hoisted(() => vi.fn())
const sshExec = vi.hoisted(() => vi.fn())
const sshWriteFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn, default: { ...actual, spawn } }
})
vi.mock('@main/services/ssh', () => ({
  posixQuote: (value: string) => `'${value}'`,
  remoteAbsolute: async (_host: TrainingHost, path: string) => path.replace(/^~\//, '/home/me/'),
  sshArgs: (_host: TrainingHost, command: string) => [command],
  sshCommand: () => 'ssh',
  sshEnv: () => ({}),
  sshExec,
  sshWriteFile,
}))

const dir = useTempDir('mossstudio-remote-')
let remote: typeof import('@main/services/remoteEngine')

const host: TrainingHost = { id: 'h1', name: 'Lab', kind: 'ssh', host: 'gpu.lab', user: 'me', trainerRoot: '/t', engineRoot: '/opt/engine' } as TrainingHost

type Request = { id: string; method: string; params: Record<string, unknown> }

/** The remote moss-server, seen through the SSH child's stdio. */
class FakeSsh extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  requests: Request[] = []
  constructor(reply: (request: Request, child: FakeSsh) => void) {
    super()
    let buffer = ''
    this.stdin.on('data', (chunk: Buffer) => {
      const lines = (buffer + chunk.toString()).split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines.filter(Boolean)) {
        const request = JSON.parse(line) as Request
        this.requests.push(request)
        setImmediate(() => reply(request, this))
      }
    })
  }
  send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }
  kill(): boolean {
    // A real process closes after kill() returns.
    setImmediate(() => this.emit('close', null))
    return true
  }
}

const helloResult = { protocol_version: 2, version: '2.2.0', capabilities: { image_input: true, control: true, preview: true, references: true }, values: { sampler: ['euler'] } }

let child: FakeSsh
/** Replaces the default (instant ok) answer to generate, e.g. to keep a generation running. */
let onGenerate: ((request: Request, c: FakeSsh) => void) | null
/** Replaces the default answer to cancel. */
let onCancel: ((request: Request, c: FakeSsh) => void) | null

beforeEach(async () => {
  vi.resetModules()
  onGenerate = null
  onCancel = null
  spawn.mockReset().mockImplementation(() => {
    child = new FakeSsh((request, c) => {
      if (request.method === 'generate' && onGenerate) return onGenerate(request, c)
      if (request.method === 'cancel' && onCancel) return onCancel(request, c)
      if (request.method === 'generate') {
        c.send({ id: request.id, result: { accepted: true } })
        c.send({ event: 'done', id: request.id, status: 'ok', report: {} })
        return
      }
      c.send({ id: request.id, result: request.method === 'hello' ? helloResult : {} })
    })
    return child
  })
  sshExec.mockReset().mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false })
  sshWriteFile.mockReset().mockResolvedValue(undefined)
  remote = await import('@main/services/remoteEngine')
})

function picture(name: string, content = name): string {
  const path = join(dir(), name)
  writeFileSync(path, content)
  return path
}

const params: JobParams = { prompt: 'a cat', negativePrompt: '', width: 1024, height: 768, steps: 8, cfg: 1, seed: 3, profile: 'base' }

describe('uploadJobInputs', () => {
  it('uploads each input picture once into the job folder and points the params at the copies', async () => {
    const init = picture('init.png')
    const mask = picture('mask.png')
    const ref = picture('ref.jpg')
    const out = await remote.uploadJobInputs(host, {
      ...params,
      initImage: { path: init, strength: 0.5 },
      mask: { path: mask },
      references: { paths: [ref, init] },
    }, '/opt/engine/tmp/inputs-job-1')
    expect(sshWriteFile.mock.calls.map((call) => [call[1], String(call[2])])).toEqual([
      ['/opt/engine/tmp/inputs-job-1/1-init.png', 'init.png'],
      ['/opt/engine/tmp/inputs-job-1/2-mask.png', 'mask.png'],
      ['/opt/engine/tmp/inputs-job-1/3-reference.jpg', 'ref.jpg'],
    ])
    expect(out.initImage).toEqual({ path: '/opt/engine/tmp/inputs-job-1/1-init.png', strength: 0.5 })
    expect(out.mask).toEqual({ path: '/opt/engine/tmp/inputs-job-1/2-mask.png' })
    expect(out.references?.paths).toEqual(['/opt/engine/tmp/inputs-job-1/3-reference.jpg', '/opt/engine/tmp/inputs-job-1/1-init.png'])
  })

  it('does nothing for a job without pictures', async () => {
    expect(await remote.uploadJobInputs(host, params, '/x')).toBe(params)
    expect(sshWriteFile).not.toHaveBeenCalled()
  })

  it('names the folder after the job, safely', () => {
    expect(remote.remoteInputsDir('/opt/engine/', 'job-1')).toBe('/opt/engine/tmp/inputs-job-1')
    expect(remote.remoteInputsDir('/opt/engine', '../x y')).toBe('/opt/engine/tmp/inputs-___x_y')
  })
})

describe('runRemoteEngineJob', () => {
  it('uploads the inputs, generates from the uploaded copies, reports the hires size and removes the folder', async () => {
    const init = picture('init.png')
    sshExec.mockImplementation(async (_host: TrainingHost, command: string) => (
      command.startsWith('base64 <')
        ? { code: 0, stdout: Buffer.from('PNGDATA').toString('base64'), stderr: '', timedOut: false }
        : { code: 0, stdout: '', stderr: '', timedOut: false }
    ))
    const events: Array<Record<string, unknown>> = []
    const localOutput = join(dir(), 'out.png')
    const done = new Promise<number>((resolve) => {
      void remote.runRemoteEngineJob(host, {
        model: '/models/moss', output: '/home/me/out/x.png', localOutput, mode: 'balanced', tier: 'high', jobId: 'job-9',
        params: { ...params, initImage: { path: init, strength: 0.4 }, sampling: { hires: { width: 1536, height: 1152 } } },
      }, { event: (event) => events.push(event), stderr: () => undefined, done: resolve })
    })
    expect(await done).toBe(0)
    expect(sshWriteFile).toHaveBeenCalledWith(host, '/opt/engine/tmp/inputs-job-9/1-init.png', expect.anything())
    const generate = child.requests.find((request) => request.method === 'generate')!
    expect(generate.params).toMatchObject({ output: '/home/me/out/x.png', init_image: '/opt/engine/tmp/inputs-job-9/1-init.png', denoise_strength: 0.4, hires: { width: 1536, height: 1152 } })
    expect(events.find((event) => event['type'] === 'result')).toMatchObject({ images: [{ path: localOutput, width: 1536, height: 1152, seed: 3 }] })
    expect(readFileSync(localOutput, 'utf8')).toBe('PNGDATA')
    expect(sshExec).toHaveBeenCalledWith(host, "rm -rf '/opt/engine/tmp/inputs-job-9'", 30_000)
    // The job's hello is remembered: asking for the host's features needs no extra SSH round.
    sshExec.mockClear()
    expect((await remote.remoteEngineHello(host))?.version).toBe('2.2.0')
    expect(sshExec).not.toHaveBeenCalled()
  })

  it('removes the uploaded pictures when the job fails too, and skips the folder without inputs', async () => {
    const init = picture('init.png')
    sshWriteFile.mockRejectedValue(new Error('disk full'))
    const events: Array<Record<string, unknown>> = []
    const code = await new Promise<number>((resolve) => {
      void remote.runRemoteEngineJob(host, {
        model: '/m', output: '/o.png', localOutput: join(dir(), 'o.png'), mode: 'balanced', tier: 'high', jobId: 'job-f',
        params: { ...params, initImage: { path: init, strength: 0.4 } },
      }, { event: (event) => events.push(event), stderr: () => undefined, done: resolve })
    })
    expect(code).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'E_REMOTE', message: 'disk full' })
    expect(sshExec).toHaveBeenCalledWith(host, "rm -rf '/opt/engine/tmp/inputs-job-f'", 30_000)

    sshExec.mockClear()
    sshWriteFile.mockReset()
    await new Promise<number>((resolve) => {
      void remote.runRemoteEngineJob(host, {
        model: '/m', output: '/o.png', localOutput: join(dir(), 'o2.png'), mode: 'balanced', tier: 'high', jobId: 'job-plain', params,
      }, { event: () => undefined, stderr: () => undefined, done: resolve })
    })
    expect(sshExec.mock.calls.some((call) => String(call[1]).startsWith('rm -rf'))).toBe(false)
  })
})

describe('runRemoteEngineJob: ended during the upload', () => {
  it('stops uploading, never generates, and removes the folder again once the last write settled', async () => {
    const first = picture('init.png')
    const second = picture('ref.png')
    let releaseWrite: () => void = () => undefined
    sshWriteFile.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseWrite = resolve }))
    const code = new Promise<number>((resolve) => {
      void remote.runRemoteEngineJob(host, {
        model: '/m', output: '/o.png', localOutput: join(dir(), 'o.png'), mode: 'balanced', tier: 'high', jobId: 'job-c',
        params: { ...params, initImage: { path: first, strength: 0.4 }, references: { paths: [second] } },
      }, { event: () => undefined, stderr: () => undefined, done: resolve })
    })
    await vi.waitFor(() => expect(sshWriteFile).toHaveBeenCalledTimes(1))
    // The SSH session goes away (a cancel, a dropped link) while the first picture is on its way.
    child.emit('close', 255)
    expect(await code).toBe(255)
    const removals = () => sshExec.mock.calls.filter((call) => call[1] === "rm -rf '/opt/engine/tmp/inputs-job-c'").length
    expect(removals()).toBe(1)
    releaseWrite()
    await vi.waitFor(() => expect(removals()).toBe(2))
    expect(sshWriteFile).toHaveBeenCalledTimes(1)
    expect(child.requests.some((request) => request.method === 'generate')).toBe(false)
  })
})

describe('cancelRemoteEngineJob', () => {
  function start(jobId: string): { events: Array<Record<string, unknown>>; done: Promise<number> } {
    const events: Array<Record<string, unknown>> = []
    const done = new Promise<number>((resolve) => {
      void remote.runRemoteEngineJob(host, {
        model: '/m', output: '/o.png', localOutput: join(dir(), `${jobId}.png`), mode: 'balanced', tier: 'high', jobId, params,
      }, { event: (event) => events.push(event), stderr: () => undefined, done: resolve })
    })
    return { events, done }
  }
  const running = (request: Request, c: FakeSsh): void => {
    c.send({ id: request.id, result: { accepted: true } })
    c.send({ event: 'progress', id: request.id, phase: 'denoise', step: 2, total_steps: 8 })
  }

  it('sends the engine cancel for the running generation over its own session', async () => {
    onGenerate = running
    onCancel = (request, c) => {
      const generate = c.requests.find((item) => item.method === 'generate')!
      c.send({ id: request.id, result: { cancelling: true, generating_id: generate.id } })
      c.send({ event: 'done', id: generate.id, status: 'cancelled' })
    }
    const job = start('job-r1')
    await vi.waitFor(() => expect(job.events.some((event) => event['type'] === 'progress')).toBe(true))
    const killed = vi.spyOn(child, 'kill')
    expect(remote.cancelRemoteEngineJob('job-r1')).toBe(true)
    expect(await job.done).toBe(130)
    const generate = child.requests.find((request) => request.method === 'generate')!
    expect(child.requests.find((request) => request.method === 'cancel')).toMatchObject({ params: { id: generate.id } })
    expect(job.events.at(-1)).toEqual({ type: 'canceled', at_stage: 'denoise' })
    expect(killed).not.toHaveBeenCalled()
    // Ended jobs are forgotten.
    expect(remote.cancelRemoteEngineJob('job-r1')).toBe(false)
  })

  it('closes the session when the host does not confirm in time', async () => {
    onGenerate = running
    onCancel = () => undefined
    const job = start('job-r2')
    await vi.waitFor(() => expect(job.events.some((event) => event['type'] === 'progress')).toBe(true))
    const killed = vi.spyOn(child, 'kill')
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      remote.cancelRemoteEngineJob('job-r2')
      // A second cancel does not restart the wait.
      remote.cancelRemoteEngineJob('job-r2')
      await vi.advanceTimersByTimeAsync(remote.REMOTE_CANCEL_TIMEOUT_MS - 1)
      expect(killed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      vi.useRealTimers()
    }
    expect(killed).toHaveBeenCalledWith('SIGKILL')
    expect(await job.done).toBe(130)
    expect(job.events.filter((event) => event['type'] === 'canceled')).toEqual([{ type: 'canceled', at_stage: 'denoise' }])
    expect(job.events.some((event) => event['type'] === 'error')).toBe(false)
    expect(child.requests.filter((request) => request.method === 'cancel')).toHaveLength(1)
  })

  it('closes the session at once when nothing is generating yet, and cancels a job still connecting', async () => {
    let releaseMkdir: () => void = () => undefined
    sshExec.mockImplementationOnce(() => new Promise((resolve) => { releaseMkdir = () => resolve({ code: 0, stdout: '', stderr: '', timedOut: false }) }))
    const early = start('job-r3')
    await vi.waitFor(() => expect(sshExec).toHaveBeenCalled())
    expect(remote.cancelRemoteEngineJob('job-r3')).toBe(true)
    releaseMkdir()
    expect(await early.done).toBe(130)
    expect(early.events).toEqual([{ type: 'canceled', at_stage: 'idle' }])
    expect(spawn).not.toHaveBeenCalled()

    // Connected, the model still loading: no generate to cancel, so the session goes.
    spawn.mockImplementation(() => {
      child = new FakeSsh((request, c) => { if (request.method === 'hello') c.send({ id: request.id, result: helloResult }) })
      return child
    })
    const loading = start('job-r4')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(child.requests.some((request) => request.method === 'load')).toBe(true))
    const killed = vi.spyOn(child, 'kill')
    remote.cancelRemoteEngineJob('job-r4')
    expect(await loading.done).toBe(130)
    expect(killed).toHaveBeenCalledWith('SIGKILL')
    expect(child.requests.some((request) => request.method === 'cancel' || request.method === 'generate')).toBe(false)
    expect(loading.events.some((event) => event['type'] === 'error')).toBe(false)
  })

  it('knows nothing of other jobs', () => {
    expect(remote.cancelRemoteEngineJob('nope')).toBe(false)
  })
})

describe('remoteEngineHello', () => {
  it('retries a failed probe after 30 seconds, but keeps a good answer for 10 minutes', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    sshExec.mockResolvedValue({ code: 255, stdout: '', stderr: 'connection refused', timedOut: false })
    expect(await remote.remoteEngineHello(host)).toBeNull()
    now += 29_000
    expect(await remote.remoteEngineHello(host)).toBeNull()
    expect(sshExec).toHaveBeenCalledTimes(1)
    now += 2_000
    sshExec.mockResolvedValue({ code: 0, stdout: `${JSON.stringify({ id: 'probe', result: helloResult })}\n`, stderr: '', timedOut: false })
    expect((await remote.remoteEngineHello(host))?.version).toBe('2.2.0')
    expect(sshExec).toHaveBeenCalledTimes(2)
    now += 9 * 60_000
    expect((await remote.remoteEngineHello(host))?.version).toBe('2.2.0')
    expect(sshExec).toHaveBeenCalledTimes(2)
    now += 2 * 60_000
    await remote.remoteEngineHello(host)
    expect(sshExec).toHaveBeenCalledTimes(3)
  })

  it('asks the host once over SSH and caches the answer, failures included', async () => {
    sshExec.mockResolvedValue({ code: 0, stdout: `banner\n${JSON.stringify({ id: 'probe', result: helloResult })}\n{"id":"bye","result":{}}\n`, stderr: '', timedOut: false })
    const [a, b] = await Promise.all([remote.remoteEngineHello(host), remote.remoteEngineHello(host)])
    expect(a?.version).toBe('2.2.0')
    expect(b).toBe(a)
    expect(sshExec).toHaveBeenCalledTimes(1)
    expect(sshExec.mock.calls[0]![1]).toBe("cd '/opt/engine' && exec ./bin/moss-server")
    expect(String(sshExec.mock.calls[0]![3])).toContain('"method":"hello"')

    const other = { ...host, id: 'h2', host: 'off.lab' } as TrainingHost
    sshExec.mockResolvedValue({ code: 255, stdout: '', stderr: 'connection refused', timedOut: false })
    expect(await remote.remoteEngineHello(other)).toBeNull()
    expect(await remote.remoteEngineHello(other)).toBeNull()
    expect(sshExec).toHaveBeenCalledTimes(2)
  })
})
