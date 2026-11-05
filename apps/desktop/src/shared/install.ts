/**
 * The contract between the launcher (Go, `launcher/`), the app's install and
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

export const UPDATE_CHANNELS = ['stable', 'beta'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

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
  channel: z.enum(UPDATE_CHANNELS),
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

const asset = z.object({
  /** Absolute https URL on GitHub; mirrors are applied by the client as transport only. */
  url: z.string().url(),
  sha256,
  size: z.number().int().positive(),
})
export type FeedAsset = z.infer<typeof asset>

/** One platform's downloads for one version. */
export const feedPlatformSchema = z.object({
  /** Zip of the app folder (Win/Linux: the contents of app-<version>; macOS: MossStudio.app). Symlinks preserved. */
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
 * Where feeds live: a rolling GitHub release tagged `updates` whose assets are replaced on
 * every release. Version artifacts live in that version's own release `v<version>`.
 */
export const FEED_REPO = 'CloverIris/MossStudio'
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

/** The app calls confirm after its window has been shown and stayed up this long. */
export const HEALTH_CONFIRM_MS = 8_000
/** The launcher rolls back if the new version neither confirmed nor stayed alive this long. */
export const HEALTH_TIMEOUT_MS = 60_000
