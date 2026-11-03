import assert from 'node:assert/strict'
import test from 'node:test'
import { compareSemver, findInstaller, parseReleaseMarkdown, pickLatestVersion, releaseVersionCandidates } from '../apps/desktop/src/shared/release.ts'

test('manifest and GitHub release tags compare like semver', () => {
  assert.equal(compareSemver('v1.0.2', '1.0.1'), 1)
  assert.equal(compareSemver('1.0.1', 'v1.0.1'), 0)
  assert.equal(compareSemver('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1)
})

test('a drifted release tag does not hide the version that actually shipped', () => {
  // The real v1.0.1 release is tagged `v0.1.0`, titled "MossStudio 1.0.1 ..." and
  // ships MossStudio-1.0.1-win32-x64.zip: reading only the tag blinds every client.
  assert.deepEqual(
    releaseVersionCandidates({
      tag: 'v0.1.0',
      name: 'MossStudio 1.0.1 万象初绘：一念落纸上，万象入画来',
      assets: ['MossStudio-1.0.1-win32-x64.zip', 'release.md'],
      // Changelog lines mention older versions; only the title counts.
      body: '# MossStudio 1.0.1 — 万象初绘\n\n## 发布说明\n- 旧版本 0.9.9 的说明不要当成新版本',
    }),
    ['1.0.1', '0.1.0'],
  )
  // Prerelease markers survive; platform suffixes in asset names do not.
  assert.deepEqual(
    releaseVersionCandidates({ tag: 'v1.2.0-beta.1', name: 'MossStudio 1.2.0', assets: ['MossStudio-1.2.0-win32-x64.zip'], body: '' }),
    ['1.2.0', '1.2.0-beta.1'],
  )
  assert.deepEqual(
    releaseVersionCandidates({ tag: 'v1.2.0', name: 'MossStudio 1.2.0', assets: [], body: '' }),
    ['1.2.0'],
  )
  assert.deepEqual(releaseVersionCandidates({ tag: 'nightly', name: null, assets: null, body: null }), [])
})

test('a release published on GitHub wins even when the manifest lags', () => {
  assert.deepEqual(
    pickLatestVersion({ manifest: '1.0.1', github: '1.0.2', current: '1.0.1' }),
    { version: '1.0.2', updateAvailable: true, from: 'github' },
  )
  // A tag with the `v` prefix coming straight from the API must work too.
  assert.deepEqual(
    pickLatestVersion({ manifest: '1.0.1', github: 'v1.0.2', current: '1.0.1' }),
    { version: 'v1.0.2', updateAvailable: true, from: 'github' },
  )
})

test('a bumped manifest wins and needs no GitHub answer', () => {
  assert.deepEqual(
    pickLatestVersion({ manifest: '1.0.3', github: null, current: '1.0.1' }),
    { version: '1.0.3', updateAvailable: true, from: 'manifest' },
  )
  // GitHub cannot downgrade what the manifest already offers.
  assert.deepEqual(
    pickLatestVersion({ manifest: '1.0.3', github: '1.0.2', current: '1.0.1' }),
    { version: '1.0.3', updateAvailable: true, from: 'manifest' },
  )
})

test('no update when both sources are at or below the running version', () => {
  assert.deepEqual(
    pickLatestVersion({ manifest: '1.0.1', github: '1.0.1', current: '1.0.1' }),
    { version: '1.0.1', updateAvailable: false, from: 'none' },
  )
  assert.deepEqual(
    pickLatestVersion({ manifest: null, github: null, current: '1.0.1' }),
    { version: null, updateAvailable: false, from: 'none' },
  )
  // An older GitHub tag must not resurrect an update the manifest already dropped.
  assert.deepEqual(
    pickLatestVersion({ manifest: '1.0.0', github: '0.9.9', current: '1.0.0' }),
    { version: '1.0.0', updateAvailable: false, from: 'none' },
  )
})

function releaseDocument(kind) {
  const machine = {
    schema_version: 2,
    app: { name: 'MossStudio', channel: 'stable', version: '1.0.3', published_at: '2026-11-03T00:00:00Z' },
    installers: [
      {
        platform: 'win32',
        arch: 'x64',
        kind,
        url: 'https://example.com/MossStudio-Setup-1.0.3-x64.exe',
        sha256: 'a'.repeat(64),
        size_bytes: 1024,
      },
    ],
  }
  return `# MossStudio 1.0.3\n\n\`\`\`json clover-release\n${JSON.stringify(machine)}\n\`\`\`\n`
}

test('the self-extracting exe installer kind parses; unknown kinds are rejected', () => {
  assert.equal(parseReleaseMarkdown(releaseDocument('exe')).document.installers[0].kind, 'exe')
  assert.equal(parseReleaseMarkdown(releaseDocument('zip')).document.installers[0].kind, 'zip')
  assert.throws(() => parseReleaseMarkdown(releaseDocument('msi')))
})

test('the setup exe is preferred over the portable zip for the same platform', () => {
  const base = {
    platform: 'win32',
    arch: 'x64',
    url: 'https://example.com/a.exe',
    sha256: 'a'.repeat(64),
    size_bytes: 10,
  }
  const zip = { ...base, kind: 'zip', url: 'https://example.com/a.zip' }
  const exe = { ...base, kind: 'exe', url: 'https://example.com/setup.exe' }
  assert.equal(findInstaller([zip, exe], 'win32', 'x64')?.kind, 'exe')
  assert.equal(findInstaller([zip], 'win32', 'x64')?.kind, 'zip')
  assert.equal(findInstaller([exe], 'win32', 'arm64'), null)
})
