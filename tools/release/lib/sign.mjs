// Ed25519 feed signatures (shared/install.ts feedSignatureSchema) with Node's crypto.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

// DER prefixes that wrap a raw 32-byte Ed25519 seed / public key (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * The signing key from MOSS_UPDATE_SIGNING_KEY: a PKCS8 PEM, or base64 of the raw 32-byte
 * seed (a 64-byte seed+public key, as libsodium stores it, is accepted too).
 */
export function parsePrivateKey(text) {
  const value = String(text ?? '').trim()
  if (!value) throw new Error('empty signing key')
  let key
  if (value.includes('-----BEGIN')) {
    key = createPrivateKey({ key: value, format: 'pem' })
  } else {
    if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) throw new Error('signing key is neither PEM nor base64')
    const raw = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    if (raw.length !== 32 && raw.length !== 64) throw new Error(`base64 signing key must hold 32 (or 64) bytes, got ${raw.length}`)
    key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' })
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`signing key is ${key.asymmetricKeyType}, expected ed25519`)
  return key
}

/** Raw 32-byte public key, base64: the format of apps/desktop/src/shared/updateKeys.ts. */
export function publicKeyBase64(privateOrPublicKey) {
  const jwk = createPublicKey(privateOrPublicKey).export({ format: 'jwk' })
  return Buffer.from(jwk.x, 'base64url').toString('base64')
}

export function publicKeyFromBase64(base64) {
  const raw = Buffer.from(base64, 'base64')
  if (raw.length !== 32) throw new Error(`public key must be 32 bytes, got ${raw.length}`)
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

/** Stable key id derived from the public key, so no separate secret has to carry it. */
export function keyIdFor(publicKeyB64) {
  return `ed25519-${createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 16)}`
}

/** update-<channel>.json.sig content for the exact feed bytes. */
export function signFeed(feedBytes, privateKey) {
  const publicKey = publicKeyBase64(privateKey)
  return { keyId: keyIdFor(publicKey), signature: sign(null, feedBytes, privateKey).toString('base64') }
}

/** True when `sig` is a valid signature over `feedBytes` by one of `trusted` ({ id, publicKey }). */
export function verifyFeed(feedBytes, sig, trusted) {
  const key = trusted.find((candidate) => candidate.id === sig.keyId)
  if (!key) return false
  try {
    return verify(null, feedBytes, publicKeyFromBase64(key.publicKey), Buffer.from(sig.signature, 'base64'))
  } catch {
    return false
  }
}

/** A fresh pair: the seed (base64) for MOSS_UPDATE_SIGNING_KEY and the public entry for updateKeys.ts. */
export function generateKeyPair() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' })
  const seed = der.subarray(der.length - 32).toString('base64')
  const publicKey = publicKeyBase64(privateKey)
  return { privateKeyBase64: seed, privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey, id: keyIdFor(publicKey) }
}
