/**
 * Setup-mode state machine behind the setup window and silent installs. Electron-free:
 * the window, dialogs, quitting and OS calls are injected (see app.ts for the real ones).
 */
import { existsSync, lstatSync } from 'original-fs'
import { join } from 'node:path'
import type { SetupLegacyInstall, SetupLocationCheck, SetupStartInput, SetupState } from '@shared/setup'
import { codedError } from '../lib/codedError'
import { listTree, treeBytes } from './copy'
import { performInstall, type InstallDeps, type InstallResult } from './install'
import {
  BUNDLE_NAME,
  RECORD_FILE,
  appDirName,
  defaultInstallRoot,
  keptDataPath,
  launcherName,
  macSupportDir,
  recordPathFor,
  samePath,
  type HostInfo,
} from './layout'
import { directorySize, findLegacyInstall, isLegacyRoot, legacyAt, type LegacyInstall } from './legacy'
import { canWrite, checkDataLocation, checkInstallLocation, isDataRoot, type LocationContext } from './location'
import { readInstallRecord, readKeptData } from './record'
import type { Registry } from './registry'
import type { RunContext } from './runContext'
import { compareSemver } from '@shared/update'

/** Room for one update side by side, on top of the payload itself. */
const HEADROOM_BYTES = 64 * 1024 * 1024

export interface SetupEnvironment {
  context: RunContext
  host: HostInfo
  /** The version being installed (app.getVersion()). */
  version: string
  tempDir: string
  registry: Registry | null
  /** Everything performInstall needs except progress (the controller reports it). */
  install: Omit<InstallDeps, 'progress'>
  emit(channel: 'progress' | 'done' | 'failed' | 'state', payload: unknown): void
  /** The setup log file. */
  logPath: string
  /**
   * Is MossStudio running for this user (the single-instance probe)? Checked before replacing
   * an existing install: Linux/macOS would otherwise rename a running app-<v> or bundle.
   */
  appRunning?(): boolean
}

export interface Located {
  root: string
  dataRoot: string
  version: string
}

/** The install the locator points at, if it still exists. */
export function locatedInstall(context: RunContext): Located | null {
  const locator = context.locator
  if (!locator) return null
  const platform = context.platform
  const recordPath = recordPathFor(platform, locator.root, locator.dataRoot)
  const record = readInstallRecord(recordPath)
  if (!record) return null
  if (platform === 'darwin' && !existsSync(locator.appPath ?? join(locator.root, BUNDLE_NAME))) return null
  if (platform !== 'darwin' && !existsSync(join(locator.root, RECORD_FILE))) return null
  return { root: record.root, dataRoot: record.dataRoot, version: record.current }
}

/**
 * Windows/Linux: the data a keep-data uninstall left behind (kept-data.json beside the locator),
 * while it is still there and still MossStudio data. Shown like an old install (source kept):
 * root is the folder it was installed in, dataDir the data root to keep using.
 */
export function keptDataInstall(host: HostInfo): LegacyInstall | null {
  if (host.platform === 'darwin') return null
  const kept = readKeptData(keptDataPath(host))
  if (!kept || !isDataRoot(host.platform, kept.dataRoot)) return null
  return { root: kept.root, dataDir: kept.dataRoot, dataBytes: null, version: kept.version, source: 'kept' }
}

/**
 * The old install as the page sees it, with a note per choice. reuse keeps using <old>\data,
 * so the note must say NOT to delete the old folder; fresh leaves it free to delete. On
 * Windows a new install elsewhere also takes over the HKCU Uninstall entry, so either way
 * the old copy drops out of 设置 › 应用.
 */
export function legacyView(legacy: LegacyInstall | null, platform: HostInfo['platform']): SetupLegacyInstall | null {
  if (!legacy) return null
  if (legacy.source === 'kept') {
    // Nothing of the old install is left but the data: no program folder, no 设置 › 应用 entry.
    return {
      ...legacy,
      warnings: {
        reuse: `新版本会继续使用 ${legacy.dataDir} 里的作品、模型和设置：请不要删除这个文件夹。`,
        fresh: `这些数据仍留在 ${legacy.dataDir}，不会被删除；不再需要时可以手动删除这个文件夹。`,
      },
    }
  }
  const where = `旧版 MossStudio（${legacy.root}）`
  const warnings = platform === 'win32'
    ? {
        reuse: `${where}会从“设置 › 应用”的列表里消失，但新版本会继续使用它文件夹里的 data：请不要删除这个文件夹。`,
        fresh: `${where}会从“设置 › 应用”的列表里消失，它的文件和数据仍留在原处，不会被删除；不再需要时可以手动删除这个文件夹。`,
      }
    : {
        reuse: `新版本会继续使用${where}文件夹里的 data：请不要删除这个文件夹。`,
        fresh: `${where}的文件和数据仍留在原处，不会被删除；不再需要时可以手动删除这个文件夹。`,
      }
  return { ...legacy, warnings }
}

export class SetupController {
  state: SetupState
  private legacy: LegacyInstall | null
  private running: Promise<InstallResult> | null = null

  private constructor(private readonly env: SetupEnvironment, state: SetupState, legacy: LegacyInstall | null) {
    this.state = state
    this.legacy = legacy
  }

  static async create(env: SetupEnvironment): Promise<SetupController> {
    const { context, host, version } = env
    const platform = host.platform
    const requiredBytes = (await payloadBytes(context, version)) + HEADROOM_BYTES
    const located = locatedInstall(context)
    // An explicit --moss-install-to elsewhere is a new install there, not an update of the located one.
    const installTo = context.setup?.installTo ?? null
    const installed = located && installTo && !samePath(platform, installTo, located.root) ? null : located
    const kind: SetupState['kind'] = !installed
      ? 'first'
      : (() => {
          const order = compareSemver(version, installed.version)
          return order > 0 ? 'update' : order === 0 ? 'repair' : 'downgrade'
        })()
    const applicationsWritable = platform === 'darwin' ? canWrite('/Applications') : true
    const defaults = {
      root: defaultInstallRoot(host, applicationsWritable),
      dataRoot: platform === 'darwin' ? macSupportDir(host) : null,
    }
    // An old 1.0.x install first; else data a keep-data uninstall left behind.
    const legacy = kind === 'first' && platform !== 'darwin'
      ? (await findLegacyInstall({ host, registry: env.registry })) ?? keptDataInstall(host)
      : null
    const proposed = env.context.setup?.installTo ?? installed?.root ?? defaults.root
    const locationContext = (): LocationContext => ({
      host,
      tempDir: env.tempDir,
      payloadDir: context.setup?.payloadDir ?? null,
      volume: context.setup?.volume ?? null,
      requiredBytes,
    })
    const state: SetupState = {
      platform,
      version,
      kind,
      installed,
      defaults,
      location: checkInstallLocation(proposed, locationContext()),
      dataLocation: platform === 'darwin' ? checkDataLocation(installed?.dataRoot ?? defaults.dataRoot!, locationContext()) : null,
      legacy: legacyView(legacy, platform),
      requiredBytes,
      phase: 'idle',
      progress: null,
      result: null,
      error: null,
      canEject: platform === 'darwin' && Boolean(context.setup?.volume),
      logPath: env.logPath,
      launcherLogPath: installed && existsSync(join(installed.dataRoot, 'logs', 'launcher.log')) ? join(installed.dataRoot, 'logs', 'launcher.log') : null,
    }
    const controller = new SetupController(env, state, legacy)
    if (legacy) void controller.measureLegacy()
    return controller
  }

  private locationContext(): LocationContext {
    const { context } = this.env
    return {
      host: this.env.host,
      tempDir: this.env.tempDir,
      payloadDir: context.setup?.payloadDir ?? null,
      volume: context.setup?.volume ?? null,
      requiredBytes: this.state.requiredBytes,
    }
  }

  private async measureLegacy(): Promise<void> {
    const legacy = this.legacy
    if (!legacy) return
    const bytes = await directorySize(legacy.dataDir)
    if (this.legacy !== legacy) return
    legacy.dataBytes = bytes
    this.state = { ...this.state, legacy: legacyView(legacy, this.env.host.platform) }
    this.env.emit('state', this.state)
  }

  validate(path: string, purpose: 'install' | 'data'): SetupLocationCheck {
    return purpose === 'install' ? checkInstallLocation(path, this.locationContext()) : checkDataLocation(path, this.locationContext())
  }

  /** The folder the user points at, as an old 1.0.x install; becomes the current legacy candidate. */
  async inspectLegacy(path: string): Promise<SetupLegacyInstall | null> {
    const found = legacyAt(this.env.host.platform, path.trim(), 'picked')
    if (!found) return null
    found.dataBytes = await directorySize(found.dataDir)
    this.legacy = found
    this.state = { ...this.state, legacy: legacyView(found, this.env.host.platform) }
    return this.state.legacy
  }

  /** Begin installing; resolves once started. `completion()` resolves when it is done. */
  start(input: SetupStartInput): SetupState {
    if (this.state.phase === 'installing') throw codedError('E_BUSY', '正在安装。')
    if (this.state.phase === 'done') throw codedError('E_DONE', '已经安装完成。')
    const { host, context, version } = this.env
    const platform = host.platform
    if (!context.platformKey) throw codedError('E_UNSUPPORTED', '这个系统或处理器架构不受支持。')
    if (this.state.kind === 'downgrade' && !input.allowDowngrade) {
      throw codedError('E_DOWNGRADE', `已安装的版本（${this.state.installed?.version}）比这个安装程序（${version}）新。确认后才会降级。`)
    }
    const located = this.state.installed
    const root = located ? located.root : input.root
    let replacing = Boolean(located)
    if (!located) {
      const check = checkInstallLocation(root, this.locationContext())
      if (!check.ok) throw codedError(check.problem?.code ?? 'E_LOCATION', check.problem?.message ?? '不能安装到这个位置。')
      replacing = check.kind === 'install' || check.kind === 'legacy'
    }
    if (replacing && this.env.appRunning?.()) {
      // A failed state (not a throw) so the page shows its failure screen with 重试.
      const failure = { code: 'E_APP_RUNNING', message: 'MossStudio 正在运行。请在它弹出的对话框里关闭它（或手动退出），然后重试。' }
      this.env.install.log(`install refused: ${failure.message}`)
      this.state = { ...this.state, phase: 'failed', error: failure }
      this.env.emit('failed', failure)
      return this.state
    }
    let dataRoot: string | null = null
    if (platform === 'darwin' && input.dataRoot && !located) {
      const check = checkDataLocation(input.dataRoot, this.locationContext())
      if (!check.ok) throw codedError(check.problem?.code ?? 'E_LOCATION', check.problem?.message ?? '不能把数据放在这个位置。')
      dataRoot = check.path
    }
    let legacy = null
    const kept = this.legacy?.source === 'kept' ? this.legacy : null
    if (!located && input.legacy && kept && samePath(platform, input.legacy.root, kept.root)) {
      // Data a keep-data uninstall left: reuse records it as the data root (installing into its
      // own folder finds it as R/data anyway). The data is never moved or deleted either way.
      if (input.legacy.mode === 'reuse') dataRoot = kept.dataDir
      this.env.install.log(`data kept by an uninstall at ${kept.dataDir}: ${input.legacy.mode}`)
    } else if (!located && input.legacy) {
      if (!isLegacyRoot(platform, input.legacy.root)) throw codedError('E_NOT_LEGACY', '这个文件夹不是旧版 MossStudio 的安装目录。')
      // Installing into the old folder converts it in place: its data\ stays where it is.
      const inPlace = samePath(platform, input.legacy.root, root)
      legacy = { root: input.legacy.root, mode: inPlace ? ('reuse' as const) : input.legacy.mode }
    } else if (!located && isLegacyRoot(platform, root)) {
      legacy = { root, mode: 'reuse' as const }
    }

    if (legacy && !samePath(platform, legacy.root, root) && platform === 'win32') {
      this.env.install.log(`old 1.0.x at ${legacy.root} stays on disk but loses its Apps & Features entry (mode ${legacy.mode})`)
    }
    this.state = { ...this.state, phase: 'installing', progress: null, error: null }
    const request = {
      host,
      platformKey: context.platformKey,
      version,
      payloadDir: context.setup?.payloadDir ?? null,
      sourceBundle: platform === 'darwin' ? context.appPath : null,
      root: located ? root : checkInstallLocation(root, this.locationContext()).path,
      dataRoot,
      legacy,
    }
    this.running = performInstall(request, {
      ...this.env.install,
      progress: (progress) => {
        this.state = { ...this.state, progress }
        this.env.emit('progress', progress)
      },
    })
    this.running.then(
      (result) => {
        this.state = {
          ...this.state,
          phase: 'done',
          result: { root: result.root, dataRoot: result.dataRoot, version: result.version, appPath: result.appPath, warnings: result.warnings },
        }
        this.env.emit('done', this.state.result)
      },
      (error: unknown) => {
        const code = (error as { code?: unknown }).code
        const failure = {
          code: typeof code === 'string' && code.startsWith('E_') ? code : 'E_INSTALL_FAILED',
          message: error instanceof Error ? error.message : String(error),
        }
        this.env.install.log(`install failed: ${failure.code} ${failure.message}`)
        this.state = { ...this.state, phase: 'failed', error: failure }
        this.env.emit('failed', failure)
      },
    )
    return this.state
  }

  /** The running install's result (rejects when it failed). */
  completion(): Promise<InstallResult> {
    if (!this.running) return Promise.reject(codedError('E_NOT_STARTED', '还没有开始安装。'))
    return this.running
  }

  /** What the silent install does: installTo, else the located root, else the default; the old install's data is reused only in place. */
  silentStartInput(): SetupStartInput {
    const root = this.env.context.setup?.installTo ?? this.state.installed?.root ?? this.state.defaults.root
    return { root, dataRoot: null, legacy: null, allowDowngrade: true }
  }
}

/** Bytes the install copies: app-<v>/ and the launcher (macOS: the bundle). */
export async function payloadBytes(context: RunContext, version: string): Promise<number> {
  try {
    if (context.platform === 'darwin') return treeBytes(await listTree(context.appPath))
    const payload = context.setup?.payloadDir
    if (!payload) return 0
    const launcher = join(payload, launcherName(context.platform)!)
    const launcherSize = existsSync(launcher) ? lstatSync(launcher).size : 0
    const app = join(payload, appDirName(version))
    return (existsSync(app) ? treeBytes(await listTree(app)) : 0) + launcherSize
  } catch {
    return 0
  }
}
