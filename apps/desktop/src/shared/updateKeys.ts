/**
 * Public keys that sign update-<channel>.json (Ed25519, base64 of the raw 32-byte key).
 *
 * The private key is the release secret MOSS_UPDATE_SIGNING_KEY. Rotating: add the new key here,
 * ship a release signed with the OLD key (so clients learn the new one), then sign with the new key
 * and drop the old entry one release later.
 */
export interface UpdatePublicKey {
  /** Matches `keyId` in update-<channel>.json.sig. */
  id: string
  /** Base64 of the raw 32-byte Ed25519 public key. */
  publicKey: string
}

/**
 * Production keys trusted by every build. Empty until the first signing key is generated: with no
 * key, every feed is rejected and the app reports the update check as failed (never as trusted).
 */
export const PRODUCTION_UPDATE_KEYS: readonly UpdatePublicKey[] = []

/** True when this source tree ships no production key yet (release builds cannot update). */
export const PRODUCTION_UPDATE_KEYS_MISSING = PRODUCTION_UPDATE_KEYS.length === 0

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/

function rawLength(base64: string): number {
  try {
    return atob(base64).length
  } catch {
    return -1
  }
}

/** Throws unless `value` is a list of `{ id, publicKey }` with 32-byte base64 keys. */
export function parseUpdateKeys(value: unknown): UpdatePublicKey[] {
  if (!Array.isArray(value)) throw new Error('update keys must be a JSON array of { id, publicKey }')
  return value.map((item, index) => {
    const entry = item as Partial<UpdatePublicKey> | null
    if (!entry || typeof entry.id !== 'string' || !KEY_ID.test(entry.id)) throw new Error(`update key ${index}: bad id`)
    if (typeof entry.publicKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.publicKey)) {
      throw new Error(`update key ${entry.id}: publicKey must be base64`)
    }
    if (rawLength(entry.publicKey) !== 32) throw new Error(`update key ${entry.id}: publicKey must be 32 bytes`)
    return { id: entry.id, publicKey: entry.publicKey }
  })
}

/**
 * The electron-vite `define` values for the main build. Read from the BUILD environment only:
 *   MOSS_UPDATE_TEST_KEYS  JSON array of extra trusted keys (CI integration builds only)
 *   MOSS_UPDATE_FEED_URL   feed URL override (CI only); `{channel}` is replaced, otherwise
 *                          update-<channel>.json is appended to it as a directory
 * Anything else (every release build) gets `[]` and `""`. The app never reads keys at runtime.
 */
export function updateBuildDefines(env: Record<string, string | undefined>): Record<'__MOSS_UPDATE_TEST_KEYS__' | '__MOSS_UPDATE_FEED_URL__', string> {
  const rawKeys = env['MOSS_UPDATE_TEST_KEYS']?.trim()
  const keys = rawKeys ? parseUpdateKeys(JSON.parse(rawKeys)) : []
  const feedUrl = env['MOSS_UPDATE_FEED_URL']?.trim() ?? ''
  if (feedUrl && !/^https?:\/\//.test(feedUrl)) throw new Error('MOSS_UPDATE_FEED_URL must be an http(s) URL')
  return {
    __MOSS_UPDATE_TEST_KEYS__: JSON.stringify(keys),
    __MOSS_UPDATE_FEED_URL__: JSON.stringify(feedUrl),
  }
}
