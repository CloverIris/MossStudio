// original-fs: in the packaged main process node:fs treats every *.asar as a folder; app folders are plain files here.
import { createWriteStream, promises as fsp } from 'original-fs'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'
import { assertLinksResolveInside, assertNoSymlinkParents, assertSafeLinkTarget, safeJoin, safeParts } from './paths'

const { chmod, mkdir, symlink } = fsp

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFDIR = 0o040000

export interface ExtractOptions {
  /** Refuse archives whose entries add up to more than this many bytes (zip bombs). */
  maxBytes?: number
  signal?: AbortSignal
  platform?: NodeJS.Platform
}

export interface ExtractedEntry {
  path: string
  type: 'file' | 'symlink'
}

/**
 * Unpack a zip into `dest` (which must exist and be empty):
 *  - every name is checked (no absolute paths, "..", backslashes or drive letters),
 *  - regular files keep their unix mode bits, are created exclusively (duplicates fail) and are
 *    never written through a symlink,
 *  - symlinks are created last, and only when their target stays inside `dest`.
 */
export async function extractZip(zipPath: string, dest: string, options: ExtractOptions = {}): Promise<ExtractedEntry[]> {
  const platform = options.platform ?? process.platform
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true })
  const extracted: ExtractedEntry[] = []
  const links: Array<{ path: string; full: string; target: string }> = []
  let total = 0
  try {
    for await (const entry of zip.eachEntry()) {
      if (options.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
      const attrs = (entry.externalFileAttributes >>> 16) & 0xffff
      const kind = attrs & S_IFMT
      const isDir = entry.fileName.endsWith('/') || kind === S_IFDIR
      const name = entry.fileName.replace(/\/+$/, '')
      safeParts(name, platform)
      const full = safeJoin(dest, name, platform)
      if (isDir) {
        await assertNoSymlinkParents(dest, full)
        await mkdir(full, { recursive: true })
        continue
      }
      if (entry.isEncrypted()) throw new Error(`不支持加密的压缩条目：${name}`)
      total += entry.uncompressedSize
      if (options.maxBytes !== undefined && total > options.maxBytes) throw new Error('更新包解压后超过预期大小')
      const stream = await zip.openReadStreamPromise(entry)
      if (kind === S_IFLNK) {
        if (entry.uncompressedSize > 4096) throw new Error(`符号链接无效：${name}`)
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(chunk as Buffer)
        const target = Buffer.concat(chunks).toString('utf8')
        links.push({ path: name, full, target })
        continue
      }
      await assertNoSymlinkParents(dest, full)
      await mkdir(dirname(full), { recursive: true })
      const mode = attrs & 0o777 || 0o644
      await pipeline(stream, createWriteStream(full, { flags: 'wx', mode }))
      if (platform !== 'win32') await chmod(full, mode)
      extracted.push({ path: name, type: 'file' })
    }
  } finally {
    zip.close()
  }
  for (const link of links) {
    assertSafeLinkTarget(dest, link.full, link.target)
    await assertNoSymlinkParents(dest, link.full)
    await mkdir(dirname(link.full), { recursive: true })
    await symlink(link.target, link.full)
    extracted.push({ path: link.path, type: 'symlink' })
  }
  await assertLinksResolveInside(dest, links.map((link) => link.full))
  return extracted
}
