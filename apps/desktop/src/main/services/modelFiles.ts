import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, open, readFile, rename, rm, stat, statfs, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export interface ModelFile {
  path: string
  size: number
  oid: string | null
}
export interface Snapshot {
  sha: string
  files: ModelFile[]
}

export function safePath(root: string, file: string): string {
  const target = resolve(root, file)
  const rel = relative(resolve(root), target)
  if (
    isAbsolute(file) ||
    !rel ||
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    file.includes('\\') ||
    file.includes(':')
  ) {
    throw new Error(`不合法的模型文件路径：${file}`)
  }
  return target
}

export function matchesFile(pattern: string, file: string): boolean {
  return new RegExp(
    `^${pattern
      .replace(/\\/g, '/')
      .split('*')
      .map((v) => v.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  ).test(file)
}

export function selectFiles(files: ModelFile[], patterns?: string[]): ModelFile[] {
  if (!patterns?.length) return files
  for (const pattern of patterns) {
    if (!files.some((file) => matchesFile(pattern, file.path)))
      throw new Error(`仓库缺少文件：${pattern}`)
  }
  return files.filter((file) => patterns.some((pattern) => matchesFile(pattern, file.path)))
}

export async function resolveFiles(
  base: string,
  repo: string,
  revision: string,
  signal?: AbortSignal,
  transport?: (url: string) => Promise<Response>,
): Promise<Snapshot> {
  const request = async (url: string): Promise<Response> => {
    const response = transport ? await transport(url) : await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`模型清单 HTTP ${response.status}`)
    return response
  }
  const meta = (await (
    await request(`${base}/api/models/${repo}/revision/${encodeURIComponent(revision)}`)
  ).json()) as { sha: string }
  if (!/^[a-f0-9]{40,64}$/.test(meta.sha)) throw new Error('模型 revision 未解析到有效提交')
  let url: string | null = `${base}/api/models/${repo}/tree/${meta.sha}?recursive=true&limit=1000`
  const files: ModelFile[] = []
  const visited = new Set<string>()
  while (url) {
    if (visited.has(url) || new URL(url).origin !== new URL(base).origin)
      throw new Error('模型清单分页无效')
    visited.add(url)
    const response = await request(url)
    const tree = (await response.json()) as Array<{
      type: string
      path: string
      size: number
      oid?: string
      lfs?: { oid?: string }
    }>
    for (const item of tree) {
      if (item.type !== 'file') continue
      safePath('/model-cache', item.path)
      if (!Number.isSafeInteger(item.size) || item.size < 0)
        throw new Error(`文件大小无效：${item.path}`)
      const oid = item.lfs?.oid ?? item.oid ?? null
      if (oid && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
        throw new Error(`文件 hash 无效：${item.path}`)
      files.push({ path: item.path, size: item.size, oid })
    }
    const next =
      response.headers
        .get('link')
        ?.split(',')
        .find((part) => /rel="next"/.test(part))
        ?.match(/<([^>]+)>/)?.[1] ?? null
    url = next ? new URL(next, url).href : null
  }
  return { sha: meta.sha, files }
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return -1
  }
}

export async function materialize(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  try {
    await link(source, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    const space = await statfs(dirname(target))
    if (Number(space.bavail) * Number(space.bsize) < (await stat(source)).size + 64 * 1024 ** 2)
      throw new Error('创建本地组合时磁盘空间不足')
    await copyFile(source, target)
  }
}

/**
 * Like materialize, for a file in the user's own model folder: a hard link,
 * else a symbolic link. Never a copy (that folder can be 27 GB on another disk).
 */
export async function linkInPlace(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  try {
    await link(source, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    try {
      await symlink(source, target)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return
      throw cause
    }
  }
}

// A shared blob can be requested by several components or bundles at once.
const locks = new Map<string, Promise<void>>()
let active = 0
const waiters: Array<() => void> = []
async function slot(concurrency = 4): Promise<() => void> {
  if (active >= concurrency) await new Promise<void>((done) => waiters.push(done))
  else active += 1
  return () => {
    const next = waiters.shift()
    if (next) next()
    else active -= 1
  }
}

export async function downloadFile(
  url: string,
  destination: string,
  file: ModelFile,
  signal: AbortSignal,
  progress: (bytes: number, verifying: boolean) => void,
  options: { token?: string; concurrency?: number } = {},
): Promise<void> {
  const previous = locks.get(destination) ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const release = await slot(options.concurrency)
      const part = `${destination}.part`
      try {
        signal.throwIfAborted()
        await mkdir(dirname(destination), { recursive: true })
        const verify = async (path: string): Promise<boolean> => {
          if ((await fileSize(path)) !== file.size) return false
          progress(file.size, true)
          return !file.oid || file.oid.length !== 64 || (await hashFile(path)) === file.oid
        }
        if (await verify(destination)) {
          progress(file.size, false)
          return
        }
        // A corrupt completed blob must never be mistaken for an installed file.
        if ((await fileSize(destination)) >= 0) await rm(destination)
        let offset = Math.max(0, await fileSize(part))
        if (offset > file.size) {
          await rm(part)
          offset = 0
        }
        if (offset === file.size && (await verify(part))) {
          signal.throwIfAborted()
          await rename(part, destination)
          progress(file.size, false)
          return
        }
        if (offset === file.size) {
          await rm(part)
          offset = 0
        }
        let response = await fetch(url, {
          headers: { ...(offset ? { range: `bytes=${offset}-` } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
          signal,
          redirect: 'follow',
        })
        if (response.status === 416) {
          await response.body?.cancel()
          offset = 0
          response = await fetch(url, { signal, redirect: 'follow', headers: options.token ? { authorization: `Bearer ${options.token}` } : undefined })
        }
        if (response.status !== 200 && response.status !== 206)
          throw new Error(`下载 HTTP ${response.status}`)
        if (response.status === 200) offset = 0
        if (response.status === 206) {
          const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
          if (
            !range ||
            Number(range[1]) !== offset ||
            Number(range[3]) !== file.size ||
            Number(range[2]) !== file.size - 1
          ) {
            await response.body?.cancel()
            throw new Error('服务器返回了无效的续传范围，请重试')
          }
        }
        if (!response.body) throw new Error('下载响应为空')
        const handle = await open(part, offset ? 'a' : 'w')
        let written = offset
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            signal.throwIfAborted()
            // FileHandle.write is allowed to write fewer bytes than requested.
            let start = 0
            while (start < chunk.byteLength) {
              const { bytesWritten } = await handle.write(chunk, start, chunk.byteLength - start)
              if (!bytesWritten) throw new Error('磁盘写入失败')
              start += bytesWritten
            }
            written += chunk.byteLength
            if (written > file.size) throw new Error('下载文件超过预期大小')
            progress(written, false)
          }
        } finally {
          await handle.close()
        }
        signal.throwIfAborted()
        if (!(await verify(part))) {
          // Preserve a truncated file for resumption; discard only a full, corrupt file.
          if ((await fileSize(part)) >= file.size) await rm(part)
          throw new Error(`文件大小或 SHA256 校验失败：${file.path}`)
        }
        signal.throwIfAborted()
        await rename(part, destination)
        progress(file.size, false)
      } finally {
        release()
      }
    })
  locks.set(destination, current)
  try {
    await current
  } finally {
    if (locks.get(destination) === current) locks.delete(destination)
  }
}

export async function validateSnapshot(
  root: string,
  files: ModelFile[],
  role: string,
  subfolder = '',
): Promise<boolean> {
  try {
    if (!files.length) return false
    for (const file of files)
      if ((await fileSize(safePath(root, file.path))) !== file.size) return false
    const component = subfolder ? safePath(root, subfolder) : root
    if (role === 'support') {
      for (const file of [
        'model_index.json',
        'pipeline_moss_image.py',
        'scheduler/scheduler_config.json',
      ]) {
        if ((await fileSize(safePath(root, file))) <= 0) return false
      }
    } else if (['dit', 'text_encoder', 'vae'].includes(role)) {
      if ((await fileSize(safePath(component, 'config.json'))) <= 0) return false
      const prefix = subfolder ? `${subfolder}/` : ''
      const localFiles = files.filter((file) => file.path.startsWith(prefix))
      const weights = localFiles.filter((file) => file.path.endsWith('.safetensors'))
      if (!weights.length) return false
      for (const file of localFiles.filter((item) =>
        item.path.endsWith('.safetensors.index.json'),
      )) {
        const index = JSON.parse(await readFile(safePath(root, file.path), 'utf8')) as {
          weight_map: Record<string, string>
        }
        const shards = [...new Set(Object.values(index.weight_map))]
        if (!shards.length) return false
        for (const shard of shards)
          if ((await fileSize(safePath(dirname(safePath(root, file.path)), shard))) <= 0)
            return false
      }
      if (role === 'text_encoder') {
        if ((await fileSize(safePath(root, 'tokenizer/tokenizer_config.json'))) <= 0) return false
        if (
          (await fileSize(safePath(root, 'tokenizer/tokenizer.json'))) <= 0 &&
          !(
            (await fileSize(safePath(root, 'tokenizer/vocab.json'))) > 0 &&
            (await fileSize(safePath(root, 'tokenizer/merges.txt'))) > 0
          )
        )
          return false
      }
    }
    return true
  } catch {
    return false
  }
}
