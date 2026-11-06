import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn, default: { spawn } }))

import { probeEngine, requestEngineOnce, spawnEngineServer } from '@main/lib/probeEngine'

interface FakeProc extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  written: string[]
}

function fakeProc(): FakeProc {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    written: [] as string[],
  })
  proc.stdin.on('data', (chunk: Buffer) => proc.written.push(chunk.toString()))
  return proc
}

let proc: FakeProc
beforeEach(() => {
  proc = fakeProc()
  spawn.mockReset().mockImplementation(() => proc)
})

const hello = { id: 'probe', result: { protocol_version: 2, server: 'moss-server', version: '2.1.1', probe: { devices: [] } } }

describe('spawnEngineServer', () => {
  it('runs a native binary directly with piped stdio and a hidden window', () => {
    spawnEngineServer('/engine/bin/moss-server', ['--x'], { CUDA_VISIBLE_DEVICES: '1' })
    const [command, args, options] = spawn.mock.calls[0]!
    expect(command).toBe('/engine/bin/moss-server')
    expect(args).toEqual(['--x'])
    expect(options).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    expect(options.env.CUDA_VISIBLE_DEVICES).toBe('1')
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('runs a JavaScript fake server through the current runtime as Node', () => {
    spawnEngineServer('/tools/fake-moss-server.MJS')
    const [command, args, options] = spawn.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toEqual(['/tools/fake-moss-server.MJS'])
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('probeEngine', () => {
  it('sends hello with device enumeration and decodes the reply, then asks the server to exit', async () => {
    const pending = probeEngine('/engine/moss-server')
    proc.stdout.write('not json\n{"id":"other"}\n')
    proc.stdout.write(`${JSON.stringify(hello).slice(0, 20)}`)
    proc.stdout.write(`${JSON.stringify(hello).slice(20)}\r\n`)
    const result = await pending
    expect(result).toMatchObject({ protocol: 2, server: 'moss-server', version: '2.1.1' })
    const lines = proc.written
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({ id: 'probe', method: 'hello', params: { client: 'MossStudio', protocol_version: 2, devices: true } })
    expect(lines.at(-1)).toEqual({ id: 'bye', method: 'shutdown' })
  })

  it('rejects with the engine error message', async () => {
    const pending = probeEngine('/engine/moss-server')
    proc.stdout.write(`${JSON.stringify({ id: 'probe', error: { message: 'no CUDA device' } })}\n`)
    await expect(pending).rejects.toThrow('no CUDA device')
  })

  it('rejects when the server exits before hello', async () => {
    const pending = probeEngine('/engine/moss-server')
    proc.emit('close', 3)
    await expect(pending).rejects.toThrow('moss-server 退出 (code 3)，未完成 hello')
  })

  it('rejects when the binary cannot start', async () => {
    const pending = probeEngine('/engine/moss-server')
    proc.emit('error', new Error('spawn EACCES'))
    await expect(pending).rejects.toThrow('spawn EACCES')
  })

  it('times out and still kills the process later', async () => {
    vi.useFakeTimers()
    try {
      const pending = probeEngine('/engine/moss-server', { timeoutMs: 100 })
      const assertion = expect(pending).rejects.toThrow('moss-server hello 超时')
      await vi.advanceTimersByTimeAsync(100)
      await assertion
      expect(proc.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2000)
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a reply that is not a valid hello', async () => {
    const pending = probeEngine('/engine/moss-server')
    proc.stdout.write(`${JSON.stringify({ id: 'probe', result: { server: 'x' } })}\n`)
    await expect(pending).rejects.toThrow(/protocol_version/)
  })

  it('passes extra environment to the server', async () => {
    const pending = probeEngine('/engine/moss-server', { env: { CUDA_VISIBLE_DEVICES: '0' } })
    proc.stdout.write(`${JSON.stringify(hello)}\n`)
    await pending
    expect(spawn.mock.calls[0]![2].env.CUDA_VISIBLE_DEVICES).toBe('0')
  })
})

describe('requestEngineOnce', () => {
  const answer = (message: Record<string, unknown>): void => {
    proc.stdout.write(`${JSON.stringify(message)}\n`)
  }

  it('sends hello then the request, answers with both, then asks the server to exit', async () => {
    const pending = requestEngineOnce('/engine/moss-server', 'inspect', { path: '/m/c.safetensors' })
    answer({ id: 'once-hello', result: { protocol_version: 2, capabilities: { inspect: true } } })
    answer({ event: 'log', message: 'noise' })
    answer({ id: 'once-request', result: { kind: 'control_adapter' } })
    const { hello, result } = await pending
    expect(hello.capabilities).toEqual({ inspect: true })
    expect(result).toEqual({ kind: 'control_adapter' })
    const lines = proc.written
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map((line) => [line['id'], line['method']])).toEqual([
      ['once-hello', 'hello'],
      ['once-request', 'inspect'],
      ['bye', 'shutdown'],
    ])
    expect(lines[1]!['params']).toEqual({ path: '/m/c.safetensors' })
  })

  it('rejects with the request error as code: message', async () => {
    const pending = requestEngineOnce('/engine/moss-server', 'inspect', { path: '/missing' })
    answer({ id: 'once-hello', result: { protocol_version: 2 } })
    answer({ id: 'once-request', error: { code: 'io', message: 'cannot open /missing' } })
    await expect(pending).rejects.toThrow('io: cannot open /missing')
  })

  it('rejects when the server exits first', async () => {
    const pending = requestEngineOnce('/engine/moss-server', 'inspect', { path: '/x' })
    proc.emit('close', 127)
    await expect(pending).rejects.toThrow('code 127')
  })
})
