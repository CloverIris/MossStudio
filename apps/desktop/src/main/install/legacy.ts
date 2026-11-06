/**
 * Old 1.0.x installs: one folder with the Electron files at the top level and the
 * user's data in `data\`. Found through the old HKCU Uninstall key's InstallLocation,
 * the old default folder, or a folder the user points at.
 *
 * Filesystem helpers use the host's own path rules (they only ever run on that host).
 *
 * In-place conversion removes ONLY the known old program files at the top level and
 * never `data` (or anything else). The files are first moved into a staging folder
 * inside the same root, so a locked file (1.0.x still running) aborts the conversion
 * with everything put back; the staging folder is deleted once the install succeeded.
 */
// original-fs: the old program folder holds resources/app.asar, a file, not a folder.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, promises as fsp, readdirSync, renameSync, rmSync, rmdirSync } from 'original-fs'
import { join } from 'node:path'
import { codedError } from '../lib/codedError'
import { PORTABLE_FILE, RECORD_FILE, defaultInstallRoot, type HostInfo, type OsPlatform } from './layout'
import { readKey, type Registry } from './registry'

/** kept: not a 1.0.x install but data a keep-data uninstall left behind (see keptDataInstall). */
export type LegacySource = 'registry' | 'default' | 'picked' | 'kept'

export interface LegacyInstall {
  root: string
  dataDir: string
  /** Bytes in data\; null while unknown. */
  dataBytes: number | null
  /** DisplayVersion from the old Uninstall key, when it had one. */
  version: string | null
  source: LegacySource
}

const OLD_EXECUTABLES = ['MossStudio.exe', 'MossStudio']

/** A 1.0.x layout: the app executable, resources/app.asar and data/, and no v2 install.json. */
export function isLegacyRoot(_platform: OsPlatform, dir: string): boolean {
  try {
    if (existsSync(join(dir, RECORD_FILE)) || existsSync(join(dir, PORTABLE_FILE))) return false
    const exe = OLD_EXECUTABLES.some((name) => existsSync(join(dir, name)) && lstatSync(join(dir, name)).isFile())
    return exe && existsSync(join(dir, 'resources', 'app.asar')) && lstatSync(join(dir, 'data')).isDirectory()
  } catch {
    return false
  }
}

/**
 * The exact top-level files an Electron 1.0.x build shipped (Windows and Linux, Electron
 * 28–44), plus the old Setup. No globs: a user's own foo.dll or LICENSE.txt stays.
 */
const FILE_NAMES = new Set([
  'mossstudio.exe', 'mossstudio', 'mossstudio-setup.exe', 'version', 'license', 'licenses.chromium.html',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'libegl.dll', 'libglesv2.dll', 'vk_swiftshader.dll', 'vulkan-1.dll',
  'vk_swiftshader_icd.json',
  'chrome-sandbox', 'chrome_crashpad_handler', 'libegl.so', 'libglesv2.so', 'libffmpeg.so', 'libvk_swiftshader.so', 'libvulkan.so.1',
])
const DIR_NAMES = new Set(['locales', 'resources', 'swiftshader'])
/** Never touched by conversion, whatever their type. */
const PROTECTED = new Set(['data', RECORD_FILE, PORTABLE_FILE])

/** Top-level names in `dir` that are known old 1.0.x program files (exact names only). */
export function legacyProgramEntries(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const lower = name.toLowerCase()
    if (PROTECTED.has(lower) || lower.startsWith('app-')) continue
    let stats
    try {
      stats = lstatSync(join(dir, name))
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (DIR_NAMES.has(lower)) found.push(name)
    } else if (stats.isFile() || stats.isSymbolicLink()) {
      if (FILE_NAMES.has(lower)) found.push(name)
    }
  }
  return found.sort()
}

function assertNotRunning(path: string, name: string): void {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r+')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'ETXTBSY' || code === 'EPERM') {
      throw codedError('E_LEGACY_IN_USE', `旧版 MossStudio 正在运行（${name}）。请先退出旧版 MossStudio，再继续安装。`)
    }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export interface StagedConversion {
  stageDir: string
  moved: string[]
  /** Put every moved entry back (install failed). */
  restore(): void
  /** Delete the staged old files (install succeeded). Best effort. */
  commit(): void
}

/** Move the old program files of `dir` into `<dir>/.moss-legacy-<stamp>`. Throws E_LEGACY_IN_USE if one is locked. */
export function stageLegacyProgramFiles(dir: string, stamp = Date.now().toString(36)): StagedConversion {
  // Only a real 1.0.x root (exe + resources/app.asar + data/, no v2 record) is converted.
  if (!isLegacyRoot(process.platform === 'win32' ? 'win32' : 'linux', dir)) {
    throw codedError('E_NOT_LEGACY', '这个文件夹不是旧版 MossStudio 的安装目录，不会删除其中的文件。')
  }
  const stageDir = join(dir, `.moss-legacy-${stamp}`)
  const names = legacyProgramEntries(dir)
  // A running exe (and its DLLs) can still be renamed on Windows, so probe for a write lock first.
  for (const name of names) {
    if (/\.(exe|dll)$/i.test(name) || name === 'MossStudio') assertNotRunning(join(dir, name), name)
  }
  mkdirSync(stageDir, { recursive: true })
  const moved: string[] = []
  const restore = (): void => {
    for (const name of [...moved].reverse()) {
      try {
        renameSync(join(stageDir, name), join(dir, name))
      } catch {
        // left in the staging folder; reported by the caller's log
      }
    }
    moved.length = 0
    try {
      rmdirSync(stageDir)
    } catch {
      // not empty: something could not be restored
    }
  }
  for (const name of names) {
    try {
      renameSync(join(dir, name), join(stageDir, name))
      moved.push(name)
    } catch {
      restore()
      throw codedError('E_LEGACY_IN_USE', `旧版 MossStudio 的文件正在使用（${name}）。请先退出旧版 MossStudio，再继续安装。`)
    }
  }
  return {
    stageDir,
    moved,
    restore,
    commit: () => {
      try {
        rmSync(stageDir, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        // Left behind; ownedRootEntries lists .moss-legacy-* so the uninstall plan removes it.
      }
    },
  }
}

/** Total bytes of regular files under `dir` (symlinks are not followed). */
export async function directorySize(dir: string): Promise<number> {
  let total = 0
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop()!
    let names: string[]
    try {
      names = await fsp.readdir(current)
    } catch {
      continue
    }
    const stats = await Promise.all(names.map(async (name) => {
      const path = join(current, name)
      try {
        return { path, stats: await fsp.lstat(path) }
      } catch {
        return null
      }
    }))
    for (const item of stats) {
      if (!item) continue
      if (item.stats.isDirectory()) pending.push(item.path)
      else if (item.stats.isFile()) total += item.stats.size
    }
  }
  return total
}

export function legacyAt(platform: OsPlatform, dir: string, source: LegacySource, version: string | null = null): LegacyInstall | null {
  if (!isLegacyRoot(platform, dir)) return null
  return { root: dir, dataDir: join(dir, 'data'), dataBytes: null, version, source }
}

export interface FindLegacyOptions {
  host: HostInfo
  /** Windows only. */
  registry?: Registry | null
}

/** The old install: registry InstallLocation first (Windows), then the old default folder. */
export async function findLegacyInstall(options: FindLegacyOptions): Promise<LegacyInstall | null> {
  const { host } = options
  if (host.platform === 'win32' && options.registry) {
    const values = await readKey(options.registry)
    const location = values?.['InstallLocation']?.trim().replace(/^"|"$/g, '')
    if (location) {
      const found = legacyAt(host.platform, location, 'registry', values?.['DisplayVersion'] ?? null)
      if (found) return found
    }
  }
  if (host.platform === 'darwin') return null
  return legacyAt(host.platform, defaultInstallRoot(host), 'default')
}
