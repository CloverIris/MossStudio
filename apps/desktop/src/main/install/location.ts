/**
 * Install and data location rules.
 *
 * Install location (Windows/Linux: R itself; macOS: the folder that holds MossStudio.app):
 *   refuse relative paths, drive and share roots, system folders, temp, the setup payload,
 *   and non-empty folders that are neither a MossStudio root, an old 1.0.x install nor a
 *   folder whose MossStudio data an uninstall kept (then offer <chosen>/MossStudio); require
 *   write access and enough free space.
 * Data location (macOS 高级): the same refusals; a non-empty folder must already be MossStudio data.
 *
 * `locationRule` is pure (string rules per platform); `checkInstallLocation` and
 * `checkDataLocation` add the filesystem checks on the real host.
 */
import { accessSync, constants, existsSync, lstatSync, readdirSync, rmSync, statfsSync, writeFileSync } from 'original-fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  BUNDLE_NAME,
  LOCATOR_FILE,
  PORTABLE_FILE,
  PRODUCT_NAME,
  RECORD_FILE,
  isWithin,
  pathFor,
  samePath,
  type HostInfo,
  type OsPlatform,
} from './layout'
import { portableMarkerSchema } from '@shared/install'
import { isLegacyRoot } from './legacy'
import { readInstallRecord, readJsonObject } from './record'

export type LocationCode =
  | 'E_NOT_ABSOLUTE'
  | 'E_DRIVE_ROOT'
  | 'E_SYSTEM_DIR'
  | 'E_TEMP_DIR'
  | 'E_IN_PAYLOAD'
  | 'E_NOT_DIRECTORY'
  | 'E_NOT_EMPTY'
  | 'E_NOT_WRITABLE'
  | 'E_NO_SPACE'
  | 'E_PORTABLE_ROOT'

/** What is at the location now. */
export type LocationKind = 'missing' | 'empty' | 'install' | 'legacy' | 'data' | 'occupied'

export interface LocationProblem {
  code: LocationCode
  message: string
}

export interface LocationCheck {
  /** Normalized absolute path that was checked. */
  path: string
  ok: boolean
  kind: LocationKind
  problem: LocationProblem | null
  /** A usable alternative, e.g. <chosen>/MossStudio for a non-empty folder. */
  suggestion: string | null
  /** Free bytes on that volume; null when unknown. */
  freeBytes: number | null
  requiredBytes: number
}

export interface LocationContext {
  host: HostInfo
  tempDir: string
  /** The setup payload (never install into it). */
  payloadDir?: string | null
  /** macOS: the DMG volume the setup runs from. */
  volume?: string | null
  requiredBytes: number
}

const MESSAGES: Record<LocationCode, string> = {
  E_NOT_ABSOLUTE: '请选择一个完整的文件夹路径。',
  E_DRIVE_ROOT: '不能直接装在磁盘根目录，请选择其中的一个文件夹。',
  E_SYSTEM_DIR: '这是系统文件夹，不能安装到这里。',
  E_TEMP_DIR: '临时文件夹会被系统清理，不能安装到这里。',
  E_IN_PAYLOAD: '不能安装到安装程序自己的临时文件夹。',
  E_NOT_DIRECTORY: '这个路径是一个文件，不是文件夹。',
  E_NOT_EMPTY: '这个文件夹里已经有其他文件。',
  E_NOT_WRITABLE: '没有写入这个文件夹的权限。',
  E_NO_SPACE: '磁盘空间不足。',
  E_PORTABLE_ROOT: '这是便携版 MossStudio 的文件夹。便携版在原地更新，不能把安装版装进去；请换一个位置。',
}

function problem(code: LocationCode, message = MESSAGES[code]): LocationProblem {
  return { code, message }
}

function env(host: HostInfo, ...names: string[]): string[] {
  return names.map((name) => host.env[name]?.trim()).filter((value): value is string => Boolean(value))
}

/** Folders that must not be R, nor contain R (`within`), or must not be R itself (`exact`). */
function systemFolders(host: HostInfo): { within: string[]; exact: string[] } {
  const p = pathFor(host.platform)
  if (host.platform === 'win32') {
    const windows = env(host, 'SystemRoot', 'windir')
    const drive = (windows[0] ?? 'C:\\Windows').slice(0, 2)
    return {
      within: [
        ...windows,
        `${drive}\\Windows`,
        ...env(host, 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData'),
        `${drive}\\Program Files`,
        `${drive}\\Program Files (x86)`,
        `${drive}\\ProgramData`,
        `${drive}\\$Recycle.Bin`,
        `${drive}\\System Volume Information`,
      ],
      exact: [
        `${drive}\\Users`,
        host.home,
        p.join(host.home, 'AppData'),
        p.join(host.home, 'AppData', 'Local'),
        p.join(host.home, 'AppData', 'Roaming'),
        p.join(host.home, 'AppData', 'Local', 'Programs'),
        p.join(host.home, 'Desktop'),
        p.join(host.home, 'Documents'),
        p.join(host.home, 'Downloads'),
        ...env(host, 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'PUBLIC'),
      ],
    }
  }
  if (host.platform === 'darwin') {
    return {
      within: ['/System', '/Library', '/usr', '/bin', '/sbin', '/private', '/etc', '/var', '/cores', '/dev', '/opt'],
      exact: ['/Volumes', '/Users', '/Applications/Utilities', p.join(host.home, 'Library')],
    }
  }
  return {
    within: [
      '/bin',
      '/boot',
      '/dev',
      '/etc',
      '/lib',
      '/lib32',
      '/lib64',
      '/libx32',
      '/proc',
      '/run',
      '/sbin',
      '/sys',
      '/usr',
      '/var',
      '/snap',
      '/lost+found',
    ],
    exact: [
      '/home',
      '/opt',
      '/mnt',
      '/media',
      '/srv',
      '/root',
      host.home,
      p.join(host.home, '.local'),
      p.join(host.home, '.local', 'share'),
      p.join(host.home, '.config'),
      p.join(host.home, 'Desktop'),
      p.join(host.home, 'Documents'),
      p.join(host.home, 'Downloads'),
    ],
  }
}

export function normalizeLocation(platform: OsPlatform, input: string): string {
  const p = pathFor(platform)
  const resolved = p.normalize(input.trim())
  const root = p.parse(resolved).root
  return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved
}

/**
 * The string rules alone: absolute, not a root, not a system/temp/payload folder.
 * Returns the problem and, where it helps, a suggested subfolder.
 */
export function locationRule(
  input: string,
  context: Pick<LocationContext, 'host' | 'tempDir' | 'payloadDir' | 'volume'>,
): { path: string; problem: LocationProblem | null; suggestion: string | null } {
  const { platform } = context.host
  const p = pathFor(platform)
  const trimmed = input.trim()
  if (!trimmed || !p.isAbsolute(trimmed) || (platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(trimmed))) {
    return { path: trimmed, problem: problem('E_NOT_ABSOLUTE'), suggestion: null }
  }
  const path = normalizeLocation(platform, trimmed)
  const sub = p.join(path, PRODUCT_NAME)
  if (p.parse(path).root === path || p.dirname(path) === path || (platform === 'win32' && /^\\\\[^\\]+\\[^\\]+$/.test(path))) {
    return { path, problem: problem('E_DRIVE_ROOT'), suggestion: sub }
  }
  if (context.payloadDir && isWithin(platform, context.payloadDir, path)) {
    return { path, problem: problem('E_IN_PAYLOAD'), suggestion: null }
  }
  if (context.volume && isWithin(platform, context.volume, path)) {
    return { path, problem: problem('E_SYSTEM_DIR', '不能安装到安装磁盘映像里。'), suggestion: null }
  }
  const folders = systemFolders(context.host)
  if (folders.within.some((folder) => isWithin(platform, folder, path))) {
    return { path, problem: problem('E_SYSTEM_DIR'), suggestion: null }
  }
  const temps = [context.tempDir, ...(platform === 'win32' ? [] : ['/tmp', '/var/tmp'])]
  if (temps.some((folder) => folder && isWithin(platform, folder, path))) {
    return { path, problem: problem('E_TEMP_DIR'), suggestion: null }
  }
  if (folders.exact.some((folder) => samePath(platform, folder, path))) {
    return { path, problem: problem('E_SYSTEM_DIR', '请不要直接选择这个文件夹，可以装在它里面的 MossStudio 文件夹。'), suggestion: sub }
  }
  return { path, problem: null, suggestion: null }
}

/** The nearest folder that exists: where a missing location would be created. */
export function nearestExisting(path: string): string | null {
  let current = path
  for (;;) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function freeBytesAt(path: string): number | null {
  const existing = nearestExisting(path)
  if (!existing) return null
  try {
    const stats = statfsSync(existing)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

/** Can we create files at `path` (or create `path` itself)? Probes with a real file. */
export function canWrite(path: string): boolean {
  const existing = nearestExisting(path)
  if (!existing) return false
  try {
    if (!lstatSync(existing).isDirectory()) return false
    accessSync(existing, constants.W_OK)
    const probe = join(existing, `.moss-write-${randomBytes(4).toString('hex')}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

function entries(path: string): string[] {
  try {
    return readdirSync(path).filter((name) => name !== '.DS_Store' && name !== 'desktop.ini' && name !== 'Thumbs.db')
  } catch {
    return []
  }
}

/** portable.json that really is a MossStudio portable marker. */
export function isPortableRoot(path: string): boolean {
  return portableMarkerSchema.safeParse(readJsonObject(join(path, PORTABLE_FILE))).success
}

/**
 * What is at `path` now, from the install point of view. A folder counts as a MossStudio
 * root only when its install.json parses as an install record; a portable root (a valid
 * portable.json) is reported separately, and anything else with files is just occupied.
 */
export function inspectInstallLocation(platform: OsPlatform, path: string): LocationKind | 'file' | 'portable' {
  const p = pathFor(platform)
  if (!existsSync(path)) return 'missing'
  if (!lstatSync(path).isDirectory()) return 'file'
  if (isPortableRoot(path)) return 'portable'
  if (platform === 'darwin') return existsSync(p.join(path, BUNDLE_NAME)) ? 'install' : 'empty'
  const names = entries(path)
  if (names.length === 0) return 'empty'
  if (readInstallRecord(join(path, RECORD_FILE))) return 'install'
  if (isLegacyRoot(platform, path)) return 'legacy'
  if (isKeptDataFolder(platform, path)) return 'data'
  return 'occupied'
}

/**
 * Windows/Linux: a folder an uninstall left behind with the data kept: no install record, and
 * a data/ that is MossStudio data (anything else in it is the user's and stays). Installing
 * there keeps using that data/.
 *
 * Stricter than isDataRoot, because this decides on a folder the user merely pointed at: a
 * project folder with a data/models/ must not be taken over. MossStudio's own data has the
 * launcher's log (written on every start) or settings.json together with instances/.
 */
export function isKeptDataFolder(platform: OsPlatform, path: string): boolean {
  const p = pathFor(platform)
  if (platform === 'darwin' || existsSync(p.join(path, RECORD_FILE))) return false
  const data = p.join(path, 'data')
  const isFile = (name: string[]): boolean => {
    try {
      return lstatSync(p.join(data, ...name)).isFile()
    } catch {
      return false
    }
  }
  const isDir = (name: string): boolean => {
    try {
      return lstatSync(p.join(data, name)).isDirectory()
    } catch {
      return false
    }
  }
  try {
    if (!lstatSync(data).isDirectory()) return false
  } catch {
    return false
  }
  return isFile(['logs', 'launcher.log']) || (isFile(['settings.json']) && isDir('instances'))
}

function finish(
  base: { path: string; problem: LocationProblem | null; suggestion: string | null },
  kind: LocationKind,
  freeBytes: number | null,
  requiredBytes: number,
): LocationCheck {
  return { ...base, ok: base.problem === null, kind, freeBytes, requiredBytes }
}

/**
 * The filesystem half of the install check, for a path that passed `locationRule`:
 * what is there, write access, free space.
 */
export function inspectInstallFolder(platform: OsPlatform, path: string, requiredBytes: number): LocationCheck {
  const p = pathFor(platform)
  const base = { path, problem: null, suggestion: null }
  const found = inspectInstallLocation(platform, path)
  if (found === 'file') return finish({ ...base, problem: problem('E_NOT_DIRECTORY') }, 'occupied', null, requiredBytes)
  if (found === 'portable') return finish({ ...base, problem: problem('E_PORTABLE_ROOT') }, 'occupied', null, requiredBytes)
  const kind = found
  if (kind === 'occupied') {
    return finish(
      {
        path,
        problem: problem('E_NOT_EMPTY', `${MESSAGES.E_NOT_EMPTY}可以装在其中的 ${PRODUCT_NAME} 文件夹里。`),
        suggestion: p.join(path, PRODUCT_NAME),
      },
      kind,
      null,
      requiredBytes,
    )
  }
  if (!canWrite(path)) return finish({ ...base, problem: problem('E_NOT_WRITABLE') }, kind, null, requiredBytes)
  const freeBytes = freeBytesAt(path)
  if (freeBytes !== null && freeBytes < requiredBytes) {
    return finish({ ...base, problem: problem('E_NO_SPACE') }, kind, freeBytes, requiredBytes)
  }
  return finish(base, kind, freeBytes, requiredBytes)
}

export function checkInstallLocation(input: string, context: LocationContext): LocationCheck {
  const rule = locationRule(input, context)
  if (rule.problem) return finish(rule, 'missing', null, context.requiredBytes)
  return inspectInstallFolder(context.host.platform, rule.path, context.requiredBytes)
}

/** A data folder that already holds MossStudio data (or a locator/record) may be reused. */
export function isDataRoot(platform: OsPlatform, path: string): boolean {
  const p = pathFor(platform)
  return ['settings.json', RECORD_FILE, LOCATOR_FILE, 'instances', 'models'].some((name) => existsSync(p.join(path, name)))
}

/** The filesystem half of the data check: missing/empty/existing MossStudio data, write access. */
export function inspectDataFolder(platform: OsPlatform, path: string): LocationCheck {
  const p = pathFor(platform)
  const base = { path, problem: null, suggestion: null }
  if (!existsSync(path)) {
    return canWrite(path)
      ? finish(base, 'missing', freeBytesAt(path), 0)
      : finish({ ...base, problem: problem('E_NOT_WRITABLE') }, 'missing', null, 0)
  }
  if (!lstatSync(path).isDirectory()) return finish({ ...base, problem: problem('E_NOT_DIRECTORY') }, 'occupied', null, 0)
  const names = entries(path)
  const kind: LocationKind = names.length === 0 ? 'empty' : isDataRoot(platform, path) ? 'data' : 'occupied'
  if (kind === 'occupied') {
    return finish(
      {
        path,
        problem: problem('E_NOT_EMPTY', `${MESSAGES.E_NOT_EMPTY}可以放在其中的 ${PRODUCT_NAME} 文件夹里。`),
        suggestion: p.join(path, PRODUCT_NAME),
      },
      kind,
      null,
      0,
    )
  }
  if (!canWrite(path)) return finish({ ...base, problem: problem('E_NOT_WRITABLE') }, kind, null, 0)
  return finish(base, kind, freeBytesAt(path), 0)
}

export function checkDataLocation(input: string, context: Omit<LocationContext, 'requiredBytes'>): LocationCheck {
  const rule = locationRule(input, context)
  if (rule.problem) return finish(rule, 'missing', null, 0)
  return inspectDataFolder(context.host.platform, rule.path)
}
