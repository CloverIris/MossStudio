/**
 * Copy a folder tree with byte progress. Regular files keep their mode, symlinks are
 * recreated as symlinks (never followed), directories are created as needed.
 */
import { promises as fsp } from 'original-fs'

// original-fs: Electron's own fs reads app.asar as a folder; app folders must be copied as files.
const { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink } = fsp
import { join, relative } from 'node:path'

export interface TreeEntry {
  /** Relative to the tree root. */
  path: string
  type: 'file' | 'dir' | 'symlink'
  size: number
  mode: number
}

/** Every entry under `root`, parents before children. */
export async function listTree(root: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = []
  const walk = async (dir: string): Promise<void> => {
    const names = (await readdir(dir)).sort()
    for (const name of names) {
      const path = join(dir, name)
      const stats = await lstat(path)
      const rel = relative(root, path)
      if (stats.isSymbolicLink()) out.push({ path: rel, type: 'symlink', size: 0, mode: stats.mode })
      else if (stats.isDirectory()) {
        out.push({ path: rel, type: 'dir', size: 0, mode: stats.mode })
        await walk(path)
      } else if (stats.isFile()) out.push({ path: rel, type: 'file', size: stats.size, mode: stats.mode })
    }
  }
  await walk(root)
  return out
}

export function treeBytes(entries: TreeEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.size, 0)
}

export interface CopyProgress {
  copiedBytes: number
  totalBytes: number
  file: string
}

/** Copy `source` into `target` (created). Progress is reported after every file. */
export async function copyTree(
  source: string,
  target: string,
  onProgress: (progress: CopyProgress) => void = () => undefined,
  entries?: TreeEntry[],
): Promise<number> {
  const list = entries ?? (await listTree(source))
  const totalBytes = treeBytes(list)
  let copiedBytes = 0
  await mkdir(target, { recursive: true })
  for (const entry of list) {
    const from = join(source, entry.path)
    const to = join(target, entry.path)
    if (entry.type === 'dir') {
      await mkdir(to, { recursive: true })
    } else if (entry.type === 'symlink') {
      const link = await readlink(from)
      let type: 'file' | 'dir' | undefined
      if (process.platform === 'win32') {
        try {
          type = (await lstat(join(from, '..', link))).isDirectory() ? 'dir' : 'file'
        } catch {
          type = 'file'
        }
      }
      await symlink(link, to, type)
    } else {
      await copyFile(from, to)
      if (process.platform !== 'win32') await chmod(to, entry.mode & 0o7777)
      copiedBytes += entry.size
    }
    onProgress({ copiedBytes, totalBytes, file: entry.path })
  }
  return copiedBytes
}
