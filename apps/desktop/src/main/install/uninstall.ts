/**
 * Uninstall. Windows/Linux: write a plan that lists exactly what the install created,
 * copy the launcher to a fresh temp folder, start it with --finish-uninstall=<plan> and
 * quit; the copy deletes the planned paths once every process under R has exited.
 * macOS: move the bundle (and, if chosen, the data folder) to the Trash in-process.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'original-fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FINISH_UNINSTALL_ARG, SILENT_ARG, uninstallPlanSchema, type KeptData, type PlatformKey, type UninstallPlan } from '@shared/install'
import { codedError } from '../lib/codedError'
import { linuxIntegrationPaths, windowsShortcutPaths } from './integration'
import {
  BUNDLE_NAME,
  PORTABLE_FILE,
  PRODUCT_NAME,
  RECORD_FILE,
  UNINSTALL_KEY,
  isWithin,
  keptDataPath,
  launcherName,
  locatorPath,
  pathFor,
  recordPathFor,
  samePath,
  versionOfAppDir,
  type HostInfo,
} from './layout'
import { locationRule } from './location'
import { rememberSpawned } from './processTree'
import { writeJsonAtomic, writeKeptData } from './record'

export interface UninstallTarget {
  host: HostInfo
  platformKey: PlatformKey
  root: string
  dataRoot: string
  portable: boolean
  /** Windows: the user's Desktop folder (for the desktop shortcut). */
  desktopDir: string
  /** Electron's profile, app.getPath('userData'); removed only together with the data. */
  profileDir: string | null
}

/** Paths outside R and the data root that the install itself created. */
export function integrationFiles(target: UninstallTarget): string[] {
  const { host } = target
  if (target.portable) return []
  const files = [locatorPath(host)]
  if (host.platform === 'win32') files.push(...windowsShortcutPaths(host, target.desktopDir))
  if (host.platform === 'linux') {
    const linux = linuxIntegrationPaths(host)
    files.push(linux.desktopFile, linux.iconFile)
  }
  return files
}

/** Refuse a data root whose removal would take R, the home folder or a system folder with it. */
export function assertDataRemovable(target: UninstallTarget): void {
  const { platform } = target.host
  if (isWithin(platform, target.dataRoot, target.root)) {
    throw codedError('E_UNSAFE_DATA_ROOT', '数据文件夹包含了安装目录，不能一起删除。请手动删除数据。')
  }
  const rule = locationRule(target.dataRoot, { host: target.host, tempDir: '' })
  if (rule.problem && rule.problem.code !== 'E_TEMP_DIR') {
    throw codedError('E_UNSAFE_DATA_ROOT', `数据文件夹（${target.dataRoot}）不能整体删除。请手动删除数据。`)
  }
}

/**
 * The Electron profile folder to remove with the data, or null when there is nothing extra to
 * remove (no profile, or it is the data root itself). Refuses anything but a folder named
 * MossStudio outside R that is not the home folder.
 */
export function removableProfileDir(target: UninstallTarget): string | null {
  const { platform } = target.host
  const p = pathFor(platform)
  if (!target.profileDir) return null
  if (!p.isAbsolute(target.profileDir)) throw codedError('E_UNSAFE_PROFILE', `应用配置文件夹（${target.profileDir}）不能整体删除。`)
  const profile = p.normalize(target.profileDir)
  if (isWithin(platform, target.dataRoot, profile)) return null
  if (p.basename(profile) !== PRODUCT_NAME || !p.isAbsolute(profile) || isWithin(platform, profile, target.root) || isWithin(platform, target.root, profile) || isWithin(platform, profile, target.host.home)) {
    throw codedError('E_UNSAFE_PROFILE', `应用配置文件夹（${profile}）不能整体删除。`)
  }
  return profile
}

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`
/**
 * Exact suffixes of app-<v> (Windows/Linux) and .MossStudio-<v>.app (macOS) that the install
 * and the Updater create. Kept exact on purpose: the launcher refuses a whole plan that lists
 * a name outside its own list, and the two lists must match.
 *   install:  .partial, .replaced-<base36>
 *   Updater:  .update-partial, .update-partial.delta (and the older .partial.delta)
 *   macOS:    .previous (kept for rollback)
 */
const APP_SUFFIX = String.raw`(?:\.partial|\.partial\.delta|\.update-partial|\.update-partial\.delta|\.replaced-[0-9a-z]+)?`
const APP_DIR_ANY = new RegExp(`^app-${SEMVER}${APP_SUFFIX}$`)
const MAC_LEFTOVER = new RegExp(`^\\.MossStudio-(?:${SEMVER}|old)\\.app(?:\\.previous|\\.partial|\\.partial\\.delta|\\.update-partial|\\.update-partial\\.delta)?$`)
/** The Updater's download staging: R/.updates (Windows/Linux), <folder>/.MossStudio-updates (macOS). */
const UPDATES_DIR = '.updates'
const MAC_UPDATES = '.MossStudio-updates'
/**
 * The Updater's markers next to install.json. Only the macOS swap helper writes them (in the
 * data root); they are NOT owned names in R, because the launcher refuses plans listing them.
 */
export const UPDATE_MARKERS = ['.update-failed', '.update-clean-exit']

/**
 * Names in R the install owns. Windows/Linux: app-<v> folders and their suffixed leftovers,
 * .updates, the launcher's .moss-trash-* cleanup leftovers, .moss-legacy-* staging, the
 * launcher and its .old-/.new- leftovers, install.json, portable.json. macOS: only the hidden
 * .MossStudio-<v>.app* bundles and .MossStudio-updates.
 */
export function ownedRootEntries(platform: HostInfo['platform'], names: string[]): string[] {
  if (platform === 'darwin') return names.filter((name) => name === MAC_UPDATES || MAC_LEFTOVER.test(name))
  const launcher = launcherName(platform)
  return names.filter((name) => {
    if (versionOfAppDir(name) || APP_DIR_ANY.test(name)) return true
    if (name === UPDATES_DIR) return true
    if (/^\.moss-legacy-[0-9a-z]+$/.test(name)) return true
    if (name.startsWith('.moss-trash-')) return true
    if (name === RECORD_FILE || name === PORTABLE_FILE) return true
    if (launcher && (name === launcher || name.startsWith(`${launcher}.old-`) || name.startsWith(`.${launcher}.new-`))) return true
    return false
  })
}

export function buildUninstallPlan(target: UninstallTarget, removeData: boolean, names: string[], now: Date = new Date()): UninstallPlan {
  const { host, root, dataRoot } = target
  const p = pathFor(host.platform)
  if (removeData) assertDataRemovable(target)
  const remove = ownedRootEntries(host.platform, names).map((name) => p.join(root, name))
  if (host.platform === 'darwin') {
    const record = recordPathFor('darwin', root, dataRoot)
    remove.push(p.join(root, BUNDLE_NAME), record, ...UPDATE_MARKERS.map((name) => p.join(p.dirname(record), name)))
  }
  remove.push(...integrationFiles(target))
  if (removeData) remove.push(dataRoot)
  const unique = remove.filter((path, index) => remove.findIndex((other) => samePath(host.platform, other, path)) === index)
  const locator = locatorPath(host)
  const plan: UninstallPlan = {
    schema: 1,
    platform: target.platformKey,
    root,
    dataRoot,
    removeData,
    remove: unique,
    registryKeys: host.platform === 'win32' && !target.portable ? [UNINSTALL_KEY] : [],
    removeEmptyDirs: target.portable ? [root] : [root, p.dirname(locator)],
    createdAt: now.toISOString(),
  }
  const profile = removeData && host.platform !== 'darwin' ? removableProfileDir(target) : null
  if (profile) plan.profileDir = profile
  assertPlanContained(plan, integrationFiles(target))
  return uninstallPlanSchema.parse(plan)
}

/**
 * Every planned path is inside R or the data root, or is one of `extras`; R itself is never in
 * `remove`, and while the data is kept nothing that is (or holds) the data root is either.
 */
export function assertPlanContained(plan: UninstallPlan, extras: string[]): void {
  const platform = plan.platform.startsWith('win32') ? 'win32' : plan.platform.startsWith('darwin') ? 'darwin' : 'linux'
  if (plan.profileDir) {
    if (!plan.removeData) throw codedError('E_UNSAFE_PLAN', '保留数据时不能删除应用配置文件夹。')
    if (pathFor(platform).basename(plan.profileDir) !== PRODUCT_NAME || isWithin(platform, plan.profileDir, plan.root) || isWithin(platform, plan.root, plan.profileDir)) {
      throw codedError('E_UNSAFE_PLAN', `卸载计划的应用配置文件夹不合规：${plan.profileDir}`)
    }
  }
  for (const path of plan.remove) {
    if (samePath(platform, path, plan.root)) throw codedError('E_UNSAFE_PLAN', `卸载计划不能整体删除安装目录：${path}`)
    // Keeping the data: nothing that is the data root or holds it.
    if (!plan.removeData && isWithin(platform, path, plan.dataRoot)) throw codedError('E_UNSAFE_PLAN', `卸载计划包含要保留的数据：${path}`)
    const inside = (isWithin(platform, plan.root, path) && !samePath(platform, path, plan.root))
      || (plan.removeData ? isWithin(platform, plan.dataRoot, path) : isWithin(platform, plan.dataRoot, path) && !samePath(platform, path, plan.dataRoot))
    if (!inside && !extras.some((extra) => samePath(platform, extra, path))) {
      throw codedError('E_UNSAFE_PLAN', `卸载计划包含安装目录以外的路径：${path}`)
    }
  }
}

export function listRoot(root: string): string[] {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}

export interface FinishUninstallDeps {
  spawnDetached(file: string, args: string[]): void
}

export const spawnDetachedNoShell: FinishUninstallDeps['spawnDetached'] = (file, args) => {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false })
  // Never killed by exitCleanly: it has to outlive us to delete the planned files.
  rememberSpawned(child.pid)
  child.unref()
}

/**
 * Write the plan next to a temp copy of the launcher and start the copy. The caller quits
 * right after; the copy waits for this process to exit.
 */
export interface FinishUninstallOptions extends Partial<FinishUninstallDeps> {
  /** Unattended uninstall: the launcher copy gets --moss-silent and shows no dialogs. */
  silent?: boolean
}

export function startFinishUninstall(plan: UninstallPlan, launcher: string, options: FinishUninstallOptions = {}): { dir: string; plan: string; launcher: string } {
  const spawnDetached = options.spawnDetached ?? spawnDetachedNoShell
  if (!existsSync(launcher) || !lstatSync(launcher).isFile()) {
    throw codedError('E_NO_LAUNCHER', '找不到 MossStudio 启动器，无法完成卸载。')
  }
  const dir = mkdtempSync(join(tmpdir(), 'MossStudio-uninstall-'))
  const copy = join(dir, pathFor(process.platform === 'win32' ? 'win32' : 'linux').basename(launcher))
  const planFile = join(dir, 'plan.json')
  try {
    copyFileSync(launcher, copy)
    if (process.platform !== 'win32') chmodSync(copy, 0o755)
    writeJsonAtomic(planFile, plan)
    spawnDetached(copy, [`${FINISH_UNINSTALL_ARG}=${planFile}`, ...(options.silent ? [SILENT_ARG] : [])])
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return { dir, plan: planFile, launcher: copy }
}

/**
 * Windows/Linux, uninstalling with the data kept: leave kept-data.json beside the locator so a
 * later Setup (into another folder too) can offer to keep using the data. Returns the file, or
 * null when there is nothing to note (portable, macOS: its default data folder is found anyway).
 */
export function noteKeptData(target: UninstallTarget, version: string, now: Date = new Date()): string | null {
  if (target.portable || target.host.platform === 'darwin') return null
  const file = keptDataPath(target.host)
  const kept: KeptData = { schema: 1, root: target.root, dataRoot: target.dataRoot, version, keptAt: now.toISOString() }
  writeKeptData(file, kept)
  return file
}

export interface MacUninstallDeps {
  trash(path: string): Promise<void>
  /** Trash the running bundle once the app has quit (see macTrash.ts). */
  trashBundleAfterExit(bundle: string): Promise<void>
}

/**
 * macOS: Trash the hidden previous/partial bundles (and the data folder when chosen); otherwise
 * remove install.json. The locator always goes. The bundle itself is left to a helper that moves
 * it after the app has quit: this process and its Chromium helpers still run from it.
 */
export async function uninstallMac(target: UninstallTarget, bundle: string, removeData: boolean, deps: MacUninstallDeps, names: string[] = listRoot(target.root)): Promise<string[]> {
  if (removeData) assertDataRemovable(target)
  const trashed: string[] = []
  for (const item of ownedRootEntries('darwin', names).map((name) => join(target.root, name))) {
    await deps.trash(item)
    trashed.push(item)
  }
  if (removeData) {
    const profile = removableProfileDir(target)
    for (const item of profile ? [target.dataRoot, profile] : [target.dataRoot]) {
      await deps.trash(item)
      trashed.push(item)
    }
  } else {
    const record = recordPathFor('darwin', target.root, target.dataRoot)
    for (const file of [record, ...UPDATE_MARKERS.map((name) => join(target.dataRoot, name))]) rmSync(file, { force: true })
  }
  rmSync(locatorPath(target.host), { force: true })
  await deps.trashBundleAfterExit(bundle)
  return trashed
}
