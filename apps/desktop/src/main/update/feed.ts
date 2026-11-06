// original-fs: in the packaged main process node:fs treats every *.asar as a folder; app folders are plain files here.
import { promises as fsp } from 'original-fs'
import { join } from 'node:path'
import type { UpdateChannel, UpdateFeed } from '@shared/install'
import type { UpdatePublicKey } from '@shared/updateKeys'
import type { Settings } from '@shared/types'
import { compareSemver } from '@shared/update'
import { fetchBytes, transportUrls } from './transport'
import { parseVerifiedFeed } from './verify'

const { mkdir, readFile, rename, writeFile } = fsp

export interface FetchedFeed {
  feed: UpdateFeed
  /** The URL (GitHub or a mirror) the verified copy came from. */
  source: string
  bytes: Uint8Array
  sig: Uint8Array
}

/** The newest verified feed seen for a channel (anti-rollback). */
export interface FeedHighWater {
  version: string
  publishedAt: string
}

/**
 * Ordering of verified feeds: by version, then by publishedAt for a republished version.
 * Negative when `feed` is older than `mark`.
 */
export function compareToHighWater(feed: Pick<UpdateFeed, 'version' | 'publishedAt'>, mark: FeedHighWater): number {
  const byVersion = compareSemver(feed.version, mark.version)
  if (byVersion) return byVersion
  const a = Date.parse(feed.publishedAt)
  const b = Date.parse(mark.publishedAt)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.sign(a - b) : 0
}

export class FeedRollbackError extends Error {
  constructor(feed: Pick<UpdateFeed, 'version'>, mark: FeedHighWater) {
    super(`更新源版本回退（${feed.version}，已见过 ${mark.version}），可能是过期的镜像`)
    this.name = 'FeedRollbackError'
  }
}

export interface FeedFetchOptions {
  /** Refuse validly signed feeds older than this (a stale mirror or a replay). */
  highWater?: FeedHighWater | null
  keys: readonly UpdatePublicKey[]
  settings: Pick<Settings, 'networkMode' | 'gitMirror'>
  /** update-<channel>.json URL (feedUrl or the CI override). */
  url: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Fetch update-<channel>.json and its .sig from GitHub or a mirror, and return the first copy
 * whose signature verifies. Feed and signature come from the same transport so a mirror serving
 * a stale feed fails cleanly and the next one is tried.
 */
export async function fetchVerifiedFeed(channel: UpdateChannel, options: FeedFetchOptions): Promise<FetchedFeed> {
  const feedUrls = transportUrls(options.url, options.settings)
  const sigUrls = transportUrls(`${options.url}.sig`, options.settings)
  const errors: string[] = []
  for (let index = 0; index < feedUrls.length; index += 1) {
    const feedUrl = feedUrls[index]!
    const sigUrl = sigUrls[index] ?? `${feedUrl}.sig`
    try {
      const fetchOptions = { fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: options.timeoutMs }
      const [bytes, sig] = await Promise.all([
        fetchBytes(feedUrl, { ...fetchOptions, maxBytes: 2 * 1024 * 1024 }),
        fetchBytes(sigUrl, { ...fetchOptions, maxBytes: 16 * 1024 }),
      ])
      const feed = parseVerifiedFeed(bytes, sig, options.keys, channel)
      if (options.highWater && compareToHighWater(feed, options.highWater) < 0) throw new FeedRollbackError(feed, options.highWater)
      return { feed, source: feedUrl, bytes, sig }
    } catch (error) {
      if (options.signal?.aborted) throw error
      errors.push(`${hostOf(feedUrl)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`检查更新失败：${errors.join('；') || '没有可用的更新源'}`)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The last verified feed per channel, kept so announcements and the minimumVersion gate survive
 * an offline start. It is re-verified on every read: the cache is not trusted either.
 */
export async function saveFeedCache(dir: string, channel: UpdateChannel, fetched: Pick<FetchedFeed, 'bytes' | 'sig'>): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const [name, data] of [[`update-${channel}.json`, fetched.bytes], [`update-${channel}.json.sig`, fetched.sig]] as const) {
    const file = join(dir, name)
    await writeFile(`${file}.tmp`, data)
    await rename(`${file}.tmp`, file)
  }
}

export async function loadFeedCache(dir: string, channel: UpdateChannel, keys: readonly UpdatePublicKey[], highWater: FeedHighWater | null = null): Promise<UpdateFeed | null> {
  try {
    const bytes = await readFile(join(dir, `update-${channel}.json`))
    const sig = await readFile(join(dir, `update-${channel}.json.sig`))
    const feed = parseVerifiedFeed(bytes, sig, keys, channel)
    return highWater && compareToHighWater(feed, highWater) < 0 ? null : feed
  } catch {
    return null
  }
}

const HIGH_WATER_FILE = 'update-feed-highwater.json'

type HighWaterFile = Partial<Record<UpdateChannel, FeedHighWater>>

async function readHighWaterFile(dir: string): Promise<HighWaterFile> {
  try {
    const raw = JSON.parse(await readFile(join(dir, HIGH_WATER_FILE), 'utf8')) as Record<string, unknown>
    const result: HighWaterFile = {}
    for (const channel of ['stable', 'beta'] as const) {
      const entry = raw[channel] as Partial<FeedHighWater> | undefined
      if (entry && typeof entry.version === 'string' && typeof entry.publishedAt === 'string') result[channel] = { version: entry.version, publishedAt: entry.publishedAt }
    }
    return result
  } catch {
    return {}
  }
}

async function writeHighWaterFile(dir: string, value: HighWaterFile): Promise<void> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, HIGH_WATER_FILE)
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  await rename(`${file}.tmp`, file)
}

export async function loadHighWater(dir: string, channel: UpdateChannel): Promise<FeedHighWater | null> {
  return (await readHighWaterFile(dir))[channel] ?? null
}

/** Raise the channel's mark to `feed` when it is newer; never lowers it. */
export async function raiseHighWater(dir: string, channel: UpdateChannel, feed: Pick<UpdateFeed, 'version' | 'publishedAt'>): Promise<void> {
  const marks = await readHighWaterFile(dir)
  const mark = marks[channel]
  if (mark && compareToHighWater(feed, mark) <= 0) return
  await writeHighWaterFile(dir, { ...marks, [channel]: { version: feed.version, publishedAt: feed.publishedAt } })
}

/** Forget a channel's mark: switching to a channel starts its comparison afresh. */
export async function resetHighWater(dir: string, channel: UpdateChannel): Promise<void> {
  const marks = await readHighWaterFile(dir)
  if (!marks[channel]) return
  const { [channel]: _dropped, ...rest } = marks
  await writeHighWaterFile(dir, rest)
}
