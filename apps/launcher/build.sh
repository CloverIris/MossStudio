#!/usr/bin/env bash
# Builds the MossStudio launcher / setup stub for Windows x64 and Linux x64 from any host
# (pure Go, CGO_ENABLED=0), reproducibly (-trimpath, -buildvcs=false, empty build id).
#
#   apps/launcher/build.sh                 version from apps/desktop/package.json
#   VERSION=1.2.3 apps/launcher/build.sh   explicit version
#
# Needs only bash, sed and go on PATH (Linux, macOS, Git Bash on Windows); always builds both.
# Output: apps/launcher/dist/moss-launcher-win-x64.exe (GUI subsystem, icon + version + manifest)
#         apps/launcher/dist/moss-launcher-linux-x64
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$here"

if [[ -z "${VERSION:-}" ]]; then
  VERSION="$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$repo/apps/desktop/package.json" | head -n1)"
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "build.sh: VERSION '$VERSION' is not semver" >&2
  exit 1
fi

export CGO_ENABLED=0 GOFLAGS=-buildvcs=false
mkdir -p dist

# Windows resources (icon, version info, asInvoker/DPI manifest), linked only into windows/amd64.
go run ./cmd/winres -ico "$repo/apps/desktop/src/renderer/public/mossstudio-icon.ico" \
  -version "$VERSION" -out rsrc_windows_amd64.syso

ldflags="-s -w -buildid= -X main.version=$VERSION"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$ldflags -H=windowsgui" -o dist/moss-launcher-win-x64.exe .
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$ldflags" -o dist/moss-launcher-linux-x64 .

echo "launcher $VERSION ($(go env GOVERSION)):"
if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
(cd dist && "${sum[@]}" moss-launcher-win-x64.exe moss-launcher-linux-x64)
