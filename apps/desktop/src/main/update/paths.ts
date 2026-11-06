import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
// original-fs: in the packaged main process node:fs treats every *.asar as a folder; app folders are plain files here.
import { promises as fsp } from 'original-fs'

const { lstat, readlink, realpath } = fsp

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

/**
 * Validate a package-relative path ("resources/app.asar"): forward slashes only, no empty, "." or
 * ".." parts, not absolute, no drive letter, no NUL. Returns the path split into parts.
 */
export function safeParts(path: string, platform: NodeJS.Platform = process.platform): string[] {
  if (!path || path.includes('\0') || path.includes('\\')) throw new Error(`不安全的路径：${path}`)
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new Error(`不安全的路径：${path}`)
  const parts = path.replace(/\/+$/, '').split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw new Error(`不安全的路径：${path}`)
    if (platform === 'win32' && (part.includes(':') || WINDOWS_RESERVED.test(part) || /[. ]$/.test(part))) {
      throw new Error(`不安全的路径：${path}`)
    }
  }
  return parts
}

/** `root` joined with a validated relative path; throws if the result would leave `root`. */
export function safeJoin(root: string, path: string, platform: NodeJS.Platform = process.platform): string {
  const full = join(root, ...safeParts(path, platform))
  if (!isInside(root, full)) throw new Error(`不安全的路径：${path}`)
  return full
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

/**
 * A symlink's target must be relative and, resolved from the link's folder, stay inside `root`.
 * Absolute targets and escapes ("../../etc") are refused.
 */
export function assertSafeLinkTarget(root: string, linkPath: string, target: string): void {
  if (!target || target.includes('\0') || isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.startsWith('\\')) {
    throw new Error(`不安全的符号链接：${target}`)
  }
  const resolved = resolve(join(linkPath, '..'), target)
  if (!isInside(root, resolved)) throw new Error(`符号链接指向安装目录之外：${target}`)
}

/** Refuse to write through a symlinked parent folder (a link created earlier pointing elsewhere). */
export async function assertNoSymlinkParents(root: string, full: string): Promise<void> {
  const rel = relative(root, full)
  const parts = rel.split(sep)
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`路径经过符号链接：${rel}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

/**
 * After links are created: every link must resolve (realpath) to something inside `root`. Catches
 * a link that leads outside through other links. A dangling link (its target is not part of this
 * tree, e.g. in a delta's work folder) is checked from the real path of its folder instead.
 */
export async function assertLinksResolveInside(root: string, links: readonly string[]): Promise<void> {
  if (!links.length) return
  const realRoot = await realpath(root)
  for (const link of links) {
    let resolved: string
    try {
      resolved = await realpath(link)
    } catch {
      resolved = resolve(await realpath(dirname(link)), await readlink(link))
    }
    if (!isInside(realRoot, resolved)) throw new Error(`符号链接指向安装目录之外：${relative(root, link)}`)
  }
}
