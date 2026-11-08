import { describe, expect, it } from 'vitest'
import type { FeedAsset, UpdateFeed } from '@shared/install'
import { compareSemver } from '@shared/update'
import { activeAnnouncements, channelsToRead, minimumVersionOf, selectUpdate } from '@main/update/select'
import { feedFixture } from './helpers'

const asset = (name: string, size: number): FeedAsset => ({
  url: `https://github.com/ShallowElec/MossStudio/releases/download/x/${name}`,
  sha256: 'b'.repeat(64),
  size,
})

function feed(version: string, patch: Partial<UpdateFeed> = {}, deltas: Array<FeedAsset & { from: string }> = []): UpdateFeed {
  return feedFixture({
    version,
    platforms: { 'linux-x64': { full: asset(`full-${version}.zip`, 1000), files: asset(`files-${version}.json`, 10), deltas } },
    ...patch,
  })
}

describe('compareSemver', () => {
  it.each([
    ['1.0.3', '1.0.2', 1],
    ['1.0.3', '1.0.3', 0],
    ['1.0.3', '1.1.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.10.0', '1.9.0', 1],
    ['1.1.0-beta.1', '1.1.0', -1],
    ['1.1.0', '1.1.0-rc.1', 1],
    ['1.1.0-beta.2', '1.1.0-beta.10', -1],
    ['1.1.0-alpha', '1.1.0-beta', -1],
    ['1.1.0-beta', '1.1.0-beta.1', -1],
    ['1.1.0-1', '1.1.0-alpha', -1],
    ['1.1.0-beta.1', '1.0.9', 1],
    ['v1.2.0', '1.2.0', 0],
    ['1.2.0+build.5', '1.2.0', 0],
  ])('%s vs %s → %i', (a, b, expected) => {
    expect(Math.sign(compareSemver(a, b))).toBe(expected)
    expect(Math.sign(compareSemver(b, a))).toBe(expected === 0 ? 0 : -expected)
  })

  it('sorts unparseable versions below everything', () => {
    expect(compareSemver('garbage', '0.0.1')).toBeLessThan(0)
  })
})

describe('selectUpdate', () => {
  const pick = (feeds: UpdateFeed[], current = '1.0.3', failed: string[] = []) =>
    selectUpdate({ feeds, current, failed, platform: 'linux-x64' })

  it('offers a newer version as a full download', () => {
    const selection = pick([feed('1.1.0')])
    expect(selection).toMatchObject({ version: '1.1.0', download: { kind: 'full', asset: { size: 1000 } } })
  })

  it('skips versions that are not newer, including the same release and an older prerelease', () => {
    expect(pick([feed('1.0.3')])).toBeNull()
    expect(pick([feed('1.0.2')])).toBeNull()
    expect(pick([feed('1.0.3-beta.9')])).toBeNull()
    expect(pick([feed('1.1.0-beta.1')], '1.1.0')).toBeNull()
  })

  it('treats the release as newer than its own prerelease', () => {
    expect(pick([feed('1.1.0')], '1.1.0-beta.3')?.version).toBe('1.1.0')
    expect(pick([feed('1.1.0-beta.4', { channel: 'beta' })], '1.1.0-beta.3')?.version).toBe('1.1.0-beta.4')
  })

  it('never offers a version that failed its health check', () => {
    expect(pick([feed('1.1.0')], '1.0.3', ['1.1.0'])).toBeNull()
  })

  it('beta takes the newest of beta and stable, and falls back when the newest failed', () => {
    const beta = feed('1.2.0-beta.1', { channel: 'beta' })
    const stable = feed('1.1.0')
    expect(pick([beta, stable])?.version).toBe('1.2.0-beta.1')
    expect(pick([feed('1.1.0-beta.2', { channel: 'beta' }), feed('1.1.0')])?.version).toBe('1.1.0')
    expect(pick([beta, stable], '1.0.3', ['1.2.0-beta.1'])?.version).toBe('1.1.0')
    expect(channelsToRead('beta')).toEqual(['beta', 'stable'])
    expect(channelsToRead('stable')).toEqual(['stable'])
  })

  it('needs an entry for this platform', () => {
    expect(selectUpdate({ feeds: [feed('1.1.0')], current: '1.0.3', failed: [], platform: 'win32-x64' })).toBeNull()
  })

  it('prefers a smaller delta from the running version', () => {
    const selection = pick([
      feed('1.1.0', {}, [
        { ...asset('d-old.zip', 50), from: '1.0.2' },
        { ...asset('d.zip', 200), from: '1.0.3' },
      ]),
    ])
    expect(selection?.download).toMatchObject({ kind: 'delta', from: '1.0.3', asset: { size: 200 } })
    expect(selection?.files.size).toBe(10)
  })

  it('ignores a delta that is not smaller than the full package or starts from another version', () => {
    expect(pick([feed('1.1.0', {}, [{ ...asset('d.zip', 1000), from: '1.0.3' }])])?.download.kind).toBe('full')
    expect(pick([feed('1.1.0', {}, [{ ...asset('d.zip', 10), from: '1.0.1' }])])?.download.kind).toBe('full')
  })
})

describe('minimumVersionOf / activeAnnouncements', () => {
  it('takes the strictest minimumVersion', () => {
    expect(minimumVersionOf([feed('1.1.0')])).toBeNull()
    expect(minimumVersionOf([feed('1.2.0-beta.1', { minimumVersion: '1.0.0' }), feed('1.1.0', { minimumVersion: '1.0.5' })])).toBe('1.0.5')
  })

  it('dedupes by id and hides dismissed and expired announcements', () => {
    const now = Date.parse('2026-11-05T00:00:00Z')
    const a = (id: string, until?: string) => ({ id, level: 'info' as const, title: id, body: '', until })
    const feeds = [
      feed('1.2.0-beta.1', { announcements: [a('shared'), a('old', '2026-11-01T00:00:00Z'), a('future', '2026-12-01T00:00:00Z')] }),
      feed('1.1.0', { announcements: [a('shared'), a('gone')] }),
    ]
    expect(activeAnnouncements(feeds, ['gone'], now).map((item) => item.id)).toEqual(['shared', 'future'])
  })
})
