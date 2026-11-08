// Semver parsing/ordering (the subset shared/install.ts accepts: x.y.z[-prerelease]) and the
// artifact names every release script agrees on.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parseVersion(value) {
  const match = SEMVER.exec(String(value))
  if (!match) throw new Error(`not a semver version: ${value}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split('.') : [] }
}

export function isVersion(value) {
  return SEMVER.test(String(value))
}

export function isPrerelease(value) {
  return parseVersion(value).pre.length > 0
}

/** Semver 2.0 precedence: <0, 0, >0. */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0
  if (x.pre.length === 0) return 1 // a release ranks above its prereleases
  if (y.pre.length === 0) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1
    if (i >= y.pre.length) return 1
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn) return -1
    if (qn) return 1
    return p < q ? -1 : 1
  }
  return 0
}

/** `x.y.(z+n)`: used by the integration test to stamp later versions from one build. */
export function bumpPatch(value, n = 1) {
  const v = parseVersion(value)
  return `${v.major}.${v.minor}.${v.patch + n}`
}

export const PLATFORMS = ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64']

export function splitPlatform(platform) {
  if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform: ${platform} (expected one of ${PLATFORMS.join(', ')})`)
  const [os, arch] = platform.split('-')
  return { os, arch }
}

/** Every file name the pipeline produces for one version and platform. */
export function artifactNames(version, platform) {
  const { os, arch } = splitPlatform(platform)
  const names = {
    full: `MossStudio-${version}-${platform}-full.zip`,
    files: `files-${version}-${platform}.json`,
  }
  if (os === 'win32') {
    names.setup = `MossStudio-Setup-${version}-x64.exe`
    names.portable = `MossStudio-${version}-win-x64-portable.zip`
  } else if (os === 'linux') {
    names.setup = `MossStudio-Setup-${version}-linux-x64.run`
    names.portable = `MossStudio-${version}-linux-x64-portable.tar.gz`
  } else {
    names.setup = `MossStudio-${version}-mac-${arch}.dmg`
    names.portable = `MossStudio-${version}-mac-${arch}-portable.zip`
  }
  return names
}

export function deltaName(from, to, platform) {
  splitPlatform(platform)
  return `MossStudio-${from}-to-${to}-${platform}.delta.zip`
}

export function feedName(channel) {
  return `update-${channel}.json`
}

export const RELEASE_REPO = 'ShallowElec/MossStudio'

export function releaseAssetUrl(version, file, repo = RELEASE_REPO) {
  return `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(file)}`
}

/** Parse a delta file name back into its parts (null when it is not one). */
export function parseDeltaName(file) {
  const match = /^MossStudio-(.+)-to-(.+)-(win32-x64|linux-x64|darwin-arm64|darwin-x64)\.delta\.zip$/.exec(file)
  if (!match || !isVersion(match[1]) || !isVersion(match[2])) return null
  return { from: match[1], to: match[2], platform: match[3] }
}

/** portable.json: marks a portable root (next to the launcher). The app writes install.json on its first start. */
export function portableMarker(version) {
  return `${JSON.stringify({ schema: 1, version }, null, 2)}\n`
}
