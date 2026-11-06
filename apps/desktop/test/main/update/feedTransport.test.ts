import { describe, expect, it } from 'vitest'
import { compareToHighWater, fetchVerifiedFeed, FeedRollbackError } from '@main/update/feed'
import { feedFixture, makeKey, signFeed } from './helpers'

const key = makeKey('ci')
const GH = 'https://github.com/CloverIris/MossStudio/releases/download/updates/update-stable.json'

function signed(version: string): { feed: Buffer; sig: Buffer } {
  const feed = Buffer.from(JSON.stringify(feedFixture({ version })))
  return { feed, sig: signFeed(feed, key) }
}

describe('fetchVerifiedFeed anti-rollback across transports', () => {
  it('skips a transport serving an older signed feed and takes the next one', async () => {
    const stale = signed('1.1.0')
    const fresh = signed('1.2.0')
    const seen: string[] = []
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input)
      seen.push(url)
      const body = url.startsWith('https://github.com/') ? stale : fresh
      return new Response(url.endsWith('.sig') ? body.sig : body.feed)
    }) as typeof fetch
    const result = await fetchVerifiedFeed('stable', {
      keys: [key.publicKey], settings: { networkMode: 'auto', gitMirror: null }, url: GH, fetchImpl,
      highWater: { version: '1.2.0', publishedAt: '2026-11-01T00:00:00.000Z' },
    })
    expect(result.feed.version).toBe('1.2.0')
    expect(result.source).not.toBe(GH)
    expect(seen[0]).toBe(GH)
  })

  it('fails with the rollback reason when every transport is stale', async () => {
    const stale = signed('1.1.0')
    const fetchImpl = (async (input: string | URL) => new Response(String(input).endsWith('.sig') ? stale.sig : stale.feed)) as typeof fetch
    await expect(fetchVerifiedFeed('stable', {
      keys: [key.publicKey], settings: { networkMode: 'direct', gitMirror: null }, url: GH, fetchImpl,
      highWater: { version: '1.2.0', publishedAt: '2026-11-01T00:00:00.000Z' },
    })).rejects.toThrow('版本回退')
    expect(new FeedRollbackError({ version: '1.1.0' }, { version: '1.2.0', publishedAt: '' }).name).toBe('FeedRollbackError')
  })

  it('orders by version, then by publishedAt', () => {
    const mark = { version: '1.2.0', publishedAt: '2026-11-02T00:00:00.000Z' }
    expect(compareToHighWater({ version: '1.2.1', publishedAt: '2020-01-01T00:00:00Z' }, mark)).toBeGreaterThan(0)
    expect(compareToHighWater({ version: '1.2.0-rc.1', publishedAt: '2030-01-01T00:00:00Z' }, mark)).toBeLessThan(0)
    expect(compareToHighWater({ version: '1.2.0', publishedAt: '2026-11-01T00:00:00Z' }, mark)).toBeLessThan(0)
    expect(compareToHighWater({ version: '1.2.0', publishedAt: '2026-11-02T00:00:00.000Z' }, mark)).toBe(0)
  })
})
