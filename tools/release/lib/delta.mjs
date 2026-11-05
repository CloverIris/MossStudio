// Delta packages: the files that changed between two FileLists, read from the new full zip.
//
// MossStudio-<from>-to-<to>-<platform>.delta.zip
//   delta.json          DeltaManifest (shared/install.ts deltaManifestSchema)
//   files/<path>        every new or changed entry of the target FileList (symlinks as symlinks)
// The client builds app-<to> from the target FileList: entries in `changed` come from the
// delta, every other entry is copied from app-<from>; then every file is verified.
import { ZipWriter } from './zip.mjs'
import { forEachZipEntry } from './unzip.mjs'
import { sha256Buffer } from './tree.mjs'

export const DELTA_MANIFEST = 'delta.json'
export const DELTA_FILES_PREFIX = 'files/'

function sameEntry(a, b) {
  if (a.type !== b.type) return false
  if (a.type === 'symlink') return a.target === b.target
  return a.sha256 === b.sha256 && a.size === b.size && a.mode === b.mode
}

/** Which paths of `to` must ship in the delta and which paths of `from` disappear. */
export function planDelta(from, to) {
  if (from.platform !== to.platform) throw new Error(`delta across platforms: ${from.platform} → ${to.platform}`)
  const before = new Map(from.entries.map((entry) => [entry.path, entry]))
  const after = new Set(to.entries.map((entry) => entry.path))
  const changed = []
  let unchangedBytes = 0
  for (const entry of to.entries) {
    const old = before.get(entry.path)
    if (old && sameEntry(old, entry)) {
      if (entry.type === 'file') unchangedBytes += entry.size
    } else {
      changed.push(entry.path)
    }
  }
  const removed = from.entries.filter((entry) => !after.has(entry.path)).map((entry) => entry.path)
  return { changed, removed, unchangedBytes }
}

export function deltaManifest({ from, to, filesJson }) {
  const plan = planDelta(from, to)
  return {
    schema: 1,
    platform: to.platform,
    from: from.version,
    to: to.version,
    files: { sha256: sha256Buffer(filesJson), size: filesJson.length },
    changed: plan.changed,
    removed: plan.removed,
  }
}

/**
 * Write the delta zip. `fullZip` is the target version's full package; `filesJson` the exact
 * bytes of its files-<to>-<platform>.json (hashed into the manifest so a client can check it
 * holds the matching FileList).
 */
export async function writeDelta({ from, to, filesJson, fullZip, outPath, mtime }) {
  const manifest = deltaManifest({ from, to, filesJson })
  const wanted = new Map(to.entries.filter((entry) => manifest.changed.includes(entry.path)).map((entry) => [entry.path, entry]))
  const zip = new ZipWriter(outPath, { mtime })
  const written = new Set()
  try {
    zip.addFile(DELTA_MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o644)
    await forEachZipEntry(fullZip, async (entry) => {
      const expected = wanted.get(entry.name)
      if (!expected) return
      const data = await entry.read()
      if (expected.type === 'symlink') {
        if (entry.kind !== 'symlink' || data.toString('utf8') !== expected.target) throw new Error(`full zip disagrees with the file list at ${entry.name}`)
        zip.addSymlink(DELTA_FILES_PREFIX + entry.name, expected.target)
      } else {
        if (entry.kind !== 'file' || sha256Buffer(data) !== expected.sha256) throw new Error(`full zip disagrees with the file list at ${entry.name}`)
        zip.addFile(DELTA_FILES_PREFIX + entry.name, data, expected.mode)
      }
      written.add(entry.name)
    })
    const missing = [...wanted.keys()].filter((path) => !written.has(path))
    if (missing.length > 0) throw new Error(`full zip lacks ${missing.length} listed entries, e.g. ${missing[0]}`)
    zip.close()
  } catch (error) {
    zip.abort()
    throw error
  }
  return manifest
}

/**
 * The versions to build deltas from: the `count` newest stable releases below `version`; for
 * a prerelease also the newest prerelease below it that is newer than those (so beta users
 * moving between betas get a delta too).
 */
export function deltaBases(version, available, { count = 2, compare, isPrerelease }) {
  const older = available.filter((v) => compare(v, version) < 0).sort((a, b) => compare(b, a))
  const stable = older.filter((v) => !isPrerelease(v)).slice(0, count)
  const bases = [...stable]
  if (isPrerelease(version)) {
    const beta = older.find((v) => isPrerelease(v))
    if (beta && (stable.length === 0 || compare(beta, stable[0]) > 0)) bases.unshift(beta)
  }
  return bases
}
