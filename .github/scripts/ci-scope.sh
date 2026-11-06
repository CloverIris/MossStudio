#!/usr/bin/env bash
# Decides how much of build.yml runs, and writes `install` and `matrix` to $GITHUB_OUTPUT.
#
#   EVENT  github.event_name
#   BASE   base commit of a pull request (github.event.pull_request.base.sha)
#   HEAD   head commit of a pull request (github.event.pull_request.head.sha)
#
# Pull requests run the package + install/update/rollback matrix only when they touch what it
# tests (INSTALL_PATHS below), and then without macOS Intel. Pushes to main and manual runs
# (workflow_dispatch, e.g. `gh workflow run build.yml --ref <branch>`) always run all four.
set -euo pipefail

INSTALL_PATHS='^(apps/launcher/|apps/desktop/src/main/install/|apps/desktop/src/main/update/|apps/desktop/src/shared/(install|update|updateKeys|setup)\.ts$|apps/desktop/src/renderer/src/pages/(install|uninstall)/|apps/desktop/electron\.vite\.config\.|apps/desktop/package\.json$|package\.json$|pnpm-lock\.yaml$|tools/release/|\.github/workflows/build\.yml$|\.github/scripts/)'

ALL='[{"runner":"windows-latest","platform":"win32-x64"},{"runner":"ubuntu-latest","platform":"linux-x64"},{"runner":"macos-latest","platform":"darwin-arm64"},{"runner":"macos-15-intel","platform":"darwin-x64"}]'
PR='[{"runner":"windows-latest","platform":"win32-x64"},{"runner":"ubuntu-latest","platform":"linux-x64"},{"runner":"macos-latest","platform":"darwin-arm64"}]'

out="${GITHUB_OUTPUT:-/dev/stdout}"
if [[ "${EVENT:-}" != "pull_request" ]]; then
  echo "${EVENT:-unknown} run: full matrix"
  { echo "install=true"; echo "matrix=$ALL"; } >> "$out"
  exit 0
fi

changed="$(git diff --name-only "$BASE...$HEAD")"
hits="$(grep -E "$INSTALL_PATHS" <<< "$changed" || true)"
if [[ -n "$hits" ]]; then
  echo "install/update paths changed; running the matrix without macOS Intel:"
  sed 's/^/  /' <<< "$hits"
  { echo "install=true"; echo "matrix=$PR"; } >> "$out"
else
  echo "no install/update paths changed; skipping the package matrix"
  { echo "install=false"; echo "matrix=[]"; } >> "$out"
fi
