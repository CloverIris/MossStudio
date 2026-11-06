/**
 * The install steps, platform by platform. Everything that touches the OS beyond the
 * filesystem (reg.exe, shortcuts, ditto, open) comes in through InstallDeps so the
 * whole flow runs in tests against temp folders.
 *
 * Windows/Linux:  convert old 1.0.x in place (if installing into it) → copy app-<v>/ →
 *                 place the launcher → install.json + locator → registry + shortcuts / .desktop
 * macOS:          ditto the bundle next to the target → swap it in → install.json (data root) + locator
 */
import { spawn } from 'node:child_process'
// original-fs: app folders hold app.asar, which Electron's own fs treats as a folder.
import { chmodSync, copyFileSync, existsSync, mkdirSync, promises as fsp, readdirSync, renameSync, rmSync } from 'original-fs'
import { basename, join } from 'node:path'
import type { InstallLocator, InstallRecord, PlatformKey, UpdateChannel } from '@shared/install'
import { codedError } from '../lib/codedError'
import { copyTree, listTree, treeBytes } from './copy'
import { writeLinuxIntegration, windowsShortcutPaths, writeWindowsShortcuts, type WriteShortcut } from './integration'
import {
  BUNDLE_NAME,
  RECORD_FILE,
  appDirName,
  defaultDataRoot,
  keptDataPath,
  launcherName,
  locatorPath,
  macSupportDir,
  recordPathFor,
  samePath,
  type HostInfo,
} from './layout'
import { stageLegacyProgramFiles, type StagedConversion } from './legacy'
import { isPortableRoot } from './location'
import { readInstallRecord, readLocator, writeInstallRecord, writeLocator } from './record'
import { writeUninstallKey, type ExecFile, type UninstallEntry } from './registry'
import type { RunContext } from './runContext'

export type InstallPhase = 'prepare' | 'convert' | 'copy' | 'launcher' | 'record' | 'integrate' | 'done'

export interface InstallProgress {
  phase: InstallPhase
  /** 0–100 over the whole install. */
  percent: number
  copiedBytes: number
  totalBytes: number
  /** File being copied (relative), when phase is copy. */
  file?: string
}

export type LegacyChoice = { root: string; mode: 'reuse' | 'fresh' }

export interface InstallRequest {
  host: HostInfo
  platformKey: PlatformKey
  version: string
  /** Windows/Linux: the stub's payload (app-<v>/ and the launcher). */
  payloadDir: string | null
  /** macOS: the bundle to install (the running one). */
  sourceBundle: string | null
  /** R (macOS: the folder that will hold MossStudio.app). */
  root: string
  /** Explicit data root (macOS 高级); null = keep the existing one or the default. */
  dataRoot: string | null
  legacy: LegacyChoice | null
  channel?: UpdateChannel
}

/** Streams a program's output lines (ditto -V); resolves with the exit code. */
export type SpawnLines = (file: string, args: string[], onLine: (line: string) => void) => Promise<number>

export interface InstallDeps {
  exec: ExecFile
  spawnLines: SpawnLines
  /** Windows only: shell.writeShortcutLink. */
  writeShortcut: WriteShortcut | null
  /** Windows only: the user's Desktop folder. */
  desktopDir: string
  /** Linux only: the PNG for the .desktop entry. */
  iconBytes(): Buffer | null
  now(): Date
  log(line: string): void
  progress(progress: InstallProgress): void
}

export interface InstallResult {
  root: string
  dataRoot: string
  version: string
  previous: string | null
  /** Windows/Linux launcher in R. */
  launcher: string | null
  /** The installed app folder (app-<v>) or bundle. */
  appPath: string
  recordPath: string
  locatorPath: string
  /** Integration steps that failed without failing the install (shortcut, registry). */
  warnings: string[]
}

/** What the desktop integration (integrate) needs from InstallDeps. */
export type IntegrationDeps = Pick<InstallDeps, 'exec' | 'writeShortcut' | 'desktopDir' | 'iconBytes'>

/**
 * Windows: the Apps & Features entry and the Start menu and desktop shortcuts; Linux: the
 * .desktop entry and its icon, all pointing at `entry.launcher`. Returns the steps that failed
 * (as warnings: the install itself stands).
 */
export async function integrate(host: HostInfo, entry: UninstallEntry, deps: IntegrationDeps): Promise<string[]> {
  const warnings: string[] = []
  if (host.platform === 'win32') {
    try {
      await writeUninstallKey({ exec: deps.exec, env: host.env }, entry)
    } catch (error) {
      warnings.push((error as Error).message)
    }
    if (deps.writeShortcut) {
      const failed = writeWindowsShortcuts(deps.writeShortcut, windowsShortcutPaths(host, deps.desktopDir), entry.launcher, entry.root)
      for (const path of failed) warnings.push(`无法创建快捷方式：${path}`)
    }
  } else {
    try {
      writeLinuxIntegration(host, entry.launcher, deps.iconBytes())
    } catch (error) {
      warnings.push(`无法创建应用菜单项：${(error as Error).message}`)
    }
  }
  return warnings
}

export const spawnLinesNoShell: SpawnLines = (file, args, onLine) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    const feed = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line) onLine(line)
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', () => resolve(127))
    child.on('close', (code) => {
      if (buffer) onLine(buffer)
      resolve(code ?? 1)
    })
  })

function stamp(now: Date): string {
  return now.getTime().toString(36)
}

function buildRecord(
  request: InstallRequest,
  previous: InstallRecord | null,
  fields: { root: string; dataRoot: string; appPath?: string },
  now: Date,
): InstallRecord {
  const at = now.toISOString()
  const prior = previous?.current && previous.current !== request.version ? previous.current : previous?.previous
  return {
    schema: 1,
    platform: request.platformKey,
    root: fields.root,
    ...(fields.appPath ? { appPath: fields.appPath } : {}),
    dataRoot: fields.dataRoot,
    portable: false,
    channel: request.channel ?? previous?.channel ?? (request.version.includes('-') ? 'beta' : 'stable'),
    current: request.version,
    ...(prior && prior !== request.version ? { previous: prior } : {}),
    failed: (previous?.failed ?? []).filter((version) => version !== request.version),
    confirmed: false,
    installedAt: previous?.installedAt ?? at,
    updatedAt: at,
  }
}

function locatorOf(record: InstallRecord): InstallLocator {
  return {
    schema: 1,
    root: record.root,
    ...(record.appPath ? { appPath: record.appPath } : {}),
    dataRoot: record.dataRoot,
    version: record.current,
  }
}

/** Replace `target` by `staged` (both in the same folder). The old one is renamed aside first. */
function swapIn(staged: string, target: string, aside: string): void {
  if (existsSync(target)) {
    try {
      renameSync(target, aside)
    } catch {
      throw codedError('E_IN_USE', `${basename(target)} 正在使用。请先退出 MossStudio，再继续安装。`)
    }
  }
  try {
    renameSync(staged, target)
  } catch (error) {
    if (existsSync(aside) && !existsSync(target)) renameSync(aside, target)
    throw error
  }
}

async function installWindowsLinux(request: InstallRequest, deps: InstallDeps): Promise<InstallResult> {
  const { host, version, root } = request
  const platform = host.platform
  const launcherFile = launcherName(platform)!
  const payload = request.payloadDir
  if (!payload) throw codedError('E_NO_PAYLOAD', '缺少安装文件。请重新运行安装程序。')
  const appSource = join(payload, appDirName(version))
  const launcherSource = join(payload, launcherFile)
  if (!existsSync(appSource)) throw codedError('E_NO_PAYLOAD', `安装文件不完整：缺少 ${appDirName(version)}。`)
  if (!existsSync(launcherSource)) throw codedError('E_NO_PAYLOAD', `安装文件不完整：缺少 ${launcherFile}。`)
  const now = deps.now()
  const tag = stamp(now)

  deps.progress({ phase: 'prepare', percent: 0, copiedBytes: 0, totalBytes: 0 })
  mkdirSync(root, { recursive: true })
  const recordPath = join(root, RECORD_FILE)
  const existing = readInstallRecord(recordPath)
  if (isPortableRoot(root)) throw codedError('E_PORTABLE_ROOT', '这是便携版 MossStudio 的文件夹，不能把安装版装进去。')
  if (!existing && existsSync(recordPath))
    throw codedError('E_NOT_EMPTY', `${recordPath} 不是 MossStudio 的安装记录，不会覆盖它。请换一个位置。`)
  const entries = await listTree(appSource)
  const totalBytes = treeBytes(entries)

  let staged: StagedConversion | null = null
  const appTarget = join(root, appDirName(version))
  const partial = `${appTarget}.partial`
  try {
    if (request.legacy && samePath(platform, request.legacy.root, root)) {
      deps.progress({ phase: 'convert', percent: 1, copiedBytes: 0, totalBytes })
      staged = stageLegacyProgramFiles(root, tag)
      deps.log(`converted 1.0.x in place: staged ${staged.moved.length} old program entries in ${staged.stageDir}`)
    }

    await fsp.rm(partial, { recursive: true, force: true })
    await copyTree(
      appSource,
      partial,
      (copy) => {
        deps.progress({
          phase: 'copy',
          percent: 2 + Math.floor((copy.copiedBytes / Math.max(1, totalBytes)) * 88),
          copiedBytes: copy.copiedBytes,
          totalBytes,
          file: copy.file,
        })
      },
      entries,
    )
    const replaced = `${appTarget}.replaced-${tag}`
    swapIn(partial, appTarget, replaced)
    await fsp.rm(replaced, { recursive: true, force: true, maxRetries: 2 }).catch(() => deps.log(`could not remove ${replaced}`))

    deps.progress({ phase: 'launcher', percent: 91, copiedBytes: totalBytes, totalBytes })
    const launcher = join(root, launcherFile)
    const launcherNew = join(root, `.${launcherFile}.new-${tag}`)
    copyFileSync(launcherSource, launcherNew)
    if (platform !== 'win32') chmodSync(launcherNew, 0o755)
    if (platform === 'win32') {
      // A running exe cannot be overwritten on Windows, but it can be renamed.
      swapIn(launcherNew, launcher, join(root, `${launcherFile}.old-${tag}`))
    } else {
      renameSync(launcherNew, launcher)
    }

    deps.progress({ phase: 'record', percent: 93, copiedBytes: totalBytes, totalBytes })
    const legacyData = request.legacy?.mode === 'reuse' ? join(request.legacy.root, 'data') : null
    const dataRoot = request.dataRoot ?? legacyData ?? existing?.dataRoot ?? defaultDataRoot(host, root)
    mkdirSync(dataRoot, { recursive: true })
    const record = buildRecord(request, existing, { root, dataRoot }, now)
    writeInstallRecord(recordPath, record)
    const locator = locatorPath(host)
    writeLocator(locator, locatorOf(record))
    deps.log(`wrote ${recordPath} (current=${record.current}, previous=${record.previous ?? '-'}) and ${locator}`)
    // Kept data was offered (and reused or not): the locator names the install from now on.
    rmSync(keptDataPath(host), { force: true })

    staged?.commit()
    staged = null

    deps.progress({ phase: 'integrate', percent: 96, copiedBytes: totalBytes, totalBytes })
    const warnings = await integrate(host, { root, launcher, version, sizeBytes: totalBytes }, deps)
    for (const name of readdirSync(root)) {
      if (!name.startsWith(`${launcherFile}.old-`)) continue
      try {
        rmSync(join(root, name), { force: true })
      } catch {
        // Still running (the launcher waits on a health check); the next install or the uninstall plan removes it.
      }
    }
    for (const warning of warnings) deps.log(`warning: ${warning}`)
    deps.progress({ phase: 'done', percent: 100, copiedBytes: totalBytes, totalBytes })
    return {
      root,
      dataRoot,
      version,
      previous: record.previous ?? null,
      launcher,
      appPath: appTarget,
      recordPath,
      locatorPath: locator,
      warnings,
    }
  } catch (error) {
    staged?.restore()
    await fsp.rm(partial, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function installMac(request: InstallRequest, deps: InstallDeps): Promise<InstallResult> {
  const { host, version } = request
  const source = request.sourceBundle
  if (!source) throw codedError('E_NO_PAYLOAD', '找不到要安装的 MossStudio.app。')
  const folder = request.root
  const target = join(folder, BUNDLE_NAME)
  const now = deps.now()
  const locator = locatorPath(host)
  const located = readLocator(locator)
  const existingRecordPath = located ? recordPathFor('darwin', located.root, located.dataRoot) : null
  const existing = existingRecordPath ? readInstallRecord(existingRecordPath) : null

  deps.progress({ phase: 'prepare', percent: 0, copiedBytes: 0, totalBytes: 0 })
  if (isPortableRoot(folder)) throw codedError('E_PORTABLE_ROOT', '这是便携版 MossStudio 的文件夹，不能把安装版装进去。')
  mkdirSync(folder, { recursive: true })
  if (!samePath('darwin', source, target)) {
    const entries = await listTree(source)
    const totalBytes = treeBytes(entries)
    const partial = join(folder, `.MossStudio-${version}.app.partial`)
    await fsp.rm(partial, { recursive: true, force: true })
    let lines = 0
    // --noqtn (accepted): the user already passed Gatekeeper by opening this app from the
    // DMG. Keeping the quarantine flag on the copy would make macOS App-Translocate the
    // installed app on launch, which looks like an unlocated bundle and starts setup again
    // in a loop.
    const code = await deps.spawnLines('/usr/bin/ditto', ['-V', '--noqtn', source, partial], () => {
      lines += 1
      deps.progress({
        phase: 'copy',
        percent: Math.min(90, 2 + Math.floor((lines / Math.max(1, entries.length)) * 88)),
        copiedBytes: 0,
        totalBytes,
      })
    })
    if (code !== 0 || !existsSync(partial)) {
      await fsp.rm(partial, { recursive: true, force: true }).catch(() => undefined)
      throw codedError('E_COPY_FAILED', `复制 MossStudio.app 失败（ditto 退出码 ${code}）。`)
    }
    for (const name of readdirSync(folder)) {
      if (/^\.MossStudio-.+\.app\.previous$/.test(name)) await fsp.rm(join(folder, name), { recursive: true, force: true })
    }
    const aside = join(folder, `.MossStudio-${existing?.current ?? 'old'}.app.previous`)
    try {
      swapIn(partial, target, aside)
    } catch (error) {
      await fsp.rm(partial, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  } else {
    deps.log(`bundle already at ${target}; recording it in place`)
  }

  deps.progress({ phase: 'record', percent: 93, copiedBytes: 0, totalBytes: 0 })
  const dataRoot = request.dataRoot ?? existing?.dataRoot ?? located?.dataRoot ?? macSupportDir(host)
  mkdirSync(dataRoot, { recursive: true })
  const record = buildRecord(request, existing, { root: folder, dataRoot, appPath: target }, now)
  const recordPath = recordPathFor('darwin', folder, dataRoot)
  writeInstallRecord(recordPath, record)
  writeLocator(locator, locatorOf(record))
  deps.log(`wrote ${recordPath} (current=${record.current}) and ${locator}`)
  deps.progress({ phase: 'done', percent: 100, copiedBytes: 0, totalBytes: 0 })
  return {
    root: folder,
    dataRoot,
    version,
    previous: record.previous ?? null,
    launcher: null,
    appPath: target,
    recordPath,
    locatorPath: locator,
    warnings: [],
  }
}

/**
 * Windows/Linux, at the start of the installed app: the install folder was moved by hand (the
 * launcher has already rebased install.json's root). When the locator still names the old
 * folder and no install is left there (moved, not copied), point the locator, the shortcuts,
 * the .desktop entry and the Apps & Features entry at the new folder, so they work again and a
 * later Setup finds this install. A copy (the old folder still holds an install) changes nothing.
 * Returns the warnings of a re-integration, or null when there was nothing to do.
 */
export async function reintegrateMovedInstall(context: RunContext, host: HostInfo, deps: IntegrationDeps): Promise<string[] | null> {
  const { platform, root, launcher, locator, recordPath } = context
  if (context.mode !== 'installed' || context.portable || platform === 'darwin') return null
  if (!root || !launcher || !locator || !recordPath || samePath(platform, locator.root, root)) return null
  const record = readInstallRecord(recordPath)
  if (!record || !samePath(platform, record.root, root)) return null
  if (readInstallRecord(recordPathFor(platform, locator.root, locator.dataRoot))) return null
  writeLocator(locatorPath(host), locatorOf(record))
  const sizeBytes = treeBytes(await listTree(join(root, appDirName(record.current))).catch(() => []))
  return integrate(host, { root, launcher, version: record.current, sizeBytes }, deps)
}

export async function performInstall(request: InstallRequest, deps: InstallDeps): Promise<InstallResult> {
  deps.log(`install ${request.version} (${request.platformKey}) into ${request.root}`)
  const result = request.host.platform === 'darwin' ? await installMac(request, deps) : await installWindowsLinux(request, deps)
  deps.log(`install finished: ${result.appPath}`)
  return result
}
