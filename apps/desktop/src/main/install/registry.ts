/**
 * HKCU through reg.exe, always with an argument array (execFile, no shell). Writes use
 * `reg add` per value. Reads use `reg export` to a temp file, because the export is
 * UTF-16 while `reg query` prints in the console code page and garbles Chinese paths.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRODUCT_NAME, PUBLISHER, UNINSTALL_KEY, regExePath } from './layout'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs a program with arguments; never through a shell. Injected in tests. */
export type ExecFile = (file: string, args: string[]) => Promise<ExecResult>

export const execFileNoShell: ExecFile = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? '') })
    })
  })

export interface RegistryValue {
  name: string
  type: 'REG_SZ' | 'REG_DWORD'
  data: string
}

export interface UninstallEntry {
  root: string
  launcher: string
  version: string
  /** Bytes on disk of the installed program (not the data). */
  sizeBytes: number
}

function quoted(path: string): string {
  return `"${path}"`
}

/** The values of the HKCU Uninstall key for an install. */
export function uninstallValues(entry: UninstallEntry): RegistryValue[] {
  const location = entry.root.replace(/[\\/]+$/, '')
  return [
    { name: 'DisplayName', type: 'REG_SZ', data: PRODUCT_NAME },
    { name: 'DisplayVersion', type: 'REG_SZ', data: entry.version },
    { name: 'Publisher', type: 'REG_SZ', data: PUBLISHER },
    { name: 'InstallLocation', type: 'REG_SZ', data: location },
    { name: 'DisplayIcon', type: 'REG_SZ', data: `${entry.launcher},0` },
    { name: 'UninstallString', type: 'REG_SZ', data: `${quoted(entry.launcher)} --uninstall` },
    { name: 'QuietUninstallString', type: 'REG_SZ', data: `${quoted(entry.launcher)} --uninstall --moss-silent` },
    { name: 'EstimatedSize', type: 'REG_DWORD', data: String(Math.max(1, Math.ceil(entry.sizeBytes / 1024))) },
    { name: 'NoModify', type: 'REG_DWORD', data: '1' },
    { name: 'NoRepair', type: 'REG_DWORD', data: '1' },
  ]
}

export interface Registry {
  exec: ExecFile
  env: Record<string, string | undefined>
}

async function run(registry: Registry, args: string[]): Promise<ExecResult> {
  return registry.exec(regExePath(registry.env), args)
}

/** Write (create or overwrite) every value of the Uninstall key. */
export async function writeUninstallKey(registry: Registry, entry: UninstallEntry): Promise<void> {
  for (const value of uninstallValues(entry)) {
    const result = await run(registry, ['add', UNINSTALL_KEY, '/v', value.name, '/t', value.type, '/d', value.data, '/f'])
    if (result.code !== 0) throw new Error(`写入卸载信息失败（${value.name}）：${result.stderr.trim() || `reg.exe 退出码 ${result.code}`}`)
  }
}

export async function deleteKey(registry: Registry, key: string = UNINSTALL_KEY): Promise<boolean> {
  const result = await run(registry, ['delete', key, '/f'])
  return result.code === 0
}

/**
 * Parse a .reg export (REGEDIT5 text) into value name → string. Only REG_SZ ("…")
 * and dword values are decoded; others are skipped.
 */
export function parseRegExport(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  const unescape = (value: string): string => value.replace(/\\(["\\])/g, '$1')
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const sz = /^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"\s*$/.exec(line)
    if (sz) {
      values[unescape(sz[1]!)] = unescape(sz[2]!)
      continue
    }
    const dword = /^"((?:[^"\\]|\\.)*)"=dword:([0-9a-fA-F]{8})\s*$/.exec(line)
    if (dword) values[unescape(dword[1]!)] = String(parseInt(dword[2]!, 16))
  }
  return values
}

function decodeRegFile(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  return bytes.toString('utf8')
}

/** All string/dword values of `key`, or null when the key does not exist. */
export async function readKey(registry: Registry, key: string = UNINSTALL_KEY): Promise<Record<string, string> | null> {
  const dir = mkdtempSync(join(tmpdir(), 'moss-reg-'))
  try {
    const file = join(dir, 'export.reg')
    const result = await run(registry, ['export', key, file, '/y'])
    if (result.code !== 0) return null
    return parseRegExport(decodeRegFile(readFileSync(file)))
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
