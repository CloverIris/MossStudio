import { createHash } from 'node:crypto'
// original-fs: in the packaged main process node:fs treats every *.asar as a folder; app folders are plain files here.
import { createReadStream, createWriteStream, promises as fsp } from 'original-fs'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

const { mkdir, rename, rm, stat, truncate } = fsp

export interface AssetDownloadOptions {
  /** Transport URLs in order (GitHub, mirrors). All serve the same bytes, checked by sha256. */
  urls: readonly string[]
  /** Final path; `<dest>.part` holds the bytes so far and survives restarts. */
  dest: string
  sha256: string
  size: number
  signal?: AbortSignal
  /** Called with the bytes on disk so far. */
  onProgress?: (bytes: number) => void
  fetchImpl?: typeof fetch
  /** Abort an attempt that receives nothing for this long, then try the next transport. */
  stallMs?: number
  /** Passes over all transports before giving up. */
  rounds?: number
  userAgent?: string
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

function aborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted)
}

/**
 * Download one asset with HTTP Range resume. Bytes already in `<dest>.part` are kept across app
 * restarts and across transports (a mirror continues where GitHub stopped); the whole file is
 * checked against sha256 at the end and a mismatch discards it. Resolves to `dest`.
 */
export async function downloadAsset(options: AssetDownloadOptions): Promise<string> {
  const { dest, size } = options
  const part = `${dest}.part`
  await mkdir(dirname(dest), { recursive: true })
  if ((await sizeOf(dest)) === size && (await sha256File(dest)) === options.sha256) return dest
  await rm(dest, { force: true })

  const fetcher = options.fetchImpl ?? fetch
  const errors: string[] = []
  const rounds = options.rounds ?? 3
  for (let round = 0; round < rounds; round += 1) {
    let progressed = false
    for (const url of options.urls) {
      if (aborted(options.signal)) throw abortError()
      let have = await sizeOf(part)
      if (have > size) {
        await truncate(part, 0)
        have = 0
      }
      if (have < size) {
        try {
          const before = have
          have = await fetchInto(url, part, have, options, fetcher)
          if (have > before) progressed = true
          if (have < size) errors.push(`${describe(url)}: 下载不完整`)
        } catch (error) {
          if (aborted(options.signal)) throw abortError()
          const after = await sizeOf(part)
          if (after > have) progressed = true
          errors.push(`${describe(url)}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
      }
      if (have === size) {
        if ((await sha256File(part)) === options.sha256) {
          await rename(part, dest)
          return dest
        }
        // Wrong bytes (a bad mirror or a corrupted resume): start over from the next transport.
        await rm(part, { force: true })
        errors.push(`${describe(url)}: sha256 不匹配`)
        progressed = true
      }
    }
    if (!progressed) break
  }
  throw new Error(`下载更新失败：${errors.slice(-4).join('；') || '没有可用的下载地址'}`)
}

async function fetchInto(
  url: string,
  part: string,
  have: number,
  options: AssetDownloadOptions,
  fetcher: typeof fetch,
): Promise<number> {
  const attempt = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, attempt.signal]) : attempt.signal
  const stallMs = options.stallMs ?? 30_000
  let stall = setTimeout(() => attempt.abort(new Error('下载超时')), stallMs)
  const kick = (): void => {
    clearTimeout(stall)
    stall = setTimeout(() => attempt.abort(new Error('下载超时')), stallMs)
  }
  try {
    // identity: byte offsets for Range resume and the sha256 are over the raw bytes, never a decoded body.
    const headers: Record<string, string> = { 'user-agent': options.userAgent ?? 'MossStudio-Updater', 'accept-encoding': 'identity' }
    if (have > 0) headers['range'] = `bytes=${have}-`
    const response = await fetcher(url, { redirect: 'follow', headers, signal })
    let offset = 0
    if (response.status === 206) {
      offset = rangeStart(response.headers.get('content-range'))
      if (offset !== have) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('服务器返回的续传位置不符')
      }
    } else if (response.status === 416 && have > 0) {
      // Nothing after `have`: the file may be complete already; the hash decides.
      await response.body?.cancel().catch(() => undefined)
      return have
    } else if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`HTTP ${response.status}`)
    }
    if (!response.body) throw new Error('空响应')
    if (offset === 0 && have > 0) await truncate(part, 0)
    let written = offset
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length
        if (written > options.size) {
          done(new Error('下载内容超过声明的大小'))
          return
        }
        kick()
        options.onProgress?.(written)
        done(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      limit,
      createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }),
      { signal },
    )
    return written
  } catch (error) {
    if (attempt.signal.aborted && !aborted(options.signal)) throw attempt.signal.reason instanceof Error ? attempt.signal.reason : new Error('下载超时')
    throw error
  } finally {
    clearTimeout(stall)
  }
}

function rangeStart(header: string | null): number {
  const match = header ? /^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/i.exec(header.trim()) : null
  return match ? Number(match[1]) : -1
}

function describe(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function abortError(): Error {
  return Object.assign(new Error('已取消'), { name: 'AbortError' })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
