/**
 * Where things live on each OS. Pure: every function takes the platform and the
 * environment it needs, so the Windows rules can be tested on any host (they use
 * path.win32) and the POSIX rules likewise (path.posix).
 */
import path from 'node:path'
import type { PlatformKey } from '@shared/install'

export type OsPlatform = 'win32' | 'linux' | 'darwin'

export const PRODUCT_NAME = 'MossStudio'
export const PUBLISHER = 'CloverIris'
/** Windows AppUserModelID: taskbar grouping, pins and toasts. Shortcuts carry the same id. */
export const APP_USER_MODEL_ID = 'com.cloveriris.mossstudio'
/** macOS bundle identifier (Info.plist CFBundleIdentifier) set by the pipeline. */
export const BUNDLE_ID = 'com.cloveriris.mossstudio'
/** HKCU uninstall entry; the old 1.0.x installer used the same key. */
export const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MossStudio'
export const BUNDLE_NAME = 'MossStudio.app'
export const RECORD_FILE = 'install.json'
export const PORTABLE_FILE = 'portable.json'
export const LOCATOR_FILE = 'locator.json'
export const READY_FILE = '.ready'

/** The environment the layout depends on. `env` holds LOCALAPPDATA, APPDATA, XDG_*. */
export interface HostInfo {
  platform: OsPlatform
  home: string
  env: Record<string, string | undefined>
}

export function pathFor(platform: OsPlatform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

export function asOsPlatform(platform: NodeJS.Platform): OsPlatform | null {
  return platform === 'win32' || platform === 'linux' || platform === 'darwin' ? platform : null
}

export function platformKey(platform: OsPlatform, arch: string): PlatformKey | null {
  if (platform === 'win32') return arch === 'x64' ? 'win32-x64' : null
  if (platform === 'linux') return arch === 'x64' ? 'linux-x64' : null
  return arch === 'arm64' ? 'darwin-arm64' : arch === 'x64' ? 'darwin-x64' : null
}

/** The launcher binary in R (Windows/Linux). macOS has no launcher. */
export function launcherName(platform: OsPlatform): string | null {
  return platform === 'win32' ? 'MossStudio.exe' : platform === 'linux' ? 'mossstudio' : null
}

/** The Electron executable inside app-<version>/. */
export function appExecutableName(platform: OsPlatform): string {
  return platform === 'win32' ? 'MossStudio.exe' : 'MossStudio'
}

export function appDirName(version: string): string {
  return `app-${version}`
}

const APP_DIR = /^app-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

/** The version of an `app-<version>` folder name, or null. */
export function versionOfAppDir(name: string): string | null {
  return APP_DIR.exec(name)?.[1] ?? null
}

function localAppData(host: HostInfo): string {
  const p = pathFor(host.platform)
  return host.env['LOCALAPPDATA']?.trim() || p.join(host.home, 'AppData', 'Local')
}

function roamingAppData(host: HostInfo): string {
  const p = pathFor(host.platform)
  return host.env['APPDATA']?.trim() || p.join(host.home, 'AppData', 'Roaming')
}

function xdg(host: HostInfo, name: 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME', fallback: string[]): string {
  const value = host.env[name]?.trim()
  return value && pathFor(host.platform).isAbsolute(value) ? value : pathFor(host.platform).join(host.home, ...fallback)
}

/** ~/Library/Application Support/MossStudio: the macOS default data root and the locator's folder. */
export function macSupportDir(host: HostInfo): string {
  return path.posix.join(host.home, 'Library', 'Application Support', PRODUCT_NAME)
}

/** Per-user pointer to the install (see installLocatorSchema). */
export function locatorPath(host: HostInfo): string {
  const p = pathFor(host.platform)
  if (host.platform === 'win32') return p.join(localAppData(host), PRODUCT_NAME, LOCATOR_FILE)
  if (host.platform === 'darwin') return p.join(macSupportDir(host), LOCATOR_FILE)
  return p.join(xdg(host, 'XDG_CONFIG_HOME', ['.config']), PRODUCT_NAME, LOCATOR_FILE)
}

/**
 * Default install location. Windows and Linux: R itself. macOS: the folder that will
 * hold MossStudio.app (/Applications, or ~/Applications when /Applications is not writable).
 */
export function defaultInstallRoot(host: HostInfo, applicationsWritable = true): string {
  const p = pathFor(host.platform)
  if (host.platform === 'win32') return p.join(localAppData(host), 'Programs', PRODUCT_NAME)
  if (host.platform === 'darwin') return applicationsWritable ? '/Applications' : p.join(host.home, 'Applications')
  return p.join(xdg(host, 'XDG_DATA_HOME', ['.local', 'share']), PRODUCT_NAME)
}

/** Default data root for a fresh install rooted at `root`. */
export function defaultDataRoot(host: HostInfo, root: string): string {
  return host.platform === 'darwin' ? macSupportDir(host) : pathFor(host.platform).join(root, 'data')
}

/** Where install.json lives: R (Windows/Linux) or the data root (macOS). */
export function recordPathFor(platform: OsPlatform, root: string, dataRoot: string): string {
  const p = pathFor(platform)
  return platform === 'darwin' ? p.join(dataRoot, RECORD_FILE) : p.join(root, RECORD_FILE)
}

export function windowsStartMenuShortcut(host: HostInfo): string {
  return path.win32.join(roamingAppData(host), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT_NAME}.lnk`)
}

export function windowsDesktopShortcut(desktopDir: string): string {
  return path.win32.join(desktopDir, `${PRODUCT_NAME}.lnk`)
}

export function linuxDesktopFile(host: HostInfo): string {
  return path.posix.join(xdg(host, 'XDG_DATA_HOME', ['.local', 'share']), 'applications', 'mossstudio.desktop')
}

export function linuxIconFile(host: HostInfo): string {
  return path.posix.join(xdg(host, 'XDG_DATA_HOME', ['.local', 'share']), 'icons', 'hicolor', '512x512', 'apps', 'mossstudio.png')
}

/** Absolute reg.exe, so a reg.exe planted on PATH or in the cwd is never run. */
export function regExePath(env: Record<string, string | undefined>): string {
  const systemRoot = env['SystemRoot']?.trim() || env['SYSTEMROOT']?.trim() || env['windir']?.trim() || 'C:\\Windows'
  return path.win32.join(systemRoot, 'System32', 'reg.exe')
}

/** Compare paths the way the OS does: case-insensitively on Windows and macOS (default APFS). */
export function samePath(platform: OsPlatform, a: string, b: string): boolean {
  const p = pathFor(platform)
  const norm = (value: string): string => {
    const resolved = p.resolve(value)
    const trimmed = resolved.length > p.parse(resolved).root.length ? resolved.replace(/[\\/]+$/, '') : resolved
    return platform === 'linux' ? trimmed : trimmed.toLowerCase()
  }
  return norm(a) === norm(b)
}

/** `target` equals `base` or lies below it. */
export function isWithin(platform: OsPlatform, base: string, target: string): boolean {
  const p = pathFor(platform)
  const fold = (value: string): string => (platform === 'linux' ? p.resolve(value) : p.resolve(value).toLowerCase())
  const rel = p.relative(fold(base), fold(target))
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))
}
