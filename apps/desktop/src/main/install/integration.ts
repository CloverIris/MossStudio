/**
 * Desktop integration: Windows shortcuts (Start menu, desktop) to the launcher with the
 * app's AppUserModelID, and the Linux .desktop entry with its icon.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  APP_USER_MODEL_ID,
  PRODUCT_NAME,
  linuxDesktopFile,
  linuxIconFile,
  windowsDesktopShortcut,
  windowsStartMenuShortcut,
  type HostInfo,
} from './layout'

/** Electron's shell.writeShortcutLink options (the subset used here). */
export interface ShortcutOptions {
  target: string
  cwd: string
  description: string
  icon: string
  iconIndex: number
  appUserModelId: string
}

/** shell.writeShortcutLink, injected in tests. */
export type WriteShortcut = (path: string, operation: 'create' | 'replace' | 'update', options: ShortcutOptions) => boolean

export function windowsShortcutPaths(host: HostInfo, desktopDir: string): string[] {
  return [windowsStartMenuShortcut(host), windowsDesktopShortcut(desktopDir)]
}

export function shortcutOptions(launcher: string, root: string): ShortcutOptions {
  return {
    target: launcher,
    cwd: root,
    description: PRODUCT_NAME,
    icon: launcher,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID,
  }
}

/** Create or replace each shortcut. Returns the paths that could not be written. */
export function writeWindowsShortcuts(write: WriteShortcut, paths: string[], launcher: string, root: string): string[] {
  const failed: string[] = []
  for (const path of paths) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      if (!write(path, 'replace', shortcutOptions(launcher, root)) && !write(path, 'create', shortcutOptions(launcher, root)))
        failed.push(path)
    } catch {
      failed.push(path)
    }
  }
  return failed
}

/**
 * Quote one Exec argument (Desktop Entry spec): wrap in double quotes, backslash-escape
 * `"`, `` ` ``, `$` and `\`, then apply the string-level escaping (`\` → `\\`) and
 * double `%` so it is not read as a field code.
 */
export function desktopExecArg(arg: string): string {
  const quoted = `"${arg.replace(/[\\"`$]/g, (char) => `\\${char}`)}"`
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

/** A string value: escape `\`, newlines and tabs. */
function desktopString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
}

export function linuxDesktopEntry(launcher: string, icon: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${PRODUCT_NAME}`,
    'Comment=MOSS 图像创作工作室',
    `Exec=${desktopExecArg(launcher)} %U`,
    `Icon=${desktopString(icon)}`,
    'Terminal=false',
    'Categories=Graphics;',
    `StartupWMClass=${PRODUCT_NAME}`,
    '',
  ].join('\n')
}

export interface LinuxIntegration {
  desktopFile: string
  iconFile: string
}

export function linuxIntegrationPaths(host: HostInfo): LinuxIntegration {
  return { desktopFile: linuxDesktopFile(host), iconFile: linuxIconFile(host) }
}

/** Write the icon and the .desktop file. `iconBytes` null → the entry has no custom icon. */
export function writeLinuxIntegration(host: HostInfo, launcher: string, iconBytes: Buffer | null): LinuxIntegration {
  const paths = linuxIntegrationPaths(host)
  if (iconBytes && iconBytes.length > 0) {
    mkdirSync(dirname(paths.iconFile), { recursive: true })
    writeFileSync(paths.iconFile, iconBytes)
  }
  mkdirSync(dirname(paths.desktopFile), { recursive: true })
  writeFileSync(paths.desktopFile, linuxDesktopEntry(launcher, iconBytes ? paths.iconFile : 'mossstudio'), { mode: 0o644 })
  return paths
}
