/**
 * IPC types for the setup window (/install) and the uninstall window (/uninstall, or
 * Settings › 关于 › 卸载 on Linux and macOS). Channels: Ipc.install* / Ipc.uninstall*,
 * events: Events.install* (shared/channels.ts). Main: src/main/install/.
 */
import { z } from 'zod'

export type SetupPlatform = 'win32' | 'linux' | 'darwin'

/** first: nothing installed; update/repair/downgrade: a locator points at an install (no location questions). */
export type SetupKind = 'first' | 'update' | 'repair' | 'downgrade'
export type SetupPhase = 'idle' | 'installing' | 'done' | 'failed'

export type SetupLocationCode =
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

export interface SetupLocationCheck {
  /** Normalized absolute path that was checked. */
  path: string
  ok: boolean
  /** missing/empty: fresh; install: an existing MossStudio root (repair); legacy: an old 1.0.x folder (converted in place); data: existing MossStudio data. */
  kind: 'missing' | 'empty' | 'install' | 'legacy' | 'data' | 'occupied'
  problem: { code: SetupLocationCode; message: string } | null
  /** Offer this instead (e.g. <chosen>\MossStudio for a non-empty folder). */
  suggestion: string | null
  freeBytes: number | null
  requiredBytes: number
}

export interface SetupLegacyInstall {
  root: string
  dataDir: string
  /** Size of the old data folder; null until measured (an Events.installState follows). */
  dataBytes: number | null
  version: string | null
  source: 'registry' | 'default' | 'picked'
  /**
   * What happens to the old folder, per choice. Show `warnings[mode]` for the chosen mode
   * (use `legacyWarning`); nothing when installing into the old folder itself (in place).
   *   reuse: its data\ stays in use by the new version: do NOT delete the folder
   *   fresh: its files stay; it may be deleted once no longer needed
   * On Windows both also say it leaves 设置 › 应用 (the new install takes over its entry).
   */
  warnings: { reuse: string; fresh: string }
}

export interface SetupProgress {
  phase: 'prepare' | 'convert' | 'copy' | 'launcher' | 'record' | 'integrate' | 'done'
  /** 0–100 over the whole install. */
  percent: number
  copiedBytes: number
  totalBytes: number
  file?: string
}

export interface SetupResult {
  root: string
  dataRoot: string
  version: string
  /** The installed app-<v> folder or MossStudio.app. */
  appPath: string
  /** Steps that failed without failing the install (shortcuts, registry). */
  warnings: string[]
}

export interface SetupState {
  platform: SetupPlatform
  /** The version this setup installs. */
  version: string
  kind: SetupKind
  /** The located install (kind ≠ first). */
  installed: { root: string; dataRoot: string; version: string } | null
  /** Default install location (macOS: the folder holding MossStudio.app) and, on macOS, the default data folder. */
  defaults: { root: string; dataRoot: string | null }
  /** The proposed install location (installed root, or the default) and its check. */
  location: SetupLocationCheck
  /** macOS only: the proposed data folder (高级) and its check. */
  dataLocation: SetupLocationCheck | null
  /** An old 1.0.x install (kind first, Windows/Linux). */
  legacy: SetupLegacyInstall | null
  requiredBytes: number
  phase: SetupPhase
  progress: SetupProgress | null
  result: SetupResult | null
  error: { code: string; message: string } | null
  /** macOS from a DMG: install:launch may eject it. */
  canEject: boolean
  /** This setup's log (install:open-log { log: 'setup' }). */
  logPath: string
  /** The located install's launcher log, <dataRoot>/logs/launcher.log, when it exists (install:open-log { log: 'launcher' }). */
  launcherLogPath: string | null
}

export interface SetupFolderChoice {
  canceled: boolean
  path: string | null
  /** purpose install/data: the check of the chosen folder. */
  check: SetupLocationCheck | null
  /** purpose legacy: the old install in the chosen folder, or null when it is not one. */
  legacy: SetupLegacyInstall | null
}

export interface UninstallInfo {
  platform: SetupPlatform
  /** plan: a launcher copy deletes the planned files after the app quits; trash: macOS moves the bundle to the Trash. */
  method: 'plan' | 'trash'
  root: string
  dataRoot: string
  /** Size of the data folder; null when it could not be measured in time. */
  dataBytes: number | null
  version: string
  portable: boolean
  /** Another MossStudio (same user) is running; uninstall:start fails with E_APP_RUNNING until it is closed. */
  running: boolean
}

/** The note to show under the old-install card for the chosen mode; null in place. */
export function legacyWarning(legacy: Pick<SetupLegacyInstall, 'warnings'>, mode: 'reuse' | 'fresh', inPlace: boolean): string | null {
  return inPlace ? null : legacy.warnings[mode]
}

export const setupSchemas = {
  chooseFolder: z.object({
    purpose: z.enum(['install', 'data', 'legacy']),
    defaultPath: z.string().optional(),
  }),
  validate: z.object({
    path: z.string(),
    purpose: z.enum(['install', 'data']),
  }),
  inspectLegacy: z.object({ path: z.string().min(1) }),
  start: z.object({
    /** Ignored for update/repair/downgrade (the located root is used). */
    root: z.string().min(1),
    /** macOS only (高级); omitted = default. */
    dataRoot: z.string().min(1).nullish(),
    /** reuse: dataRoot = <old>/data (继续使用这些数据); fresh: new data (重新开始). Installing into the old folder always reuses. */
    legacy: z.object({ root: z.string().min(1), mode: z.enum(['reuse', 'fresh']) }).nullish(),
    /** Required true when kind is downgrade (the user confirmed once). */
    allowDowngrade: z.boolean().optional(),
  }),
  launch: z.object({ eject: z.boolean().optional() }),
  openLog: z.object({ log: z.enum(['setup', 'launcher']).default('setup') }),
  uninstallStart: z.object({ removeData: z.boolean() }),
}

export type SetupChooseFolderInput = z.infer<typeof setupSchemas.chooseFolder>
export type SetupValidateInput = z.infer<typeof setupSchemas.validate>
export type SetupStartInput = z.infer<typeof setupSchemas.start>
export type SetupLaunchInput = z.infer<typeof setupSchemas.launch>
export type UninstallStartInput = z.infer<typeof setupSchemas.uninstallStart>
