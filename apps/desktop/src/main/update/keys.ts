import { feedUrl, UPDATE_CHANNELS, type UpdateChannel } from '@shared/install'
import { NIGHTLY_UPDATE_KEYS, PRODUCTION_UPDATE_KEYS, parseUpdateKeys, type UpdatePublicKey } from '@shared/updateKeys'

/**
 * The keys a channel's feed may be signed with: the production keys, the nightly keys for the
 * nightly feed only, and, in CI integration builds only, the test keys baked in at BUILD time via
 * the `__MOSS_UPDATE_TEST_KEYS__` define (release builds define it as []). Nothing here reads
 * the runtime environment: a key from the environment would let anyone sign a feed.
 */
export function trustedUpdateKeys(
  channel: UpdateChannel,
  keys: { production: readonly UpdatePublicKey[]; nightly: readonly UpdatePublicKey[] } = {
    production: PRODUCTION_UPDATE_KEYS,
    nightly: NIGHTLY_UPDATE_KEYS,
  },
): UpdatePublicKey[] {
  const test = typeof __MOSS_UPDATE_TEST_KEYS__ === 'undefined' ? [] : parseUpdateKeys(__MOSS_UPDATE_TEST_KEYS__)
  return [...keys.production, ...(channel === 'nightly' ? keys.nightly : []), ...test]
}

/** True when some channel can be verified at all (otherwise updating is unsupported). */
export function hasAnyUpdateKey(keys: (channel: UpdateChannel) => readonly UpdatePublicKey[] = trustedUpdateKeys): boolean {
  return UPDATE_CHANNELS.some((channel) => keys(channel).length > 0)
}

/** Feed URL for a channel: feedUrl() unless the build defined `__MOSS_UPDATE_FEED_URL__` (CI). */
export function updateFeedUrl(channel: UpdateChannel, override: string = buildFeedOverride()): string {
  if (!override) return feedUrl(channel)
  if (override.includes('{channel}')) return override.replaceAll('{channel}', channel)
  return `${override.replace(/\/+$/, '')}/update-${channel}.json`
}

function buildFeedOverride(): string {
  return typeof __MOSS_UPDATE_FEED_URL__ === 'undefined' ? '' : __MOSS_UPDATE_FEED_URL__
}

/** True only in CI integration builds: the build baked in at least one test key. */
export function isUpdateTestBuild(): boolean {
  return typeof __MOSS_UPDATE_TEST_KEYS__ !== 'undefined' && __MOSS_UPDATE_TEST_KEYS__.length > 0
}
