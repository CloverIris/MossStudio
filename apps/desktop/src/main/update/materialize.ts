// original-fs: in the packaged main process node:fs treats every *.asar as a folder; app folders are plain files here.
import { promises as fsp } from 'original-fs'
import { dirname, join, relative, sep } from 'node:path'
import { DELTA_FILES_PREFIX, DELTA_MANIFEST_NAME, deltaManifestSchema, type DeltaManifest, type FileList } from '@shared/install'
import { sha256File } from './download'
import { assertLinksResolveInside, assertNoSymlinkParents, assertSafeLinkTarget, safeJoin } from './paths'
import { extractZip } from './zip'

const { copyFile, chmod, link, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink } = fsp

type Entry = FileList['entries'][number]

/** Permission bits only: the FileList may carry a full st_mode or just 0o755-style bits. */
const perm = (mode: number): number => mode & 0o777

export interface VerifyOptions {
  platform?: NodeJS.Platform
  signal?: AbortSignal
}

/**
 * Check that `dir` holds exactly what the FileList says: every file (size, sha256, mode bits
 * except on Windows) and symlink (target), nothing missing, no extra files or links. Folders are
 * implied by the entries and not listed.
 */
export async function verifyTree(dir: string, list: FileList, options: VerifyOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform
  const expected = new Map<string, Entry>()
  for (const entry of list.entries) {
    safeJoin(dir, entry.path, platform)
    if (expected.has(entry.path)) throw new Error(`文件清单重复：${entry.path}`)
    expected.set(entry.path, entry)
  }
  const seen = new Set<string>()
  const walk = async (folder: string): Promise<void> => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (options.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
      const full = join(folder, item.name)
      const rel = relative(dir, full).split(sep).join('/')
      const info = await lstat(full)
      if (info.isDirectory()) {
        await walk(full)
        continue
      }
      const entry = expected.get(rel)
      if (!entry) throw new Error(`更新包中有清单之外的文件：${rel}`)
      seen.add(rel)
      if (entry.type === 'symlink') {
        if (!info.isSymbolicLink()) throw new Error(`应为符号链接：${rel}`)
        if ((await readlink(full)) !== entry.target) throw new Error(`符号链接目标不符：${rel}`)
        continue
      }
      if (!info.isFile()) throw new Error(`应为普通文件：${rel}`)
      if (info.size !== entry.size) throw new Error(`文件大小不符：${rel}`)
      if (platform !== 'win32' && perm(info.mode) !== perm(entry.mode)) throw new Error(`文件权限不符：${rel}`)
      if ((await sha256File(full)) !== entry.sha256) throw new Error(`文件校验失败：${rel}`)
    }
  }
  await walk(dir)
  const missing = [...expected.keys()].filter((path) => !seen.has(path))
  if (missing.length) throw new Error(`更新包缺少文件：${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` 等 ${missing.length} 个` : ''}`)
}

export interface MaterializeOptions {
  kind: 'full' | 'delta'
  /** The downloaded full package or delta zip. */
  zipPath: string
  /** The verified FileList of the new version. */
  fileList: FileList
  /** `app-<v>.partial` (macOS: `.MossStudio-<v>.app.partial`); recreated empty. */
  partialDir: string
  /** `app-<v>` (macOS: `.MossStudio-<v>.app`); the partial is renamed to it when verified. */
  finalDir: string
  /** Delta only: the running version's folder (app-<current> / the bundle) to take unchanged files from. */
  baseDir?: string
  /** Delta only: the version of `baseDir`; delta.json's `from` must match it. */
  baseVersion?: string
  /** Delta only: sha256 of the files-<v>.json bytes; delta.json must have been built against them. */
  filesSha256?: string
  platform?: NodeJS.Platform
  signal?: AbortSignal
}

/**
 * Build the new version's folder next to the running one and verify every entry before renaming
 * it into place. A failure removes the partial folder and leaves nothing behind.
 */
export async function materialize(options: MaterializeOptions): Promise<string> {
  const platform = options.platform ?? process.platform
  const { partialDir, finalDir, fileList } = options
  await rm(partialDir, { recursive: true, force: true })
  await mkdir(partialDir, { recursive: true })
  try {
    const expectedBytes = fileList.entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0)
    const maxBytes = expectedBytes + 1024 * 1024
    if (options.kind === 'delta') {
      if (!options.baseDir) throw new Error('增量更新缺少当前版本目录')
      const work = `${partialDir}.delta`
      await rm(work, { recursive: true, force: true })
      await mkdir(work, { recursive: true })
      try {
        const entries = await extractZip(options.zipPath, work, { platform, signal: options.signal, maxBytes })
        const manifest = await readDeltaManifest(work, options, fileList)
        const changed = new Set(manifest.changed)
        for (const entry of entries) {
          if (entry.path === DELTA_MANIFEST_NAME) continue
          const path = entry.path.startsWith(DELTA_FILES_PREFIX) ? entry.path.slice(DELTA_FILES_PREFIX.length) : null
          if (!path || !changed.has(path)) throw new Error(`增量包中有清单之外的文件：${entry.path}`)
        }
        await assembleDelta({ base: options.baseDir, work, dest: partialDir, list: fileList, changed, platform })
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined)
      }
    } else {
      await extractZip(options.zipPath, partialDir, { platform, signal: options.signal, maxBytes })
    }
    await verifyTree(partialDir, fileList, { platform, signal: options.signal })
    await rm(finalDir, { recursive: true, force: true })
    await rename(partialDir, finalDir)
    return finalDir
  } catch (error) {
    await rm(partialDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function readDeltaManifest(work: string, options: MaterializeOptions, list: FileList): Promise<DeltaManifest> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(work, DELTA_MANIFEST_NAME), 'utf8'))
  } catch {
    throw new Error('增量包缺少 delta.json')
  }
  const parsed = deltaManifestSchema.safeParse(raw)
  if (!parsed.success) throw new Error('增量包的 delta.json 无效')
  const manifest = parsed.data
  if (manifest.platform !== list.platform || manifest.to !== list.version) throw new Error('增量包与目标版本不符')
  if (options.baseVersion && manifest.from !== options.baseVersion) throw new Error(`增量包基于 ${manifest.from}，当前版本不符`)
  if (options.filesSha256 && manifest.files.sha256 !== options.filesSha256) throw new Error('增量包与文件清单不符')
  const listed = new Set(list.entries.map((entry) => entry.path))
  for (const path of manifest.changed) if (!listed.has(path)) throw new Error(`增量包改动了清单之外的文件：${path}`)
  return manifest
}

/**
 * Delta: every FileList entry comes either from the delta (`files/<path>`, when listed in
 * `changed`) or from the running version. Base files are hardlinked when their mode already
 * matches (copied otherwise or when linking fails); symlinks are recreated from the FileList.
 * Anything in the base that is not listed is simply not carried over: that is how deletions
 * apply. A mismatching base file fails verification afterwards.
 */
async function assembleDelta(input: {
  base: string
  work: string
  dest: string
  list: FileList
  changed: Set<string>
  platform: NodeJS.Platform
}): Promise<void> {
  const { base, work, dest, list, changed, platform } = input
  // Files first, links last, so nothing is ever written through a link created here.
  const ordered = [...list.entries.filter((entry) => entry.type === 'file'), ...list.entries.filter((entry) => entry.type === 'symlink')]
  const links: string[] = []
  for (const entry of ordered) {
    const target = safeJoin(dest, entry.path, platform)
    await assertNoSymlinkParents(dest, target)
    await mkdir(dirname(target), { recursive: true })
    if (entry.type === 'symlink') {
      assertSafeLinkTarget(dest, target, entry.target)
      await symlink(entry.target, target)
      links.push(target)
      continue
    }
    if (changed.has(entry.path)) {
      const source = safeJoin(work, `${DELTA_FILES_PREFIX}${entry.path}`, platform)
      const info = await lstat(source).catch(() => null)
      if (!info?.isFile()) throw new Error(`增量包缺少文件：${entry.path}`)
      await rename(source, target)
      continue
    }
    const source = safeJoin(base, entry.path, platform)
    const info = await lstat(source).catch(() => null)
    if (!info) throw new Error(`增量更新缺少基础文件：${entry.path}`)
    if (!info.isFile()) throw new Error(`增量更新的基础文件无效：${entry.path}`)
    const sameMode = platform === 'win32' || perm(info.mode) === perm(entry.mode)
    let linked = false
    if (sameMode) {
      try {
        await link(source, target)
        linked = true
      } catch {
        linked = false
      }
    }
    if (!linked) {
      await copyFile(source, target)
      if (platform !== 'win32') await chmod(target, perm(entry.mode))
    }
  }
  await assertLinksResolveInside(dest, links)
}
