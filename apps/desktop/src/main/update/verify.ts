import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import {
  feedSignatureSchema,
  fileListSchema,
  PLATFORM_KEYS,
  updateFeedSchema,
  type FileList,
  type UpdateChannel,
  type UpdateFeed,
} from '@shared/install'
import type { UpdatePublicKey } from '@shared/updateKeys'

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function ed25519PublicKey(rawBase64: string): KeyObject {
  const raw = Buffer.from(rawBase64, 'base64')
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes')
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

export class FeedSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedSignatureError'
  }
}

/**
 * Check update-<channel>.json.sig against the EXACT feed bytes. Throws FeedSignatureError on a
 * missing or malformed signature, an unknown key id, or a signature that does not verify.
 * Returns the key id that signed it.
 */
export function verifyFeedSignature(
  feedBytes: Uint8Array,
  sigBytes: Uint8Array | null | undefined,
  keys: readonly UpdatePublicKey[],
): string {
  if (!sigBytes || sigBytes.length === 0) throw new FeedSignatureError('更新源缺少签名')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(sigBytes).toString('utf8'))
  } catch {
    throw new FeedSignatureError('更新源签名格式无效')
  }
  const sig = feedSignatureSchema.safeParse(parsed)
  if (!sig.success) throw new FeedSignatureError('更新源签名格式无效')
  const key = keys.find((item) => item.id === sig.data.keyId)
  if (!key) throw new FeedSignatureError(`更新源签名使用了未知的密钥（${sig.data.keyId}）`)
  const signature = Buffer.from(sig.data.signature, 'base64')
  let ok = false
  try {
    ok = signature.length === 64 && verify(null, feedBytes, ed25519PublicKey(key.publicKey), signature)
  } catch {
    ok = false
  }
  if (!ok) throw new FeedSignatureError('更新源签名校验失败')
  return key.id
}

/** Verify, THEN parse. Nothing from the feed is trusted before the signature checks out. */
export function parseVerifiedFeed(
  feedBytes: Uint8Array,
  sigBytes: Uint8Array | null | undefined,
  keys: readonly UpdatePublicKey[],
  channel: UpdateChannel,
): UpdateFeed {
  verifyFeedSignature(feedBytes, sigBytes, keys)
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(feedBytes).toString('utf8'))
  } catch {
    throw new Error('更新源内容不是有效的 JSON')
  }
  const feed = updateFeedSchema.safeParse(knownPlatformsOnly(json))
  if (!feed.success) throw new Error(`更新源格式无效：${feed.error.issues[0]?.message ?? 'unknown'}`)
  // A validly signed feed of the other channel must not be replayed as this one.
  if (feed.data.channel !== channel) throw new Error(`更新源渠道不匹配（期望 ${channel}，实际 ${feed.data.channel}）`)
  // The nightly key signs without a reviewer: it may only offer nightlies, never a version that
  // would outrank every future release (9.9.9) and keep 每日构建 off the stable line for good.
  if (channel === 'nightly' && !/^\d+\.\d+\.\d+-nightly(?:\.|$)/.test(feed.data.version)) {
    throw new Error(`每日构建更新源里的版本不是每日构建（${feed.data.version}）`)
  }
  return feed.data
}

/**
 * Drop platform keys this client does not know before validation, so a future platform with a
 * new shape never makes an older client reject the whole feed.
 */
function knownPlatformsOnly(json: unknown): unknown {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return json
  const platforms = (json as { platforms?: unknown }).platforms
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) return json
  const known = new Set<string>(PLATFORM_KEYS)
  return { ...json, platforms: Object.fromEntries(Object.entries(platforms).filter(([key]) => known.has(key))) }
}

export function parseFileList(bytes: Uint8Array, version: string): FileList {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new Error('文件清单不是有效的 JSON')
  }
  const list = fileListSchema.safeParse(json)
  if (!list.success) throw new Error(`文件清单格式无效：${list.error.issues[0]?.message ?? 'unknown'}`)
  if (list.data.version !== version) throw new Error(`文件清单版本不匹配（${list.data.version}）`)
  return list.data
}
