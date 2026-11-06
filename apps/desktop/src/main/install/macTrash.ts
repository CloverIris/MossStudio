/**
 * macOS: move the app bundle to the Trash only after the app has quit.
 *
 * The uninstall runs inside the bundle it removes. Moving the bundle while the app runs pulls
 * the files out from under Chromium: a helper that starts or restarts afterwards (the network
 * service, a renderer) cannot find its resources and the app traps half way through. So the app
 * trashes everything else itself and leaves the bundle to this script, which waits for the app
 * and every process running from the bundle to end.
 *
 * The script text is static; the values arrive as positional arguments and are only used quoted.
 *   $1 pid     the app process to wait for
 *   $2 bundle  <R>/MossStudio.app
 * It trashes with NSFileManager (what shell.trashItem uses, so "Put Back" works and no
 * automation prompt appears) through osascript, falls back to a plain move into ~/.Trash, and
 * deletes itself on exit.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MAC_TRASH_HELPER = `#!/bin/sh
set -u
self="$0"
trap 'rm -f "$self"' EXIT
pid="$1"
bundle="$2"
inside="$bundle/Contents/"

log() {
  printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >&2
}

running() {
  ps -A -o command= 2>/dev/null | while read -r command; do
    case "$command" in
      "$inside"*) echo yes; break ;;
    esac
  done | grep -q yes
}

# 1. The app (at most 60 s), then whatever still runs from the bundle (at most 30 s more).
waited=0
while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 600 ]; do
  sleep 0.1
  waited=$((waited + 1))
done
waited=0
while running && [ "$waited" -lt 300 ]; do
  sleep 0.1
  waited=$((waited + 1))
done

[ -e "$bundle" ] || exit 0

# 2. The real Trash.
if [ -x /usr/bin/osascript ] && /usr/bin/osascript -l JavaScript -e '
function run(argv) {
  ObjC.import("Foundation")
  var url = $.NSURL.fileURLWithPath(argv[0])
  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, null, null)) throw new Error("not trashed")
}' "$bundle" >/dev/null 2>&1; then
  exit 0
fi

# 3. Fallback: a plain move into ~/.Trash under a name that is not taken.
trash="$HOME/.Trash"
mkdir -p "$trash" 2>/dev/null
name="$(basename "$bundle" .app)"
dest="$trash/$name.app"
n=1
while [ -e "$dest" ]; do
  dest="$trash/$name $n.app"
  n=$((n + 1))
done
if mv "$bundle" "$dest"; then
  exit 0
fi
log "could not move $bundle to the Trash"
exit 1
`

export type TrashSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => {
  pid?: number
  unref(): void
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * Write the helper to a private temp file and start it detached under /bin/sh. Resolves with the
 * helper's pid once it runs (the caller records it so exit never kills it).
 */
export async function trashBundleAfterExit(
  bundle: string,
  pid: number = process.pid,
  deps: { spawn?: TrashSpawnFn; tempDir?: string } = {},
): Promise<number | undefined> {
  const file = join(deps.tempDir ?? tmpdir(), `mossstudio-trash-${randomBytes(6).toString('hex')}.sh`)
  await writeFile(file, MAC_TRASH_HELPER, { encoding: 'utf8', mode: 0o700, flag: 'wx' })
  await chmod(file, 0o700)
  const child = (deps.spawn ?? nodeSpawn)('/bin/sh', [file, String(pid), bundle], { detached: true, stdio: 'ignore' })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (error) => reject(error))
    })
  } catch (error) {
    await rm(file, { force: true }).catch(() => undefined)
    throw new Error(`无法启动卸载助手：${error instanceof Error ? error.message : String(error)}`)
  }
  child.unref()
  return child.pid
}
