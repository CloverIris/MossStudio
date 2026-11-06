/**
 * How this process was started, decided once at startup before anything reads paths:
 *
 *   setup      --moss-setup=<payloadDir> (Windows/Linux stub), --moss-silent, or on macOS
 *              a bundle that is not the located install (DMG, App Translocation, anywhere else)
 *   uninstall  --moss-uninstall (the launcher passes it on from `--uninstall`)
 *   installed  under an install root R: MOSSSTUDIO_ROOT, or install.json two levels up from
 *              the exe (R/app-<v>/MossStudio); macOS: the bundle the locator points at
 *   portable   portable.json in R (macOS: beside MossStudio.app)
 *   loose      packaged, but none of the above (an unpacked build folder)
 *   dev        not packaged (setup mode can still be forced with --moss-setup for UI work)
 *
 * `detectRunContext` is pure over its input; `getRunContext` memoizes it for the real process.
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  INSTALL_TO_ARG,
  LAUNCHED_ARG,
  SETUP_ARG,
  SILENT_ARG,
  UNINSTALL_ARG,
  installLocatorSchema,
  installRecordSchema,
  type InstallLocator,
  type InstallRecord,
  type PlatformKey,
} from '@shared/install'
import {
  PORTABLE_FILE,
  RECORD_FILE,
  asOsPlatform,
  launcherName,
  locatorPath,
  pathFor,
  platformKey,
  isWithin,
  samePath,
  versionOfAppDir,
  type HostInfo,
  type OsPlatform,
} from './layout'

export type RunMode = 'dev' | 'setup' | 'uninstall' | 'installed' | 'portable' | 'loose'

/** Where a setup-mode bundle runs from (macOS); Windows/Linux setups always come from the stub. */
export type SetupOrigin = 'stub' | 'dmg' | 'translocated' | 'unlocated'

export interface SetupRequest {
  /** The stub's extracted payload: app-<v>/ and the launcher. Null on macOS. */
  payloadDir: string | null
  silent: boolean
  /** --moss-install-to=<dir>, resolved. */
  installTo: string | null
  origin: SetupOrigin
  /** macOS: the mounted DMG volume (/Volumes/<name>) the bundle runs from. */
  volume: string | null
  /**
   * macOS: the locator names this bundle but its data root is missing (a drive not connected).
   * The user is asked before anything (see missingData.ts); Setup never decides on its own.
   */
  missingDataRoot: string | null
}

export interface RunContext {
  mode: RunMode
  platform: OsPlatform
  platformKey: PlatformKey | null
  packaged: boolean
  /** Started by the launcher (--moss-launched): the health check is armed. */
  launched: boolean
  /** --moss-silent: no windows (setup and uninstall). */
  silent: boolean
  /** Install root R (macOS: the folder holding MossStudio.app). */
  root: string | null
  /** Launcher binary (Windows/Linux): MOSSSTUDIO_LAUNCHER, else R/<launcher> when it exists. */
  launcher: string | null
  /** The running app: the app-<v> folder (Windows/Linux) or the .app bundle (macOS). */
  appPath: string
  /** install.json path when there is an install root, whether or not the file exists. */
  recordPath: string | null
  /** install.json as read at startup (re-read with readInstallRecord for fresh values). */
  record: InstallRecord | null
  locatorPath: string
  locator: InstallLocator | null
  portable: boolean
  setup: SetupRequest | null
}

export interface DetectInput {
  argv: string[]
  env: Record<string, string | undefined>
  execPath: string
  packaged: boolean
  platform: OsPlatform
  arch: string
  home: string
  exists(path: string): boolean
  readText(path: string): string | null
}

function argValue(argv: string[], name: string): string | null {
  for (const arg of argv) {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return null
}

function readJson<T>(input: DetectInput, file: string, parse: (value: unknown) => T | null): T | null {
  const text = input.readText(file)
  if (text === null) return null
  try {
    return parse(JSON.parse(text.replace(/^\uFEFF/, '')))
  } catch {
    return null
  }
}

const readRecord = (input: DetectInput, file: string): InstallRecord | null =>
  readJson(input, file, (value) => {
    const parsed = installRecordSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  })

const readLocatorFile = (input: DetectInput, file: string): InstallLocator | null =>
  readJson(input, file, (value) => {
    const parsed = installLocatorSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  })

/** /Applications/MossStudio.app for /Applications/MossStudio.app/Contents/MacOS/MossStudio. */
export function bundleOf(execPath: string): string | null {
  const p = pathFor('darwin')
  const macos = p.dirname(execPath)
  const contents = p.dirname(macos)
  const bundle = p.dirname(contents)
  return p.basename(macos) === 'MacOS' && p.basename(contents) === 'Contents' && bundle.endsWith('.app') ? bundle : null
}

function macOrigin(bundle: string): { origin: SetupOrigin; volume: string | null } {
  const volume = /^(\/Volumes\/[^/]+)\//.exec(bundle)?.[1] ?? null
  if (volume) return { origin: 'dmg', volume }
  if (bundle.includes('/AppTranslocation/')) return { origin: 'translocated', volume: null }
  return { origin: 'unlocated', volume: null }
}

export function detectRunContext(input: DetectInput): RunContext {
  const { argv, env, platform } = input
  const p = pathFor(platform)
  const host: HostInfo = { platform, home: input.home, env }
  const setupArg = argValue(argv, SETUP_ARG)
  const installToArg = argValue(argv, INSTALL_TO_ARG)
  const silent = argv.includes(SILENT_ARG)
  const uninstall = argv.includes(UNINSTALL_ARG)
  const launched = argv.includes(LAUNCHED_ARG)
  const installTo = installToArg ? p.resolve(installToArg) : null
  const locPath = locatorPath(host)
  const base = {
    platform,
    platformKey: platformKey(platform, input.arch),
    packaged: input.packaged,
    launched,
    silent,
    locatorPath: locPath,
  }
  const setupRequest = (origin: SetupOrigin, volume: string | null): SetupRequest => ({
    // Without --moss-setup (a silent install started from an app-<v> folder), the folder
    // holding app-<v> is the payload: it has app-<v>/ and, in R or the stub's temp, the launcher.
    payloadDir: setupArg
      ? p.resolve(setupArg)
      : platform !== 'darwin' && versionOfAppDir(p.basename(p.dirname(input.execPath)))
        ? p.dirname(p.dirname(input.execPath))
        : null,
    silent,
    installTo,
    origin,
    volume,
    missingDataRoot: null,
  })
  const none = { root: null, launcher: null, recordPath: null, record: null, portable: false }

  if (platform === 'darwin') {
    const bundle = bundleOf(input.execPath) ?? p.dirname(input.execPath)
    const appPath = bundle
    const folder = p.dirname(bundle)
    if (input.packaged && input.exists(p.join(folder, PORTABLE_FILE))) {
      const recordPath = p.join(folder, 'data', RECORD_FILE)
      return {
        ...base,
        mode: 'portable',
        root: folder,
        launcher: null,
        appPath,
        recordPath,
        record: readRecord(input, recordPath),
        locator: null,
        portable: true,
        setup: null,
      }
    }
    const locator = input.packaged || setupArg !== null ? readLocatorFile(input, locPath) : null
    if (!input.packaged && setupArg === null) {
      return { ...base, ...none, mode: 'dev', appPath, locator: null, setup: null }
    }
    const recordPath = locator ? p.join(locator.dataRoot, RECORD_FILE) : null
    const record = recordPath ? readRecord(input, recordPath) : null
    const located = Boolean(locator?.appPath && record && samePath('darwin', locator.appPath, bundle))
    // --moss-silent alone means a silent setup; with --moss-uninstall it only means "no window".
    if (located && setupArg === null && (uninstall || !silent) && locator) {
      return {
        ...base,
        mode: uninstall ? 'uninstall' : 'installed',
        root: locator.root,
        launcher: null,
        appPath,
        recordPath,
        record,
        locator,
        portable: false,
        setup: null,
      }
    }
    const { origin, volume } = macOrigin(bundle)
    // This is the installed bundle, but its data (and install.json) cannot be found right now.
    const missingDataRoot =
      setupArg === null && locator?.appPath && samePath('darwin', locator.appPath, bundle) && !input.exists(locator.dataRoot)
        ? locator.dataRoot
        : null
    return { ...base, ...none, mode: 'setup', appPath, locator, setup: { ...setupRequest(origin, volume), missingDataRoot } }
  }

  const appPath = p.dirname(input.execPath)
  const launcherFile = launcherName(platform)
  if (setupArg !== null || (silent && installTo && input.packaged)) {
    return { ...base, ...none, mode: 'setup', appPath, locator: readLocatorFile(input, locPath), setup: setupRequest('stub', null) }
  }
  if (!input.packaged) return { ...base, ...none, mode: 'dev', appPath, locator: null, setup: null }

  // MOSSSTUDIO_ROOT counts only when it is exactly R of this exe's fixed layout,
  // R/app-<v>/MossStudio(.exe): a stale, inherited or ancestor value must not point the app
  // at someone else's install.json.
  const parent = p.dirname(appPath)
  const envValue = env['MOSSSTUDIO_ROOT']?.trim()
  const envRoot = envValue && samePath(platform, p.resolve(envValue), parent) ? parent : null
  const root = envRoot ? envRoot : input.exists(p.join(parent, RECORD_FILE)) || input.exists(p.join(parent, PORTABLE_FILE)) ? parent : null
  if (!root) {
    return { ...base, ...none, mode: uninstall ? 'uninstall' : 'loose', appPath, locator: null, setup: null }
  }
  const portable = input.exists(p.join(root, PORTABLE_FILE))
  const recordPath = p.join(root, RECORD_FILE)
  const envLauncher = env['MOSSSTUDIO_LAUNCHER']?.trim()
  const rootLauncher = launcherFile ? p.join(root, launcherFile) : null
  // Likewise MOSSSTUDIO_LAUNCHER only inside R.
  const launcher =
    envLauncher && isWithin(platform, root, p.resolve(envLauncher))
      ? p.resolve(envLauncher)
      : rootLauncher && input.exists(rootLauncher)
        ? rootLauncher
        : null
  return {
    ...base,
    mode: uninstall ? 'uninstall' : portable ? 'portable' : 'installed',
    root,
    launcher,
    appPath,
    recordPath,
    record: readRecord(input, recordPath),
    locator: portable ? null : readLocatorFile(input, locPath),
    portable,
    setup: null,
  }
}

function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function processDetectInput(): DetectInput {
  const platform = asOsPlatform(process.platform) ?? 'linux'
  return {
    argv: process.argv,
    env: process.env,
    execPath: process.execPath,
    packaged: app.isPackaged,
    platform,
    arch: process.arch,
    home: homedir(),
    exists: existsSync,
    readText: readTextOrNull,
  }
}

let cached: RunContext | null = null

/** The run context of this process, detected on first use and then fixed. */
export function getRunContext(): RunContext {
  cached ??= detectRunContext(processDetectInput())
  return cached
}

/** Tests only: forget the memoized context. */
export function resetRunContext(next: RunContext | null = null): void {
  cached = next
}
