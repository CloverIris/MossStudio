import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsFixture, sshHostFixture } from '@test/mocks/backend/fixtures'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = {
    written: [] as string[],
    write: (data: string) => {
      this.stdin.written.push(data)
      return true
    },
  }
  kill = vi.fn(() => true)
}

const state = {
  children: [] as FakeChild[],
  hosts: [sshHostFixture({ id: 'ssh-a', name: 'A' }), { id: 'local', name: 'L', kind: 'local' }],
}
const emitted: Array<{ channel: string; payload: unknown }> = []
const spawn = vi.fn(() => {
  const child = new FakeChild()
  state.children.push(child)
  return child
})
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawn: (...args: unknown[]) => spawn(...(args as [])),
}))
vi.mock('@main/lib/events', () => ({ emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }) }))
vi.mock('@main/services/settings', () => ({ getSettings: () => settingsFixture() }))
vi.mock('@main/services/trainingHosts', () => ({
  getTrainingHost: (_settings: unknown, id: string) => state.hosts.find((host) => host.id === id),
}))
vi.mock('@main/services/ssh', () => ({
  sshCommand: () => 'ssh',
  sshEnv: () => ({ E: '1' }),
  sshTerminalArgs: () => ['-tt', 'moss@host', 'bash -l'],
}))

beforeEach(() => {
  vi.resetModules()
  state.children = []
  emitted.length = 0
  spawn.mockClear()
})
const load = () => import('@main/services/sshSessions')
const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('ssh terminal sessions', () => {
  it('rejects unknown and non-SSH hosts', async () => {
    const { openSshTerminal } = await load()
    expect(() => openSshTerminal('missing')).toThrow('SSH 主机不存在')
    expect(() => openSshTerminal('local')).toThrow('SSH 主机不存在')
  })

  it('spawns ssh once per live host session and buffers output', async () => {
    const { openSshTerminal, listSshTerminals, getSshTerminal } = await load()
    const session = openSshTerminal('ssh-a')
    expect(session).toMatchObject({ hostId: 'ssh-a', hostName: 'A', buffer: '' })
    expect(session.id).toMatch(/^tty-[0-9a-f]{8}$/)
    expect(spawn).toHaveBeenCalledWith('ssh', ['-tt', 'moss@host', 'bash -l'], expect.objectContaining({ env: { E: '1' } }))
    expect(openSshTerminal('ssh-a').id).toBe(session.id)
    expect(spawn).toHaveBeenCalledOnce()
    state.children[0]!.stdout.write('hello ')
    state.children[0]!.stderr.write('world')
    await tick()
    expect(getSshTerminal('ssh-a')!.buffer).toBe('hello world')
    expect(emitted.map((event) => event.payload)).toEqual([
      { sessionId: session.id, data: 'hello ' },
      { sessionId: session.id, data: 'world' },
    ])
    expect(listSshTerminals()).toHaveLength(1)
  })

  it('caps the buffer at 200k characters', async () => {
    const { openSshTerminal, getSshTerminal } = await load()
    openSshTerminal('ssh-a')
    state.children[0]!.stdout.write('a'.repeat(150_000))
    await tick()
    state.children[0]!.stdout.write('b'.repeat(100_000))
    await tick()
    const buffer = getSshTerminal('ssh-a')!.buffer
    expect(buffer).toHaveLength(200_000)
    expect(buffer.endsWith('b')).toBe(true)
  })

  it('forwards input, records exit and then refuses input and opens a new session', async () => {
    const { openSshTerminal, inputSshTerminal, getSshTerminal } = await load()
    const session = openSshTerminal('ssh-a')
    inputSshTerminal(session.id, 'ls\n')
    expect(state.children[0]!.stdin.written).toEqual(['ls\n'])
    state.children[0]!.emit('close', 0)
    expect(emitted.at(-1)).toEqual({ channel: 'event:ssh-terminal-exit', payload: { sessionId: session.id, code: 0 } })
    expect(() => inputSshTerminal(session.id, 'x')).toThrow('SSH 会话已结束')
    expect(() => inputSshTerminal('unknown', 'x')).toThrow('SSH 会话已结束')
    expect(getSshTerminal('ssh-a')).toBeUndefined()
    expect(openSshTerminal('ssh-a').id).not.toBe(session.id)
  })

  it('appends spawn errors to the buffer', async () => {
    const { openSshTerminal, listSshTerminals } = await load()
    openSshTerminal('ssh-a')
    state.children[0]!.emit('error', new Error('ENOENT ssh'))
    expect(listSshTerminals()[0]!.buffer).toContain('[ssh] Error: ENOENT ssh')
  })

  it('closes one or all sessions, tolerating kill failures', async () => {
    const { openSshTerminal, closeSshTerminal, closeAllSshTerminals, listSshTerminals } = await load()
    const session = openSshTerminal('ssh-a')
    closeSshTerminal('unknown')
    state.children[0]!.kill.mockImplementation(() => {
      throw new Error('gone')
    })
    expect(() => closeSshTerminal(session.id)).not.toThrow()
    expect(state.children[0]!.kill).toHaveBeenCalledWith('SIGTERM')
    closeAllSshTerminals()
    expect(listSshTerminals()).toEqual([])
  })
})
