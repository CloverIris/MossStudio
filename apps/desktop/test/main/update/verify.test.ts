import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { feedUrl } from '@shared/install'
import { NIGHTLY_UPDATE_KEYS, PRODUCTION_UPDATE_KEYS, parseUpdateKeys, updateBuildDefines } from '@shared/updateKeys'
import { hasAnyUpdateKey, trustedUpdateKeys, updateFeedUrl } from '@main/update/keys'
import { FeedSignatureError, parseFileList, parseVerifiedFeed, verifyFeedSignature } from '@main/update/verify'
import { feedFixture, makeKey, signFeed } from './helpers'

const key = makeKey('release-2026')
const other = makeKey('release-2026')
const feedBytes = Buffer.from(JSON.stringify(feedFixture({ version: '1.1.0' })))

describe('verifyFeedSignature', () => {
  it('accepts a feed signed by a trusted key', () => {
    expect(verifyFeedSignature(feedBytes, signFeed(feedBytes, key), [key.publicKey])).toBe('release-2026')
  })

  it('picks the key by id among several', () => {
    const second = makeKey('next')
    expect(verifyFeedSignature(feedBytes, signFeed(feedBytes, second), [key.publicKey, second.publicKey])).toBe('next')
  })

  it('rejects a signature made with the wrong key under a trusted id', () => {
    expect(() => verifyFeedSignature(feedBytes, signFeed(feedBytes, other, 'release-2026'), [key.publicKey])).toThrow('签名校验失败')
  })

  it('rejects a feed with one byte changed', () => {
    const sig = signFeed(feedBytes, key)
    const tampered = Buffer.from(feedBytes)
    tampered[tampered.length - 2] ^= 0x01
    expect(() => verifyFeedSignature(tampered, sig, [key.publicKey])).toThrow(FeedSignatureError)
  })

  it('rejects a missing or empty signature', () => {
    expect(() => verifyFeedSignature(feedBytes, null, [key.publicKey])).toThrow('缺少签名')
    expect(() => verifyFeedSignature(feedBytes, Buffer.alloc(0), [key.publicKey])).toThrow('缺少签名')
  })

  it('rejects an unknown key id', () => {
    expect(() => verifyFeedSignature(feedBytes, signFeed(feedBytes, key, 'someone-else'), [key.publicKey])).toThrow('未知的密钥')
  })

  it('rejects malformed signature files and truncated signatures', () => {
    expect(() => verifyFeedSignature(feedBytes, Buffer.from('not json'), [key.publicKey])).toThrow('格式无效')
    expect(() => verifyFeedSignature(feedBytes, Buffer.from(JSON.stringify({ keyId: key.id })), [key.publicKey])).toThrow('格式无效')
    const short = JSON.stringify({ keyId: key.id, signature: Buffer.alloc(10).toString('base64') })
    expect(() => verifyFeedSignature(feedBytes, Buffer.from(short), [key.publicKey])).toThrow('签名校验失败')
  })

  it('trusts nothing with no keys at all', () => {
    expect(() => verifyFeedSignature(feedBytes, signFeed(feedBytes, key), [])).toThrow('未知的密钥')
  })
})

describe('parseVerifiedFeed', () => {
  it('parses only after the signature checks out, ignoring unknown keys and platforms', () => {
    const asset = { url: 'https://github.com/ShallowElec/MossStudio/releases/download/v1.1.0/a.zip', sha256: 'a'.repeat(64), size: 10 }
    const raw = Buffer.from(
      JSON.stringify({
        ...feedFixture({ version: '1.1.0' }),
        futureField: { anything: true },
        platforms: { 'linux-x64': { full: asset, files: asset }, 'freebsd-riscv64': { whatever: 1 } },
      }),
    )
    // An unknown platform with an unknown shape must not reject the feed.
    const parsed = parseVerifiedFeed(raw, signFeed(raw, key), [key.publicKey], 'stable')
    expect(parsed.version).toBe('1.1.0')
    expect(parsed.platforms['linux-x64']?.deltas).toEqual([])
  })

  it('does not parse an unsigned feed even when it is valid JSON', () => {
    expect(() => parseVerifiedFeed(feedBytes, signFeed(feedBytes, other, 'x'), [key.publicKey], 'stable')).toThrow(FeedSignatureError)
  })

  it('refuses a signed feed of the other channel', () => {
    const beta = Buffer.from(JSON.stringify(feedFixture({ version: '1.2.0-beta.1', channel: 'beta' })))
    expect(() => parseVerifiedFeed(beta, signFeed(beta, key), [key.publicKey], 'stable')).toThrow('渠道不匹配')
  })

  it('refuses a signed feed that is not a valid feed', () => {
    const junk = Buffer.from(JSON.stringify({ schema: 2 }))
    expect(() => parseVerifiedFeed(junk, signFeed(junk, key), [key.publicKey], 'stable')).toThrow('格式无效')
  })
})

describe('parseFileList', () => {
  it('checks the schema and the version', () => {
    const list = Buffer.from(JSON.stringify({ schema: 1, version: '1.1.0', platform: 'linux-x64', entries: [] }))
    expect(parseFileList(list, '1.1.0').entries).toEqual([])
    expect(() => parseFileList(list, '1.2.0')).toThrow('版本不匹配')
    expect(() => parseFileList(Buffer.from('{'), '1.1.0')).toThrow('不是有效的 JSON')
  })
})

describe('keys and build defines', () => {
  it('ships production keys in the expected shape', () => {
    expect(parseUpdateKeys([...PRODUCTION_UPDATE_KEYS])).toEqual([...PRODUCTION_UPDATE_KEYS])
  })

  it('defines no test keys and no feed override unless the BUILD env sets them (release config)', () => {
    expect(updateBuildDefines({})).toEqual({ __MOSS_UPDATE_TEST_KEYS__: '[]', __MOSS_UPDATE_FEED_URL__: '""' })
    // Runtime env never matters: only the build env passed here does.
    expect(updateBuildDefines({ MOSS_UPDATE_TEST_KEYS: '', MOSS_UPDATE_FEED_URL: '' })).toEqual({
      __MOSS_UPDATE_TEST_KEYS__: '[]',
      __MOSS_UPDATE_FEED_URL__: '""',
    })
  })

  it('bakes CI test keys and the feed URL in when the build env sets them', () => {
    const defines = updateBuildDefines({
      MOSS_UPDATE_TEST_KEYS: JSON.stringify([key.publicKey]),
      MOSS_UPDATE_FEED_URL: 'http://127.0.0.1:8080/feed',
    })
    expect(JSON.parse(defines.__MOSS_UPDATE_TEST_KEYS__)).toEqual([key.publicKey])
    expect(JSON.parse(defines.__MOSS_UPDATE_FEED_URL__)).toBe('http://127.0.0.1:8080/feed')
  })

  it('fails the build on malformed test keys or feed URLs', () => {
    expect(() => updateBuildDefines({ MOSS_UPDATE_TEST_KEYS: '{"id":"x"}' })).toThrow()
    expect(() => updateBuildDefines({ MOSS_UPDATE_TEST_KEYS: JSON.stringify([{ id: 'x', publicKey: 'AAAA' }]) })).toThrow('32 bytes')
    expect(() => updateBuildDefines({ MOSS_UPDATE_FEED_URL: 'file:///tmp/feed' })).toThrow()
  })

  it('wires the defines into the main build of electron.vite.config.ts', () => {
    const config = readFileSync(join(__dirname, '..', '..', '..', 'electron.vite.config.ts'), 'utf8')
    expect(config).toMatch(/main:\s*\{[\s\S]*?define:\s*updateBuildDefines\(process\.env\)/)
  })

  it('trusts only the production keys when the test-key define is absent, whatever the runtime env says', () => {
    process.env['MOSS_UPDATE_TEST_KEYS'] = JSON.stringify([key.publicKey])
    try {
      expect(trustedUpdateKeys('stable')).toEqual([...PRODUCTION_UPDATE_KEYS])
    } finally {
      delete process.env['MOSS_UPDATE_TEST_KEYS']
    }
  })

  it('trusts the nightly keys for the nightly feed only', () => {
    const production = [makeKey('production').publicKey]
    const nightly = [makeKey('nightly').publicKey]
    expect(trustedUpdateKeys('stable', { production, nightly })).toEqual(production)
    expect(trustedUpdateKeys('beta', { production, nightly })).toEqual(production)
    expect(trustedUpdateKeys('nightly', { production, nightly })).toEqual([...production, ...nightly])
    // A build with only a nightly key can still update, on 每日构建.
    expect(hasAnyUpdateKey((channel) => trustedUpdateKeys(channel, { production: [], nightly }))).toBe(true)
    expect(hasAnyUpdateKey((channel) => trustedUpdateKeys(channel, { production: [], nightly: [] }))).toBe(false)
  })

  it('ships no key that signs both the production and the nightly feeds', () => {
    const production = new Set(PRODUCTION_UPDATE_KEYS.map((item) => item.publicKey))
    expect(NIGHTLY_UPDATE_KEYS.filter((item) => production.has(item.publicKey))).toEqual([])
    expect(() => parseUpdateKeys(NIGHTLY_UPDATE_KEYS)).not.toThrow()
  })

  it('resolves the feed URL, with the CI override as a template or a folder', () => {
    expect(updateFeedUrl('beta', '')).toBe(feedUrl('beta'))
    expect(updateFeedUrl('beta', 'http://127.0.0.1:9/feeds/')).toBe('http://127.0.0.1:9/feeds/update-beta.json')
    expect(updateFeedUrl('stable', 'http://127.0.0.1:9/{channel}.json')).toBe('http://127.0.0.1:9/stable.json')
    expect(updateFeedUrl('stable')).toBe(feedUrl('stable'))
  })
})
