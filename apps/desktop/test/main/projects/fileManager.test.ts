import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn, default: { spawn } }))

import { shell } from 'electron'
import { openDirectoryInFileManager, revealInFileManager } from '@main/lib/fileManager'

const realPlatform = process.platform
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}
afterEach(() => setPlatform(realPlatform))

/** A child process that prints `stdout` and exits with `code` on the next tick. */
function fakeChild(code: number | null, stdout = '', stderr = ''): EventEmitter {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  setImmediate(() => {
    child.stdout.end(stdout)
    child.stderr.end(stderr)
    setImmediate(() => child.emit('close', code))
  })
  return child
}

function decodedScript(): string {
  const args = spawn.mock.calls.at(-1)![1] as string[]
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le')
}

describe('fileManager on POSIX', () => {
  beforeEach(() => setPlatform('linux'))

  it('opens a directory through shell.openPath', async () => {
    const open = vi.spyOn(shell, 'openPath').mockResolvedValue('')
    await openDirectoryInFileManager('/data/models')
    expect(open).toHaveBeenCalledWith('/data/models')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('surfaces the shell.openPath error string', async () => {
    vi.spyOn(shell, 'openPath').mockResolvedValue('No application')
    await expect(openDirectoryInFileManager('/x')).rejects.toThrow('无法打开目录：No application')
  })

  it('reveals a file with showItemInFolder', async () => {
    const reveal = vi.spyOn(shell, 'showItemInFolder').mockImplementation(() => undefined)
    await revealInFileManager('/data/a.png')
    expect(reveal).toHaveBeenCalledWith('/data/a.png')
  })
})

describe('fileManager on Windows', () => {
  beforeEach(() => {
    setPlatform('win32')
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    spawn.mockReset()
  })

  it('opens a directory through a hidden PowerShell with the path as a quoted literal', async () => {
    spawn.mockImplementation(() => fakeChild(0))
    await openDirectoryInFileManager("C:\\Users\\o'neil\\models")
    const [executable, args, options] = spawn.mock.calls[0]!
    expect(executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']))
    expect(options).toMatchObject({ windowsHide: true })
    const script = decodedScript()
    expect(script).toContain("$target = 'C:\\Users\\o''neil\\models'")
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
  })

  it('falls back to powershell.exe on PATH when SystemRoot is unset', async () => {
    vi.stubEnv('SystemRoot', '')
    spawn.mockImplementation(() => fakeChild(0))
    await openDirectoryInFileManager('C:\\x')
    expect(spawn.mock.calls[0]![0]).toBe('powershell.exe')
  })

  it('reveals a file through explorer /select', async () => {
    spawn.mockImplementation(() => fakeChild(0))
    await revealInFileManager('C:\\out\\a.png')
    expect(decodedScript()).toContain(`'C:\\Windows\\explorer.exe', '/select,"C:\\out\\a.png"'`)
  })

  it('reports the PowerShell error marker, else stderr, else the exit code', async () => {
    spawn.mockImplementationOnce(() => fakeChild(1, 'noise\nMOSSSTUDIO_ERROR: Access denied \n'))
    await expect(openDirectoryInFileManager('C:\\x')).rejects.toThrow(/^Access denied$/)
    spawn.mockImplementationOnce(() => fakeChild(1, '', ' boom '))
    await expect(openDirectoryInFileManager('C:\\x')).rejects.toThrow(/^boom$/)
    spawn.mockImplementationOnce(() => fakeChild(5))
    await expect(openDirectoryInFileManager('C:\\x')).rejects.toThrow('退出码 5')
    spawn.mockImplementationOnce(() => fakeChild(null))
    await expect(openDirectoryInFileManager('C:\\x')).rejects.toThrow('退出码 unknown')
  })

  it('rejects when PowerShell cannot be spawned', async () => {
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      setImmediate(() => child.emit('error', new Error('ENOENT powershell')))
      return child
    })
    await expect(openDirectoryInFileManager('C:\\x')).rejects.toThrow('ENOENT powershell')
  })
})
