/**
 * macOS swap helper. The app cannot replace its own bundle while it runs, so on restart it writes
 * this script to a temp file and starts `/bin/sh <file> <args…>` detached, then quits.
 *
 * The script text is static: every value (paths with spaces or Chinese user names, the pid, the
 * versions) arrives as a positional argument and is only ever used quoted. Nothing is interpolated.
 *
 *   $1 pid        the app process to wait for
 *   $2 bundle     <R>/MossStudio.app
 *   $3 incoming   the bundle to switch to (.MossStudio-<v>.app, or a .previous bundle for rollback)
 *   $4 outgoing   where the running bundle goes (.MossStudio-<old>.app.previous)
 *   $5 record     install.json; the app writes it one key per line (JSON.stringify(…, null, 2))
 *   $6 timeout    seconds to wait for the confirmation (HEALTH_TIMEOUT_MS / 1000)
 *   $7 marker     file that receives the incoming version when it is rolled back
 *   $8 version    the incoming version
 *   $9 opener     /usr/bin/open
 *   $10 from      the version that asked for the swap; install.json's current must still be it
 *   $11 clean     file the incoming app writes (its version) when it quits cleanly before confirming
 *
 * install.json is NOT switched before the swap: the incoming app reconciles it from the bundle
 * that actually runs (current = running version). The helper only reads it:
 *   - current is not $from when the app has exited → not this helper's swap: move nothing,
 *     reopen the bundle as it is, exit 4.
 *   - after current became $version, it changed again → someone moved on: exit 4.
 *   - current = $version and confirmed = true → exit 0.
 *   - the new process is gone (or never started by the timeout) without confirming → roll back,
 *     unless it left the clean-exit marker. A live, unconfirmed app is never killed: at the
 *     timeout it is left running (exit 3) and its next launch is watched again.
 * The script deletes itself on every exit path.
 *
 * Exit codes: 0 confirmed, 1 could not swap (old bundle reopened), 2 rolled back,
 * 3 left as is (alive and unconfirmed, or a clean unconfirmed exit), 4 not this helper's swap.
 */
export const MAC_SWAP_HELPER = `#!/bin/sh
set -u
self="$0"
trap 'rm -f "$self"' EXIT
pid="$1"
bundle="$2"
incoming="$3"
outgoing="$4"
record="$5"
timeout="$6"
marker="$7"
version="$8"
opener="$9"
from="\${10}"
clean="\${11}"
exe="$bundle/Contents/MacOS/"

log() {
  printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >&2
}

current_of() {
  sed -n 's/^[[:space:]]*"current"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*$/\\1/p' "$record" 2>/dev/null | head -n 1
}

confirmed_of() {
  sed -n 's/^[[:space:]]*"confirmed"[[:space:]]*:[[:space:]]*\\([a-z]*\\).*$/\\1/p' "$record" 2>/dev/null | head -n 1
}

running() {
  ps -A -o command= 2>/dev/null | while read -r command; do
    case "$command" in
      "$exe"*) echo yes; break ;;
    esac
  done | grep -q yes
}

roll_back() {
  log "$version did not confirm; rolling back to $from"
  rm -rf "$incoming"
  mv "$bundle" "$incoming"
  mv "$outgoing" "$bundle"
  printf '%s\\n' "$version" > "$marker.tmp" && mv "$marker.tmp" "$marker"
  "$opener" -n "$bundle"
  exit 2
}

# 1. Wait for the app to exit (at most 60 s).
waited=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge 600 ]; then
    log "app $pid still running after 60 s; swapping anyway"
    break
  fi
  sleep 0.1
  waited=$((waited + 1))
done

# 2. Only swap what this helper was started for.
if [ "$(current_of)" != "$from" ]; then
  log "install.json no longer describes $from; leaving the bundles alone"
  "$opener" -n "$bundle"
  exit 4
fi

# 3. Swap: running bundle -> outgoing, incoming -> bundle.
if [ ! -d "$incoming" ]; then
  log "missing incoming bundle"
  "$opener" -n "$bundle"
  exit 1
fi
rm -rf "$outgoing"
if ! mv "$bundle" "$outgoing"; then
  log "could not move the running bundle aside"
  "$opener" -n "$bundle"
  exit 1
fi
if ! mv "$incoming" "$bundle"; then
  log "could not move the incoming bundle in; restoring"
  mv "$outgoing" "$bundle"
  "$opener" -n "$bundle"
  exit 1
fi

# 4. Start the new bundle and watch it.
rm -f "$clean"
"$opener" -n "$bundle"
limit=$((timeout * 10))
tick=0
seen=0
started=0
while [ "$tick" -lt "$limit" ]; do
  current="$(current_of)"
  if [ "$current" = "$version" ]; then
    seen=1
    if [ "$(confirmed_of)" = "true" ]; then
      log "confirmed"
      exit 0
    fi
  elif [ "$seen" = 1 ]; then
    log "install.json moved on to $current; nothing left to do"
    exit 4
  fi
  if running; then
    started=1
  elif [ "$started" = 1 ]; then
    if [ -f "$clean" ] && [ "$(cat "$clean")" = "$version" ]; then
      rm -f "$clean"
      log "$version quit cleanly before confirming; leaving it"
      exit 3
    fi
    roll_back
  fi
  sleep 0.1
  tick=$((tick + 1))
done

# 5. Timeout: never kill a live app; roll back only when it never started.
if running; then
  log "$version is running but unconfirmed after $timeout s; leaving it"
  exit 3
fi
roll_back
`

export interface MacSwapArgs {
  pid: number
  bundle: string
  incoming: string
  outgoing: string
  record: string
  timeoutSeconds: number
  marker: string
  version: string
  /** The running version (install.json's current while it asks for the swap). */
  from: string
  /** The clean-exit marker (see cleanExitMarkerPath). */
  clean: string
  opener?: string
}

/** The positional arguments, in the order the script reads them. */
export function macSwapArgs(args: MacSwapArgs): string[] {
  return [
    String(args.pid),
    args.bundle,
    args.incoming,
    args.outgoing,
    args.record,
    String(Math.max(1, Math.round(args.timeoutSeconds))),
    args.marker,
    args.version,
    args.opener ?? '/usr/bin/open',
    args.from,
    args.clean,
  ]
}
