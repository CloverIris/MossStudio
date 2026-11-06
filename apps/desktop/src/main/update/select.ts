import type { FeedAsset, PlatformKey, UpdateChannel, UpdateFeed } from '@shared/install'
import { compareSemver, type UpdateAnnouncement } from '@shared/update'

type FeedPlatform = UpdateFeed['platforms'][string]

export interface UpdateSelection {
  feed: UpdateFeed
  version: string
  platform: FeedPlatform
  /** What to download: the delta from `current` when one exists and is smaller, else the full zip. */
  download: { kind: 'full' | 'delta'; asset: FeedAsset; from?: string }
  files: FeedAsset
}

/** The feeds a channel reads: beta takes the newest of beta and stable. */
export function channelsToRead(channel: UpdateChannel): UpdateChannel[] {
  return channel === 'beta' ? ['beta', 'stable'] : ['stable']
}

/**
 * Pick the update to offer. Skips versions not newer than `current` (semver with prerelease
 * ordering), versions in `failed`, versions up to `skipped`, and feeds without this platform. Unknown platform keys in the
 * feed are ignored.
 */
export function selectUpdate(input: {
  feeds: readonly UpdateFeed[]
  current: string
  failed: readonly string[]
  platform: PlatformKey
  /** Rolled back from by the user: it and anything not newer stays hidden. */
  skipped?: string | null
}): UpdateSelection | null {
  const failed = new Set(input.failed)
  const skipped = input.skipped ?? null
  const candidates = [...input.feeds].sort((a, b) => compareSemver(b.version, a.version))
  for (const feed of candidates) {
    if (compareSemver(feed.version, input.current) <= 0) continue
    if (failed.has(feed.version)) continue
    if (skipped && compareSemver(feed.version, skipped) <= 0) continue
    const platform = feed.platforms[input.platform]
    if (!platform) continue
    const delta = platform.deltas
      .filter((item) => item.from === input.current && item.size < platform.full.size)
      .sort((a, b) => a.size - b.size)[0]
    return {
      feed,
      version: feed.version,
      platform,
      download: delta ? { kind: 'delta', asset: delta, from: delta.from } : { kind: 'full', asset: platform.full },
      files: platform.files,
    }
  }
  return null
}

/** The strictest minimumVersion any verified feed of this channel states. */
export function minimumVersionOf(feeds: readonly UpdateFeed[]): string | null {
  let minimum: string | null = null
  for (const feed of feeds) {
    if (feed.minimumVersion && (!minimum || compareSemver(feed.minimumVersion, minimum) > 0)) minimum = feed.minimumVersion
  }
  return minimum
}

/** Announcements of the verified feeds, deduplicated by id, minus dismissed and expired ones. */
export function activeAnnouncements(feeds: readonly UpdateFeed[], dismissed: readonly string[], now = Date.now()): UpdateAnnouncement[] {
  const hidden = new Set(dismissed)
  const seen = new Set<string>()
  const result: UpdateAnnouncement[] = []
  for (const feed of feeds) {
    for (const item of feed.announcements) {
      if (seen.has(item.id) || hidden.has(item.id)) continue
      seen.add(item.id)
      if (item.until) {
        const until = Date.parse(item.until)
        if (Number.isFinite(until) && until < now) continue
      }
      result.push({ id: item.id, level: item.level, title: item.title, body: item.body, url: item.url, until: item.until })
    }
  }
  return result
}
