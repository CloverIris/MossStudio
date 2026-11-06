import type { Settings } from '@shared/types'
import { applyGitMirror, githubMirrorChain } from '../services/network'

const GITHUB = /^https:\/\/github\.com\//

/**
 * Where to fetch a GitHub URL from, in order. Mirrors are transport only: whatever they return is
 * still checked against the feed signature or the asset's sha256 by the caller.
 *   direct mode            → GitHub only
 *   user chose a mirror    → the mirror chain, then GitHub
 *   otherwise              → GitHub, then the mirror chain (probe pick + built-ins)
 * URLs that are not on github.com (a CI feed on localhost) are used as is.
 */
export function transportUrls(url: string, settings: Pick<Settings, 'networkMode' | 'gitMirror'>): string[] {
  if (!GITHUB.test(url) || settings.networkMode === 'direct') return [url]
  const mirrored = githubMirrorChain(settings as Settings).map((mirror) => applyGitMirror(url, mirror))
  const userChoseMirror = settings.networkMode === 'mirror' || Boolean(settings.gitMirror?.trim())
  const ordered = userChoseMirror ? [...mirrored, url] : [url, ...mirrored]
  return [...new Set(ordered)]
}

export interface FetchBytesOptions {
  timeoutMs?: number
  /** Refuse bodies larger than this (a feed or file list is small). */
  maxBytes?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  userAgent?: string
}

/** GET a small body completely, with a timeout and a size cap. */
export async function fetchBytes(url: string, options: FetchBytesOptions = {}): Promise<Uint8Array> {
  const fetcher = options.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await fetcher(url, {
    redirect: 'follow',
    headers: { 'user-agent': options.userAgent ?? 'MossStudio-Updater', 'accept-encoding': 'identity' },
    signal,
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`HTTP ${response.status}`)
  }
  const max = options.maxBytes ?? 8 * 1024 * 1024
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('响应过大')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength
      if (total > max) throw new Error('响应过大')
      chunks.push(chunk)
    }
  }
  return Buffer.concat(chunks)
}
