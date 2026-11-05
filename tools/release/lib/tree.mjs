// Directory walking, FileList generation and tree → zip, shared by the release scripts.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, posix } from 'node:path'
import { ZipWriter } from './zip.mjs'

/**
 * The mode recorded in a FileList and a zip. Windows has no Unix modes (and cross-packaging
 * from Linux would leak the host's), so win32 packages record 0o644 for every file and the
 * updater checks modes only on POSIX platforms.
 */
export function normalizeMode(platform, statMode) {
  if (platform.startsWith('win32')) return 0o644
  return statMode & 0o777
}

/**
 * Every directory, regular file and symlink under `dir`, sorted by path. Paths are relative,
 * '/' separated and prefixed with `prefix` (e.g. 'MossStudio.app/'). Symlinks are not followed.
 * Anything else (sockets, devices) is an error: it cannot be packaged.
 */
export function walkTree(dir, prefix = '') {
  const out = []
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const childAbs = join(abs, name)
      const childRel = rel ? `${rel}/${name}` : name
      const st = lstatSync(childAbs)
      if (st.isSymbolicLink()) {
        out.push({ path: prefix + childRel, abs: childAbs, type: 'symlink', target: readlinkSync(childAbs), mode: st.mode })
      } else if (st.isDirectory()) {
        out.push({ path: prefix + childRel, abs: childAbs, type: 'dir', mode: st.mode })
        visit(childAbs, childRel)
      } else if (st.isFile()) {
        out.push({ path: prefix + childRel, abs: childAbs, type: 'file', size: st.size, mode: st.mode })
      } else {
        throw new Error(`cannot package special file: ${childAbs}`)
      }
    }
  }
  visit(dir, '')
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path))
}

/**
 * A symlink target is safe when it is relative and, resolved from the link's directory,
 * stays inside the package root. The updater refuses anything else, so the pipeline does too.
 */
export function symlinkTargetIsSafe(linkPath, target) {
  if (!target || target.startsWith('/') || target.includes('\\') || /^[A-Za-z]:/.test(target)) return false
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target))
  return resolved !== '..' && !resolved.startsWith('../') && !posix.isAbsolute(resolved)
}

/** Build the FileList (shared/install.ts fileListSchema) for a walked tree. */
export function fileListFromTree(tree, { version, platform }) {
  const entries = []
  for (const item of tree) {
    if (item.type === 'dir') continue
    if (item.type === 'symlink') {
      if (!symlinkTargetIsSafe(item.path, item.target)) {
        throw new Error(`symlink escapes the package: ${item.path} -> ${item.target}`)
      }
      entries.push({ path: item.path, type: 'symlink', target: item.target })
    } else {
      const data = readFileSync(item.abs)
      entries.push({ path: item.path, type: 'file', sha256: sha256Buffer(data), size: data.length, mode: normalizeMode(platform, item.mode) })
    }
  }
  return { schema: 1, version, platform, entries }
}

/** Write a walked tree (or the subset `include` keeps) into a zip at `zipPath`. */
export function zipTree(tree, zipPath, { platform, mtime, include = () => true }) {
  const zip = new ZipWriter(zipPath, { mtime })
  try {
    for (const item of tree) {
      if (!include(item)) continue
      if (item.type === 'dir') zip.addDirectory(item.path, normalizeMode(platform, item.mode) | 0o755)
      else if (item.type === 'symlink') zip.addSymlink(item.path, item.target)
      else zip.addFileFromDisk(item.path, item.abs, normalizeMode(platform, item.mode))
    }
    zip.close()
  } catch (error) {
    zip.abort()
    throw error
  }
}
