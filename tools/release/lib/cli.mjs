// Small helpers for the release command-line scripts.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop')
/** Default output folder of every release script (git-ignored). */
export const DIST_DIR = join(REPO_ROOT, 'dist', 'release')

/** Run a program with an argument array (never a shell string). Throws on a non-zero exit. */
export function run(command, args, options = {}) {
  const { capture = false, ...rest } = options
  const result = spawnSync(command, args, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...rest,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`)
  }
  return capture ? result.stdout : ''
}

export function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

/** Wrap a script's main so errors print one clear line and exit 1. */
export function main(fn) {
  Promise.resolve()
    .then(fn)
    .catch((error) => {
      console.error(`error: ${error?.stack ?? error}`)
      process.exit(1)
    })
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function desktopVersion() {
  return readJson(join(DESKTOP_DIR, 'package.json')).version
}

/** The host's platform key, e.g. 'linux-x64'. */
export function hostPlatform() {
  return `${process.platform}-${process.arch}`
}

/** Launcher binary built by launcher/build.sh for a platform (Windows and Linux only). */
export function launcherBinary(platform) {
  const name = { 'win32-x64': 'moss-launcher-win-x64.exe', 'linux-x64': 'moss-launcher-linux-x64' }[platform]
  if (!name) throw new Error(`no launcher for ${platform}`)
  const path = join(REPO_ROOT, 'launcher', 'dist', name)
  if (!existsSync(path)) throw new Error(`launcher binary missing: ${path} (run bash launcher/build.sh)`)
  return path
}
