#!/usr/bin/env bash
# Persistent byte-transfer worker. Manifests/JSON are prepared and parsed by TS.
set -o pipefail
umask 077
ROOT="${MOSS_DOWNLOAD_ROOT:-$HOME/.mossstudio/downloads}"
SELF=$(readlink -f "$0")
mkdir -p "$ROOT/slots"

b64() { base64 | tr -d '\n'; }
size() { stat -c %s "$1" 2>/dev/null || printf 0; }
control() { read -r control_generation desired 2>/dev/null < "$directory/shell-control"; }
running() { control && test "$control_generation" = "$generation" && test "$desired" = running; }
file_state() { printf '%s\n' "$1" > "$directory/file-$index.state.tmp.$BASHPID" && mv "$directory/file-$index.state.tmp.$BASHPID" "$directory/file-$index.state"; }
redact() {
  local message secret
  message=$(cat "$1" 2>/dev/null)
  while IFS= read -r secret; do
    secret=$(printf '%s' "$secret" | base64 -d)
    test -z "$secret" || message="${message//"$secret"/[redacted]}"
  done 2>/dev/null < "$ROOT/redact"
  printf '%s' "$message"
}
publish() {
  local state="$1" bytes="$2" speed="$3" completed="$4" current="$5" error="$6"
  (
    flock -x 6 || exit 1
    control || exit 1
    test "$control_generation" = "$generation" || exit 0
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$generation" "$state" "$bytes" "$speed" "$completed" \
      "$(test -n "$current" && printf '%s' "$current" | b64 || printf -)" \
      "$(test -n "$error" && printf '%s' "$error" | b64 || printf -)" "$(date +%s)" > "$directory/shell-state.tmp.$BASHPID" &&
      mv "$directory/shell-state.tmp.$BASHPID" "$directory/shell-state"
  ) 6> "$directory/request.lock"
}
wait_child() {
  while kill -0 "$child" 2>/dev/null; do
    if ! running; then kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; child=; return 75; fi
    sleep .2
  done
  wait "$child"; local code=$?; child=; return "$code"
}
verify() {
  local path="$1" actual code
  test -f "$path" && test "$(size "$path")" -eq "$expected_size" || return 1
  test -n "$expected_hash" || return 0
  file_state verifying || return 1
  if test "${#expected_hash}" -eq 64; then
    sha256sum "$path" > "$directory/hash-$index.tmp" & child=$!
  else
    (printf 'blob %s\0' "$expected_size"; cat "$path") | sha1sum > "$directory/hash-$index.tmp" & child=$!
  fi
  wait_child; code=$?; test "$code" -eq 0 || return "$code"
  read -r actual _ < "$directory/hash-$index.tmp"
  test "$actual" = "$expected_hash"
}
slot() {
  local limit number
  while running; do
    read -r limit < "$ROOT/concurrency"; [[ "$limit" =~ ^([1-9]|1[0-6])$ ]] || limit=4
    for ((number=1;number<=limit;number++)); do
      exec 8> "$ROOT/slots/$number.lock"
      if flock -n 8; then return 0; fi
      exec 8>&-
    done
    sleep .2
  done
  return 75
}
download_one() {
  directory="$1"; generation="$2"; index="$3"
  source "$directory/shell-spec" || return 1
  local target="$snapshot/${file_paths[$index]}" part expected_size="${file_sizes[$index]}" expected_hash="${file_hashes[$index]}"
  local attempt code http error child=
  part="$target.part"
  trap 'test -z "$child" || { kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; }; exit 75' TERM HUP INT
  mkdir -p "$(dirname "$target")" || return 1
  local resolved_root resolved_target resolved_part
  resolved_root=$(readlink -f "$snapshot") || return 1
  resolved_target=$(readlink -m "$target"); resolved_part=$(readlink -m "$part")
  case "$resolved_target" in "$resolved_root"/*) ;; *) echo '模型文件超出快照目录' > "$directory/file-$index.error"; return 1;; esac
  case "$resolved_part" in "$resolved_root"/*) ;; *) echo '模型分片超出快照目录' > "$directory/file-$index.error"; return 1;; esac
  exec 7> "$target.moss-lock" || return 1
  until flock -n 7; do running || return 75; sleep .2; done
  verify "$target"; code=$?
  test "$code" -ne 75 || return 75
  if test "$code" -eq 0; then file_state done; return 0; fi
  if test -f "$target"; then
    if test -f "$part"; then rm -f "$target" || return 1; else mv "$target" "$part" || return 1; fi
  fi
  test "$(size "$part")" -le "$expected_size" || rm -f "$part"
  for attempt in 1 2 3 4; do
    running || return 75
    verify "$part"; code=$?
    test "$code" -ne 75 || return 75
    if test "$code" -eq 0; then break; fi
    if test -f "$part" && test "$(size "$part")" -ge "$expected_size"; then rm -f "$part" || return 1; fi
    slot || return $?
    file_state running || return 1
    curl -q --config "$ROOT/network.curl" --location --fail --silent --show-error \
      --proto '=http,https' --proto-redir '=http,https' --connect-timeout 15 --retry 3 \
      --retry-connrefused --speed-limit 1024 --speed-time 60 --continue-at - \
      --output "$part" --write-out '%{http_code}' --url "${file_urls[$index]}" \
      > "$directory/http-$index.tmp" 2> "$directory/error-$index.tmp" & child=$!
    wait_child; code=$?
    exec 8>&-
    test "$code" -ne 75 || return 75
    running || return 75
    http=$(cat "$directory/http-$index.tmp" 2>/dev/null)
    if test "$code" -ne 0; then
      if test "$code" -eq 33 || test "$code" -eq 36 || test "$http" = 416; then
        rm -f "$part"; continue
      fi
      case "$code" in 5|6|7|18|28|52|55|56) sleep "$attempt"; continue;; esac
      redact "$directory/error-$index.tmp" > "$directory/file-$index.error"
      return 1
    fi
    verify "$part"; code=$?
    test "$code" -ne 75 || return 75
    if test "$code" -eq 0; then break; fi
    test "$(size "$part")" -lt "$expected_size" || rm -f "$part"
  done
  running || return 75
  verify "$part"; code=$?
  test "$code" -ne 75 || return 75
  if test "$code" -ne 0; then printf '文件大小或哈希校验失败：%s' "${file_paths[$index]}" > "$directory/file-$index.error"; return 1; fi
  mv "$part" "$target" || return 1
  file_state done
}

run_task() {
  directory="$1"; generation="$2"
  exec 9> "$directory/shell-worker.lock" || return 1
  flock -n 9 || return 0
  running || return 0
  source "$directory/shell-spec" || return 1
  local count="${#file_paths[@]}" next=0 completed=0 transferred=0 current= state=running speed=0
  local pid number value old_bytes=-1 old_time=0 now free remaining=0 code failure=
  declare -A jobs=()
  stop_children() { for pid in "${jobs[@]}"; do kill "$pid" 2>/dev/null; done; for pid in "${jobs[@]}"; do wait "$pid" 2>/dev/null; done; jobs=(); }
  trap 'stop_children; exit 0' TERM HUP INT
  trap stop_children EXIT
  mkdir -p "$snapshot" || return 1
  for ((number=0;number<count;number++)); do
    rm -f "$directory/file-$number.state" "$directory/file-$number.error"
    value=$(size "$snapshot/${file_paths[$number]}")
    test "$value" -ge "$(size "$snapshot/${file_paths[$number]}.part")" || value=$(size "$snapshot/${file_paths[$number]}.part")
    test "$value" -le "${file_sizes[$number]}" || value="${file_sizes[$number]}"
    remaining=$((remaining+file_sizes[number]-value))
  done
  free=$(df -PB1 "$snapshot" | awk 'NR==2 {print $4}')
  if test -z "$free" || test "$free" -lt "$((remaining+67108864))"; then publish error 0 0 0 '' '远端模型磁盘空间不足'; return 1; fi
  while :; do
    if ! running; then
      stop_children; control
      test "$desired" = canceled && state=canceled || state=paused
      publish "$state" "$transferred" 0 "$completed" "$current" ''; return 0
    fi
    for number in "${!jobs[@]}"; do
      pid="${jobs[$number]}"
      if ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid"; code=$?; unset 'jobs[$number]'
        if test "$code" -ne 0; then failure=$(cat "$directory/file-$number.error" 2>/dev/null); test -n "$failure" || failure='远端文件传输失败'; fi
      fi
    done
    if test -n "$failure"; then stop_children; publish error "$transferred" 0 "$completed" "$current" "$failure"; return 1; fi
    read -r limit < "$ROOT/concurrency"; [[ "$limit" =~ ^([1-9]|1[0-6])$ ]] || limit=4
    while test "$next" -lt "$count" && test "${#jobs[@]}" -lt "$limit"; do
      bash "$SELF" file "$directory" "$generation" "$next" & jobs[$next]=$!; next=$((next+1))
    done
    transferred=0; completed=0; current=; state=verifying
    for ((number=0;number<count;number++)); do
      value=$(size "$snapshot/${file_paths[$number]}")
      test "$value" -ge "$(size "$snapshot/${file_paths[$number]}.part")" || value=$(size "$snapshot/${file_paths[$number]}.part")
      test "$value" -le "${file_sizes[$number]}" || value="${file_sizes[$number]}"
      transferred=$((transferred+value))
      read -r file_status 2>/dev/null < "$directory/file-$number.state" || file_status=queued
      if test "$file_status" = done; then completed=$((completed+1)); else
        test -n "$current" || current="${file_paths[$number]}"
        test "$file_status" = verifying || state=running
      fi
    done
    now=$(date +%s)
    if test "$old_bytes" -ge 0 && test "$now" -gt "$old_time"; then speed=$(((transferred-old_bytes)/(now-old_time))); test "$speed" -ge 0 || speed=0; old_bytes="$transferred"; old_time="$now";
    elif test "$old_bytes" -lt 0; then old_bytes="$transferred"; old_time="$now"; fi
    publish "$state" "$transferred" "$speed" "$completed" "$current" ''
    test "$next" -lt "$count" || test "${#jobs[@]}" -ne 0 || break
    sleep .5
  done
  running || return 0
  mkdir -p "$cache/refs" || return 1
  printf '%s\n' "$sha" > "$cache/refs/$ref_name" || return 1
  publish done "$total_bytes" 0 "$count" '' ''
}

snapshot() {
  local directory name generation desired state
  for directory in "$ROOT"/task-*; do
    test -d "$directory" || continue
    name="${directory##*/}"
    if test -f "$directory/shell-meta.json"; then
      read -r generation desired < "$directory/shell-control" || continue
      printf 'NATIVE\t%s\t' "$name"; b64 < "$directory/shell-meta.json"
      printf '\t%s\t%s\t%s\n' "$generation" "$desired" "$(cat "$directory/shell-state" 2>/dev/null)"
    elif test -f "$directory/state.json"; then
      printf 'LEGACY\t%s\t' "$name"
      for file in state.json request.json manifest.json control.json; do
        if test -f "$directory/$file"; then b64 < "$directory/$file"; else printf -; fi
        test "$file" = control.json || printf '\t'
      done
      printf '\n'
    fi
  done
}
serve() {
  local directory generation desired state_generation state pid path
  exec 9> "$ROOT/shell-manager.lock" || return 1
  flock -n 9 || return 0
  declare -A jobs=()
  while :; do
    for directory in "${!jobs[@]}"; do
      pid="${jobs[$directory]}"
      if ! kill -0 "$pid" 2>/dev/null; then wait "$pid" 2>/dev/null; unset 'jobs[$directory]'; fi
    done
    for directory in "$ROOT"/task-*; do
      test -f "$directory/shell-spec" || continue
      read -r generation desired 2>/dev/null < "$directory/shell-control" || continue
      test "$desired" = running || continue
      test -z "${jobs[$directory]}" || continue
      IFS=$'\t' read -r state_generation state _ 2>/dev/null < "$directory/shell-state" || state=
      if test "$state_generation" = "$generation"; then case "$state" in done|error|paused|canceled) continue;; esac; fi
      test "${#jobs[@]}" -lt 8 || break
      read -r path < "$ROOT/current-shell-worker"; test -f "$path" || path="$SELF"
      bash "$path" run "$directory" "$generation" & jobs[$directory]=$!
    done
    sleep .5
  done
}
case "$1" in
  file) download_one "$2" "$3" "$4";;
  run) run_task "$2" "$3";;
  serve) serve;;
  list) snapshot;;
  *) echo '未知远端 worker 命令' >&2; exit 1;;
esac
