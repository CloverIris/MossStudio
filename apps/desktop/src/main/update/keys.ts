import { feedUrl, type UpdateChannel } from '@shared/install'
import { PRODUCTION_UPDATE_KEYS, parseUpdateKeys, type UpdatePublicKey } from '@shared/updateKeys'

/**
 * Production keys plus, in CI integration builds only, the test keys baked in at BUILD time via
 * the `__MOSS_UPDATE_TEST_KEYS__` define (release builds define it as []). Nothing here reads
 * the runtime environment: a key from the environment would let anyone sign a feed.
 */
export function trustedUpdateKeys(): UpdatePublicKey[] {
  const test = typeof __MOSS_UPDATE_TEST_KEYS__ === 'undefined' ? [] : parseUpdateKeys(__MOSS_UPDATE_TEST_KEYS__)
  return [...PRODUCTION_UPDATE_KEYS, ...test]
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
