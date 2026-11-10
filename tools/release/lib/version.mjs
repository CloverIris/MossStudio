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

/** The rolling prerelease people download the latest nightly from (setups and portable packages). */
export const NIGHTLY_TAG = 'nightly'

/** The rolling release that holds the feeds, and the latest nightly's update packages next to them. */
export const UPDATES_TAG = 'updates'

/**
 * Where update-nightly.json points: the `updates` release, which is never deleted, so the feed never
 * names a file that is gone while `nightly` is replaced. File names carry their version.
 */
export function nightlyAssetUrl(file, repo = RELEASE_REPO) {
  return `https://github.com/${repo}/releases/download/${UPDATES_TAG}/${encodeURIComponent(file)}`
}

/**
 * A nightly's version: `<next release>-nightly.<UTC date>.<run>`, e.g. 1.0.3-nightly.20261108.42.
 * The next release is `packageVersion`'s x.y.z, or one patch later when that is already tagged, so
 * the release that follows ranks above every nightly before it. The workflow run number orders two
 * builds of one day (a manual run after the scheduled one).
 */
export function nightlyVersion(packageVersion, tags, date, run) {
  const v = parseVersion(packageVersion)
  let core = `${v.major}.${v.minor}.${v.patch}`
  if (tags.includes(core) || tags.includes(`v${core}`)) core = `${v.major}.${v.minor}.${v.patch + 1}`
  const day = date.toISOString().slice(0, 10).replaceAll('-', '')
  if (!Number.isInteger(run) || run < 1) throw new Error(`not a workflow run number: ${run}`)
  return `${core}-nightly.${day}.${run}`
}

export function isNightly(version) {
  return parseVersion(version).pre[0] === 'nightly'
}

/** The nightly a file on the `updates` release is an update package of (full, file list, delta to it), or null. */
function nightlyPackageVersion(name) {
  const version =
    parseDeltaName(name)?.to ??
    /^MossStudio-(.+)-(?:win32-x64|linux-x64|darwin-arm64|darwin-x64)-full\.zip$/.exec(name)?.[1] ??
    /^files-(.+)-(?:win32-x64|linux-x64|darwin-arm64|darwin-x64)\.json$/.exec(name)?.[1]
  return version && isVersion(version) && isNightly(version) ? version : null
}

/**
 * The nightly update packages on the `updates` release to delete: those of every nightly but `keep`
 * (the new one, and the one before it so a download already under way can finish). Feeds, their
 * signatures and release packages are never among them.
 */
export function staleNightlyPackages(names, keep) {
  const kept = new Set(keep.filter(Boolean))
  return names.filter((name) => {
    const version = nightlyPackageVersion(name)
    return version !== null && !kept.has(version)
  })
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
