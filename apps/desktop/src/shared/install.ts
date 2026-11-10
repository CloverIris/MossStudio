/**
 * The contract between the launcher (Go, `apps/launcher/`), the app's install and
 * update code (main process), the UI and the release pipeline.
 *
 * Install root R, chosen once on first install:
 *   Windows  R\MossStudio.exe   launcher (stable path for shortcuts, pins, uninstall)
 *            R\app-<version>\   one Electron app folder per version (MossStudio.exe inside)
 *            R\data\            user data (unless install.json says dataRoot is elsewhere)
 *            R\install.json     InstallRecord
 *            R\portable.json    present only in portable packages
 *   Linux    R/mossstudio, R/app-<version>/, R/data/, R/install.json, R/portable.json
 *   macOS    <chosen folder>/MossStudio.app (the bundle is swapped on update)
 *            data: ~/Library/Application Support/MossStudio unless chosen otherwise
 *            R = the folder that holds MossStudio.app; install.json lives in the data root
 *
 * Every file here is written atomically (temp file + rename). Paths are absolute.
 */
import { z } from 'zod'

export const PLATFORM_KEYS = ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'] as const
export type PlatformKey = (typeof PLATFORM_KEYS)[number]

/** The feeds a client can follow. `nightly` is signed by its own key (NIGHTLY_UPDATE_KEYS). */
export const UPDATE_CHANNELS = ['stable', 'beta', 'nightly'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

/**
 * The channels install.json may hold. Launchers already installed accept only these and are not
 * replaced by updates, so a client on `nightly` records `beta` there.
 */
export const RECORD_CHANNELS = ['stable', 'beta'] as const
export type RecordChannel = (typeof RECORD_CHANNELS)[number]

const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'not a semver version')
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const absPath = z.string().min(1)

/** R/install.json (macOS: <data root>/install.json). Read by the launcher and the app. */
export const installRecordSchema = z.object({
  schema: z.literal(1),
  platform: z.enum(PLATFORM_KEYS),
  /** Install root (macOS: folder holding MossStudio.app). */
  root: absPath,
  /** macOS only: the bundle path. */
  appPath: absPath.optional(),
  dataRoot: absPath,
  portable: z.boolean(),
  channel: z.enum(RECORD_CHANNELS),
  /** The version the launcher starts. */
  current: semver,
  /** Kept for rollback; the launcher falls back to it. */
  previous: semver.optional(),
  /** Downloaded, verified and materialized as app-<pending>; switched to on the next launch. */
  pending: semver.optional(),
  /** Versions that failed their health check; never offered or switched to again. */
  failed: z.array(semver).default([]),
  /** Set by the app (health check) once `current` started successfully. */
  confirmed: z.boolean(),
  installedAt: z.string(),
  updatedAt: z.string(),
})
export type InstallRecord = z.infer<typeof installRecordSchema>

/**
 * Per-user pointer that lets a later Setup find the install without asking:
 *   Windows %LOCALAPPDATA%\MossStudio\locator.json
 *   Linux   ${XDG_CONFIG_HOME:-~/.config}/MossStudio/locator.json
 *   macOS   ~/Library/Application Support/MossStudio/locator.json
 * Portable packages never write it.
 */
export const installLocatorSchema = z.object({
  schema: z.literal(1),
  root: absPath,
  appPath: absPath.optional(),
  dataRoot: absPath,
  version: semver,
})
export type InstallLocator = z.infer<typeof installLocatorSchema>

/**
 * Left by an uninstall that kept the data (Windows/Linux), next to where the locator was:
 * <locator folder>/kept-data.json. A later first install offers to keep using `dataRoot`.
 * Setup removes it once an install has been made; the data itself is never touched.
 */
export const keptDataSchema = z.object({
  schema: z.literal(1),
  /** The install root the data belonged to. */
  root: absPath,
  dataRoot: absPath,
  version: semver,
  keptAt: z.string(),
})
export type KeptData = z.infer<typeof keptDataSchema>

const asset = z.object({
  /** Absolute https URL on GitHub; mirrors are applied by the client as transport only. */
  url: z.string().url(),
  sha256,
  size: z.number().int().positive(),
})
export type FeedAsset = z.infer<typeof asset>

/** One platform's downloads for one version. */
export const feedPlatformSchema = z.object({
  /** Zip of the app folder (Win/Linux: the contents of app-<version>; macOS: the contents of MossStudio.app, i.e. Contents/...). Symlinks preserved. */
  full: asset,
  /** JSON file list of the full package: FileList. Used to verify and to build from deltas. */
  files: asset,
  /** Changed files only, relative to an earlier version. */
  deltas: z.array(asset.extend({ from: semver })).default([]),
  /** First-install downloads, for the release page and the in-app "download installer" link. */
  setup: asset.optional(),
  portable: asset.optional(),
})

/** update-<channel>.json, signed. Unknown keys are allowed and ignored (forward compatible). */
export const updateFeedSchema = z
  .object({
    schema: z.literal(1),
    channel: z.enum(UPDATE_CHANNELS),
    version: semver,
    publishedAt: z.string(),
    /** Markdown, shown in the update UI. */
    notes: z.string().max(20_000).default(''),
    notesUrl: z.string().url().optional(),
    /** Clients older than this must update before generating again (shown as required). */
    minimumVersion: semver.optional(),
    /** Unknown platform keys are ignored, not rejected. */
    platforms: z.record(z.string(), feedPlatformSchema),
    announcements: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            level: z.enum(['info', 'warning', 'critical']).catch('info'),
            title: z.string().max(200),
            body: z.string().max(4000).default(''),
            url: z.string().url().optional(),
            until: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough()
export type UpdateFeed = z.infer<typeof updateFeedSchema>

/**
 * update-<channel>.json.sig: JSON `{ keyId, signature }`, signature = base64 Ed25519 over the
 * exact bytes of update-<channel>.json. The client verifies BEFORE parsing and trusts nothing
 * (version, URLs, hashes) from an unverified feed.
 */
export const feedSignatureSchema = z.object({
  keyId: z.string().min(1).max(64),
  signature: z.string().min(1).max(256),
})

/** files-<version>-<platform>.json: every regular file and symlink of the full package. */
export const fileListSchema = z.object({
  schema: z.literal(1),
  version: semver,
  platform: z.enum(PLATFORM_KEYS),
  entries: z.array(
    z.union([
      z.object({ path: z.string().min(1), type: z.literal('file'), sha256, size: z.number().int().nonnegative(), mode: z.number().int() }),
      z.object({ path: z.string().min(1), type: z.literal('symlink'), target: z.string().min(1) }),
    ]),
  ),
})
export type FileList = z.infer<typeof fileListSchema>

/**
 * delta.json at the root of MossStudio-<from>-to-<to>-<platform>.delta.zip. Every new or changed
 * entry of the target FileList (files-<to>-<platform>.json) is stored in the zip as
 * `files/<path>` (symlinks as symlink entries, as in the full zip). To materialize app-<to>: for
 * each entry of the target FileList take `files/<path>` when the path is in `changed`, else copy
 * it from app-<from>; then verify every entry against the target FileList. `removed` lists the
 * paths of `from` that `to` no longer has (they are simply not copied).
 */
export const deltaManifestSchema = z.object({
  schema: z.literal(1),
  platform: z.enum(PLATFORM_KEYS),
  from: semver,
  to: semver,
  /** sha256/size of the exact files-<to>-<platform>.json bytes this delta was built against. */
  files: z.object({ sha256, size: z.number().int().positive() }),
  changed: z.array(z.string().min(1)),
  removed: z.array(z.string().min(1)),
})
export type DeltaManifest = z.infer<typeof deltaManifestSchema>
export const DELTA_MANIFEST_NAME = 'delta.json'
export const DELTA_FILES_PREFIX = 'files/'

/** R/portable.json (macOS: next to MossStudio.app): marks a portable root. Written by the pipeline. */
export const portableMarkerSchema = z.object({
  schema: z.literal(1),
  /** The version the package shipped with (app-<version>/); install.json is written on first start. */
  version: semver,
})
export type PortableMarker = z.infer<typeof portableMarkerSchema>

/**
 * Where feeds live: a rolling GitHub release tagged `updates` whose assets are replaced on
 * every release. Version artifacts live in that version's own release `v<version>`.
 */
export const FEED_REPO = 'ShallowElec/MossStudio'
export function feedUrl(channel: UpdateChannel): string {
  return `https://github.com/${FEED_REPO}/releases/download/updates/update-${channel}.json`
}

/**
 * Launcher ⇄ app command line.
 *   Setup stub → app:      --moss-setup=<payloadDir>        app opens the setup window
 *                          (+ --moss-silent --moss-install-to=<dir> for unattended installs)
 *   Launcher → app:        --moss-launched                  started by the launcher (health check armed)
 *   Registry/Settings → launcher: --uninstall               launcher starts current app with --moss-uninstall
 *   App → launcher copy:   --finish-uninstall=<plan.json>   deletes the files the plan lists after the app exits
 *   App → launcher:        --restart                        app is quitting to apply `pending`; launcher waits for it
 * Environment set by the launcher for the app: MOSSSTUDIO_ROOT=<R>, MOSSSTUDIO_LAUNCHER=<launcher path>.
 */
export const SETUP_ARG = '--moss-setup'
export const SILENT_ARG = '--moss-silent'
export const INSTALL_TO_ARG = '--moss-install-to'
export const LAUNCHED_ARG = '--moss-launched'
export const UNINSTALL_ARG = '--moss-uninstall'
export const FINISH_UNINSTALL_ARG = '--finish-uninstall'

/**
 * The uninstall plan the app writes for `<temp launcher copy> --finish-uninstall=<plan.json>`
 * (plan.json and the launcher copy share one fresh temp folder, removed last). The launcher
 * waits for every process whose executable is under `root` to exit, then deletes exactly the
 * `remove` entries (directories recursively, missing ones skipped), deletes `registryKeys`,
 * removes each `removeEmptyDirs` entry only if it is empty, and touches nothing else.
 */
export const uninstallPlanSchema = z.object({
  schema: z.literal(1),
  platform: z.enum(PLATFORM_KEYS),
  /** Install root R. */
  root: absPath,
  dataRoot: absPath,
  /** The user ticked 同时删除我的数据: dataRoot itself is then in `remove`. */
  removeData: z.boolean(),
  /**
   * Exact files or folders to delete, in order. Each is inside root or dataRoot, or is one of
   * the shortcut, .desktop, icon or locator files the install created.
   */
  remove: z.array(absPath),
  /** Windows: registry keys to delete (`reg delete <key> /f`); always under HKCU. */
  registryKeys: z.array(z.string().regex(/^HKCU\\/)).default([]),
  /** Removed afterwards only when empty (never recursively): R, the locator's folder. */
  removeEmptyDirs: z.array(absPath).default([]),
  /**
   * Windows/Linux, only with removeData: Electron's profile folder (app.getPath('userData'):
   * %APPDATA%\MossStudio, ${XDG_CONFIG_HOME:-~/.config}/MossStudio), deleted recursively after
   * `remove`. Basename exactly MossStudio, outside R; the launcher accepts only that OS folder.
   */
  profileDir: absPath.optional(),
  createdAt: z.string(),
})
export type UninstallPlan = z.infer<typeof uninstallPlanSchema>

/** The app calls confirm after its window has been shown and stayed up this long. */
export const HEALTH_CONFIRM_MS = 8_000
/** The launcher rolls back if the new version neither confirmed nor stayed alive this long. */
export const HEALTH_TIMEOUT_MS = 60_000
