import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deleteKey, parseRegExport, readKey, uninstallValues, writeUninstallKey, type ExecFile } from '@main/install/registry'

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MossStudio'
const env = { SystemRoot: 'C:\\Windows' }
const REG = 'C:\\Windows\\System32\\reg.exe'

function recorder(code = 0, onCall?: (args: string[]) => void): { exec: ExecFile; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = []
  return {
    calls,
    exec: async (file, args) => {
      calls.push({ file, args: [...args] })
      onCall?.(args)
      return { code, stdout: '', stderr: code ? 'ERROR: Access is denied.' : '' }
    },
  }
}

const entry = {
  root: 'C:\\Users\\张 三\\AppData\\Local\\Programs\\MossStudio',
  launcher: 'C:\\Users\\张 三\\AppData\\Local\\Programs\\MossStudio\\MossStudio.exe',
  version: '2.0.0',
  sizeBytes: 300 * 1024 * 1024,
}

describe('uninstall key', () => {
  it('has every value Apps & Features needs', () => {
    const values = Object.fromEntries(uninstallValues(entry).map((value) => [value.name, value]))
    expect(values['DisplayName']?.data).toBe('MossStudio')
    expect(values['DisplayVersion']?.data).toBe('2.0.0')
    expect(values['Publisher']?.data).toBe('CloverIris')
    expect(values['InstallLocation']?.data).toBe(entry.root)
    expect(values['DisplayIcon']?.data).toBe(`${entry.launcher},0`)
    expect(values['UninstallString']?.data).toBe(`"${entry.launcher}" --uninstall`)
    expect(values['QuietUninstallString']?.data).toBe(`"${entry.launcher}" --uninstall --moss-silent`)
    expect(values['EstimatedSize']).toEqual({ name: 'EstimatedSize', type: 'REG_DWORD', data: String(300 * 1024) })
    expect(values['NoModify']).toEqual({ name: 'NoModify', type: 'REG_DWORD', data: '1' })
    expect(values['NoRepair']).toEqual({ name: 'NoRepair', type: 'REG_DWORD', data: '1' })
  })

  it('writes each value with an absolute reg.exe and an argument array (no shell, no quoting)', async () => {
    const { exec, calls } = recorder()
    await writeUninstallKey({ exec, env }, entry)
    expect(calls).toHaveLength(10)
    expect(calls.every((call) => call.file === REG)).toBe(true)
    expect(calls[0]!.args).toEqual(['add', KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'MossStudio', '/f'])
    expect(calls.find((call) => call.args[3] === 'UninstallString')!.args).toEqual([
      'add',
      KEY,
      '/v',
      'UninstallString',
      '/t',
      'REG_SZ',
      '/d',
      `"${entry.launcher}" --uninstall`,
      '/f',
    ])
    expect(calls.find((call) => call.args[3] === 'EstimatedSize')!.args).toEqual([
      'add',
      KEY,
      '/v',
      'EstimatedSize',
      '/t',
      'REG_DWORD',
      '/d',
      '307200',
      '/f',
    ])
  })

  it('throws with reg.exe’s message when a write fails', async () => {
    const { exec } = recorder(1)
    await expect(writeUninstallKey({ exec, env }, entry)).rejects.toThrow(/DisplayName.*Access is denied/)
  })

  it('deletes the key with reg delete /f', async () => {
    const { exec, calls } = recorder()
    expect(await deleteKey({ exec, env })).toBe(true)
    expect(calls).toEqual([{ file: REG, args: ['delete', KEY, '/f'] }])
  })
})

describe('reading the key', () => {
  const exported = [
    'Windows Registry Editor Version 5.00',
    '',
    `[${KEY}]`,
    '"DisplayName"="MossStudio"',
    '"InstallLocation"="C:\\\\Users\\\\张 三\\\\AppData\\\\Local\\\\Programs\\\\MossStudio"',
    '"DisplayVersion"="1.0.3"',
    '"Quoted"="say \\"hi\\""',
    '"NoModify"=dword:00000001',
    '',
  ].join('\r\n')

  it('parses a .reg export', () => {
    expect(parseRegExport(`\uFEFF${exported}`)).toEqual({
      DisplayName: 'MossStudio',
      InstallLocation: 'C:\\Users\\张 三\\AppData\\Local\\Programs\\MossStudio',
      DisplayVersion: '1.0.3',
      Quoted: 'say "hi"',
      NoModify: '1',
    })
  })

  it('exports to a temp file and decodes UTF-16 (Chinese paths survive)', async () => {
    const { exec, calls } = recorder(0, (args) => {
      if (args[0] === 'export') writeFileSync(args[2]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(exported, 'utf16le')]))
    })
    const values = await readKey({ exec, env })
    expect(calls[0]!.args.slice(0, 2)).toEqual(['export', KEY])
    expect(calls[0]!.args[3]).toBe('/y')
    expect(values?.['InstallLocation']).toBe('C:\\Users\\张 三\\AppData\\Local\\Programs\\MossStudio')
  })

  it('answers null when the key does not exist', async () => {
    const { exec } = recorder(1)
    expect(await readKey({ exec, env })).toBeNull()
  })
})
