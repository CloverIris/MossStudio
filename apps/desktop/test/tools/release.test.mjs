// Unit tests for the pure parts of tools/release: file lists, zips (symlinks and modes),
// delta planning and packages, feed assembly, signing, and compatibility with the app's own
// updater code (extract, materialize, verify), which is what clients run on these files.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { deltaManifestSchema, feedSignatureSchema, fileListSchema, portableMarkerSchema, updateFeedSchema } from '@shared/install'
import { parseUpdateKeys } from '@shared/updateKeys'
import { extractZip } from '@main/update/zip'
import { materialize, verifyTree } from '@main/update/materialize'
import { parseVerifiedFeed, verifyFeedSignature } from '@main/update/verify'
import {
  fileListFromTree,
  normalizeMode,
  sha256Buffer,
  symlinkTargetIsSafe,
  walkTree,
  zipTree,
} from '../../../../tools/release/lib/tree.mjs'
import { ZipWriter } from '../../../../tools/release/lib/zip.mjs'
import { readZip } from '../../../../tools/release/lib/unzip.mjs'
import { deltaBases, deltaManifest, planDelta, writeDelta } from '../../../../tools/release/lib/delta.mjs'
import {
  assembleFeed,
  channelsFor,
  currentAnnouncements,
  describePlatforms,
  feedBytes,
  parseNotes,
} from '../../../../tools/release/lib/feed.mjs'
import { generateKeyPair, keyIdFor, parsePrivateKey, publicKeyBase64, signFeed, verifyFeed } from '../../../../tools/release/lib/sign.mjs'
import {
  artifactNames,
  bumpPatch,
  compareVersions,
  deltaName,
  isPrerelease,
  parseDeltaName,
  portableMarker,
  releaseAssetUrl,
} from '../../../../tools/release/lib/version.mjs'
import { asarPackageJson, readSetupTar, readTar, TRAILER_SIZE } from '../../../../tools/release/lib/inspect.mjs'
import {
  checkDelta,
  checkFeed,
  checkFileList,
  checkFullZip,
  checkPortable,
  checkSetupFile,
  compareWithFileList,
  verifiedPublishedFeed,
} from '../../../../tools/release/lib/verify.mjs'
import { makeAppTree, makeMacBundle, useTemp } from './releaseFixtures.mjs'

const temp = useTemp()

function buildVersion(root, version, variant, platform = 'linux-x64') {
  const app = join(root, `app-${version}`)
  makeAppTree(app, version, variant)
  const tree = walkTree(app)
  const list = fileListFromTree(tree, { version, platform })
  const full = join(root, `full-${version}.zip`)
  zipTree(tree, full, { platform, mtime: new Date(2026, 0, 1) })
  const filesJson = Buffer.from(`${JSON.stringify(list, null, 2)}\n`)
  writeFileSync(join(root, `files-${version}.json`), filesJson)
  return { app, tree, list, full, filesJson }
}

describe('versions and names', () => {
  it('orders semver with prereleases below their release', () => {
    const sorted = ['1.0.0', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-alpha', '0.9.9', '1.0.1-rc.1', '1.0.1'].sort(compareVersions)
    expect(sorted).toEqual(['0.9.9', '1.0.0-alpha', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0', '1.0.1-rc.1', '1.0.1'])
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(isPrerelease('2.0.0-beta.1')).toBe(true)
    expect(bumpPatch('1.0.3', 2)).toBe('1.0.5')
  })

  it('names every artifact per platform and round-trips delta names', () => {
    expect(artifactNames('1.2.3', 'win32-x64')).toEqual({
      full: 'MossStudio-1.2.3-win32-x64-full.zip',
      files: 'files-1.2.3-win32-x64.json',
      setup: 'MossStudio-Setup-1.2.3-x64.exe',
      portable: 'MossStudio-1.2.3-win-x64-portable.zip',
    })
    expect(artifactNames('1.2.3', 'linux-x64').setup).toBe('MossStudio-Setup-1.2.3-linux-x64.run')
    expect(artifactNames('1.2.3', 'linux-x64').portable).toBe('MossStudio-1.2.3-linux-x64-portable.tar.gz')
    expect(artifactNames('1.2.3', 'darwin-arm64').setup).toBe('MossStudio-1.2.3-mac-arm64.dmg')
    expect(artifactNames('1.2.3', 'darwin-x64').portable).toBe('MossStudio-1.2.3-mac-x64-portable.zip')
    expect(parseDeltaName(deltaName('1.0.0-beta.1', '1.0.0', 'darwin-arm64'))).toEqual({
      from: '1.0.0-beta.1',
      to: '1.0.0',
      platform: 'darwin-arm64',
    })
    expect(parseDeltaName('MossStudio-1.0.0-win32-x64-full.zip')).toBeNull()
    expect(releaseAssetUrl('1.2.3', 'a b.zip')).toBe('https://github.com/CloverIris/MossStudio/releases/download/v1.2.3/a%20b.zip')
    expect(() => artifactNames('1.2.3', 'linux-arm64')).toThrow(/unknown platform/)
  })

  it('writes a portable marker the contract accepts', () => {
    expect(portableMarkerSchema.parse(JSON.parse(portableMarker('1.2.3')))).toEqual({ schema: 1, version: '1.2.3' })
  })
})

describe('file lists', () => {
  it('lists files with sha256, size and mode, and symlinks with targets, sorted, without folders', () => {
    const { list, app } = buildVersion(temp(), '1.0.0', 0)
    expect(fileListSchema.parse(list)).toEqual(list)
    const paths = list.entries.map((entry) => entry.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).not.toContain('resources')
    expect(list.entries.find((entry) => entry.path === 'MossStudio')).toMatchObject({ type: 'file', mode: 0o755 })
    expect(list.entries.find((entry) => entry.path === 'resources/models.json')).toMatchObject({ type: 'file', mode: 0o644, size: 13 })
    expect(list.entries.find((entry) => entry.path === 'resources/内容 文件.txt')).toMatchObject({
      sha256: sha256Buffer(readFileSync(join(app, 'resources/内容 文件.txt'))),
    })
    expect(list.entries.find((entry) => entry.path === 'lib/libffmpeg.so')).toEqual({
      path: 'lib/libffmpeg.so',
      type: 'symlink',
      target: '../libffmpeg.so',
    })
    checkFileList(list, { version: '1.0.0', platform: 'linux-x64' })
  })

  it('records 0o644 for every Windows file whatever the host says', () => {
    expect(normalizeMode('win32-x64', 0o100755)).toBe(0o644)
    expect(normalizeMode('linux-x64', 0o100755)).toBe(0o755)
    expect(normalizeMode('darwin-arm64', 0o120777)).toBe(0o777)
  })

  it('refuses symlinks that leave the package', () => {
    expect(symlinkTargetIsSafe('a/b', '../c')).toBe(true)
    expect(symlinkTargetIsSafe('a/b', '../../c')).toBe(false)
    expect(symlinkTargetIsSafe('a', '/etc/passwd')).toBe(false)
    expect(symlinkTargetIsSafe('a', 'C:/x')).toBe(false)
    expect(() =>
      fileListFromTree([{ path: 'x', type: 'symlink', target: '../../x', mode: 0o120777 }], { version: '1.0.0', platform: 'linux-x64' }),
    ).toThrow(/escapes/)
  })
})

describe('zip writer', () => {
  it('keeps modes, symlinks, folders and UTF-8 names, readable by yauzl and unzip', () => {
    const root = temp()
    const { full } = buildVersion(root, '1.0.0', 0)
    const entries = readZip(full)
    return entries.then((zip) => {
      expect(zip.get('MossStudio')).toMatchObject({ kind: 'file', mode: 0o755 })
      expect(zip.get('resources/models.json')).toMatchObject({ kind: 'file', mode: 0o644 })
      expect(zip.get('resources/')).toMatchObject({ kind: 'directory' })
      expect(zip.get('lib/libffmpeg.so').kind).toBe('symlink')
      expect(zip.get('lib/libffmpeg.so').data.toString()).toBe('../libffmpeg.so')
      expect(zip.get('resources/内容 文件.txt').data.toString()).toBe('中文 content with space')
      const unzip = spawnSync('unzip', ['-tq', full], { encoding: 'utf8' })
      if (!unzip.error) expect(unzip.status, unzip.stdout + unzip.stderr).toBe(0)
    })
  })

  it('rejects unsafe and duplicate names', () => {
    const zip = new ZipWriter(join(temp(), 'x.zip'))
    expect(() => zip.addFile('../x', Buffer.from('x'))).toThrow(/invalid/)
    expect(() => zip.addFile('/x', Buffer.from('x'))).toThrow(/invalid/)
    expect(() => zip.addFile('a\\b', Buffer.from('x'))).toThrow(/invalid/)
    zip.addFile('a', Buffer.from('x'))
    expect(() => zip.addFile('a', Buffer.from('y'))).toThrow(/duplicate/)
    zip.close()
  })

  it('is extracted by the app updater with symlinks and modes intact', async () => {
    const root = temp()
    const { full, list } = buildVersion(root, '1.0.0', 0)
    const dest = join(root, 'out')
    mkdirSync(dest)
    await extractZip(full, dest)
    expect(lstatSync(join(dest, 'lib/libffmpeg.so')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(dest, 'lib/libffmpeg.so'))).toBe('../libffmpeg.so')
    expect(statSync(join(dest, 'MossStudio')).mode & 0o777).toBe(0o755)
    await verifyTree(dest, list)
  })

  it('round-trips a macOS bundle with framework symlinks', async () => {
    const root = temp()
    const parent = join(root, 'src')
    const bundle = makeMacBundle(parent, '2.0.0')
    const tree = walkTree(bundle)
    const list = fileListFromTree(tree, { version: '2.0.0', platform: 'darwin-arm64' })
    const full = join(root, 'mac-full.zip')
    zipTree(tree, full, { platform: 'darwin-arm64' })
    expect(list.entries.find((entry) => entry.path === 'Contents/Frameworks/Electron Framework.framework/Versions/Current')).toEqual({
      path: 'Contents/Frameworks/Electron Framework.framework/Versions/Current',
      type: 'symlink',
      target: 'A',
    })
    await checkFullZip(full, list)
    // As the updater does: the zip's entries are the bundle's contents.
    const finalDir = join(root, 'Applications 应用', '.MossStudio-2.0.0.app')
    await materialize({ kind: 'full', zipPath: full, fileList: list, partialDir: `${finalDir}.partial`, finalDir, platform: 'darwin' })
    await verifyTree(finalDir, list, { platform: 'darwin' })
    expect(readFileSync(join(finalDir, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'), 'utf8')).toBe('framework')

    // Portable: MossStudio/ with MossStudio.app, portable.json and data/.
    const stage = join(root, 'stage', 'MossStudio')
    makeMacBundle(stage, '2.0.0')
    mkdirSync(join(stage, 'data'))
    writeFileSync(join(stage, 'portable.json'), portableMarker('2.0.0'))
    const portable = join(root, 'mac-portable.zip')
    zipTree(walkTree(join(root, 'stage')), portable, { platform: 'darwin-arm64' })
    await checkPortable(portable, list)
  })
})

describe('deltas', () => {
  it('plans changed, new, mode-changed and retargeted entries, and removals', () => {
    const root = temp()
    const a = buildVersion(root, '1.0.0', 0)
    const b = buildVersion(root, '1.0.1', 1)
    const plan = planDelta(a.list, b.list)
    expect(plan.changed.sort()).toEqual([
      'chrome_crashpad_handler',
      'locales/current',
      'new-only.dat',
      'resources/app.asar',
      'resources/models.json',
    ])
    expect(plan.removed).toEqual(['old-only.dat'])
    expect(plan.unchangedBytes).toBeGreaterThan(64 * 1024)
    expect(() => planDelta(a.list, { ...b.list, platform: 'win32-x64' })).toThrow(/across platforms/)
  })

  it('builds a delta the app updater materializes into exactly the new version', async () => {
    const root = temp()
    const a = buildVersion(root, '1.0.0', 0)
    const b = buildVersion(root, '1.0.1', 1)
    const deltaPath = join(root, deltaName('1.0.0', '1.0.1', 'linux-x64'))
    const manifest = await writeDelta({ from: a.list, to: b.list, filesJson: b.filesJson, fullZip: b.full, outPath: deltaPath })
    expect(deltaManifestSchema.parse(manifest)).toEqual(manifest)
    expect(manifest).toMatchObject({
      from: '1.0.0',
      to: '1.0.1',
      platform: 'linux-x64',
      files: { sha256: sha256Buffer(b.filesJson), size: b.filesJson.length },
    })
    const zip = await readZip(deltaPath)
    expect([...zip.keys()].filter((name) => !name.endsWith('/')).sort()).toEqual(
      ['delta.json', ...manifest.changed.map((p) => `files/${p}`)].sort(),
    )
    expect(zip.get('files/locales/current').kind).toBe('symlink')
    await checkDelta(deltaPath, { toList: b.list, toListBytes: b.filesJson, fromList: a.list, deltaManifestSchema })

    const finalDir = join(root, 'installed', 'app-1.0.1')
    await materialize({
      kind: 'delta',
      zipPath: deltaPath,
      fileList: b.list,
      partialDir: `${finalDir}.partial`,
      finalDir,
      baseDir: a.app,
      baseVersion: '1.0.0',
      filesSha256: sha256Buffer(b.filesJson),
    })
    await verifyTree(finalDir, b.list)
    expect(existsSync(join(finalDir, 'old-only.dat'))).toBe(false)
    expect(statSync(join(finalDir, 'chrome_crashpad_handler')).mode & 0o777).toBe(0o755)

    const fullDir = join(root, 'installed-full', 'app-1.0.1')
    await materialize({ kind: 'full', zipPath: b.full, fileList: b.list, partialDir: `${fullDir}.partial`, finalDir: fullDir })
    await verifyTree(fullDir, b.list)
  })

  it('refuses a full zip that disagrees with its file list', async () => {
    const root = temp()
    const a = buildVersion(root, '1.0.0', 0)
    const b = buildVersion(root, '1.0.1', 1)
    const tampered = {
      ...b.list,
      entries: b.list.entries.map((entry) => (entry.path === 'new-only.dat' ? { ...entry, sha256: '0'.repeat(64) } : entry)),
    }
    await expect(
      writeDelta({ from: a.list, to: tampered, filesJson: b.filesJson, fullZip: b.full, outPath: join(root, 'd.zip') }),
    ).rejects.toThrow(/disagrees/)
    await expect(checkFullZip(b.full, tampered)).rejects.toThrow(/content differs/)
    expect(() => compareWithFileList('x', [], b.list)).toThrow(/missing/)
  })

  it('hashes the exact target file list bytes into the manifest', () => {
    const root = temp()
    const a = buildVersion(root, '1.0.0', 0)
    const b = buildVersion(root, '1.0.1', 1)
    expect(deltaManifest({ from: a.list, to: b.list, filesJson: Buffer.from('x') }).files).toEqual({
      sha256: sha256Buffer(Buffer.from('x')),
      size: 1,
    })
  })

  it('picks the two newest earlier stable releases (and the newest earlier beta for a beta)', () => {
    const available = ['1.0.0', '1.0.1', '1.0.2', '1.1.0-beta.1', '1.1.0-beta.2', '1.1.0', '1.2.0']
    const opts = { compare: compareVersions, isPrerelease }
    expect(deltaBases('1.1.1', available, opts)).toEqual(['1.1.0', '1.0.2'])
    expect(deltaBases('1.1.0', available, opts)).toEqual(['1.0.2', '1.0.1'])
    expect(deltaBases('1.1.0-beta.3', available, opts)).toEqual(['1.1.0-beta.2', '1.0.2', '1.0.1'])
    expect(deltaBases('1.0.0', available, opts)).toEqual([])
  })
})

describe('feeds and signatures', () => {
  function artifactsDir(root) {
    const dir = join(root, 'artifacts')
    mkdirSync(dir)
    const names = artifactNames('1.0.1', 'linux-x64')
    for (const [kind, name] of Object.entries(names)) writeFileSync(join(dir, name), `${kind} bytes`)
    writeFileSync(join(dir, deltaName('1.0.0', '1.0.1', 'linux-x64')), 'delta 1.0.0')
    writeFileSync(join(dir, deltaName('0.9.0', '1.0.1', 'linux-x64')), 'delta 0.9.0')
    writeFileSync(join(dir, deltaName('1.0.0', '1.0.1', 'win32-x64')), 'delta for a platform without full package')
    return dir
  }

  it('routes prereleases to beta and stable releases to both, never replacing a newer or equal feed', () => {
    expect(channelsFor('1.1.0-beta.1')).toEqual({ channels: ['beta'], skipped: [] })
    expect(channelsFor('1.0.1')).toEqual({ channels: ['stable', 'beta'], skipped: [] })
    expect(channelsFor('1.0.1', { currentStable: '1.0.0', currentBeta: '1.1.0-beta.1' })).toEqual({
      channels: ['stable'],
      skipped: [{ channel: 'beta', current: '1.1.0-beta.1' }],
    })
    expect(channelsFor('1.1.0', { currentStable: '1.0.9', currentBeta: '1.1.0-beta.1' }).channels).toEqual(['stable', 'beta'])
    // Backport: v1.0.9 tagged after v1.1.0 must not send stable (or beta) clients backwards.
    expect(channelsFor('1.0.9', { currentStable: '1.1.0', currentBeta: '1.1.0' })).toEqual({
      channels: [],
      skipped: [
        { channel: 'stable', current: '1.1.0' },
        { channel: 'beta', current: '1.1.0' },
      ],
    })
    // Re-running a release whose feeds already went out changes nothing.
    expect(channelsFor('1.1.0', { currentStable: '1.1.0' })).toEqual({
      channels: ['beta'],
      skipped: [{ channel: 'stable', current: '1.1.0' }],
    })
    expect(channelsFor('1.2.0-beta.1', { currentStable: '1.3.0', currentBeta: '1.2.0-beta.2' })).toEqual({
      channels: [],
      skipped: [{ channel: 'beta', current: '1.2.0-beta.2' }],
    })
  })

  it('trusts a published feed only when it is signed by a production key and is the channel it claims', () => {
    const pair = generateKeyPair()
    const key = parsePrivateKey(pair.privateKeyBase64)
    const trusted = [{ id: pair.id, publicKey: pair.publicKey }]
    const opts = { channel: 'stable', trusted, updateFeedSchema, feedSignatureSchema }
    const feed = assembleFeed({
      channel: 'stable',
      version: '1.1.0',
      publishedAt: 'x',
      platforms: {
        'linux-x64': {
          full: { url: 'https://github.com/a', sha256: 'a'.repeat(64), size: 1 },
          files: { url: 'https://github.com/b', sha256: 'b'.repeat(64), size: 1 },
          deltas: [],
        },
      },
    })
    const bytes = feedBytes(feed)
    const sig = Buffer.from(JSON.stringify(signFeed(bytes, key)))
    expect(verifiedPublishedFeed(bytes, sig, opts).version).toBe('1.1.0')
    expect(() => verifiedPublishedFeed(bytes, null, opts)).toThrow(/no .sig/)
    expect(() => verifiedPublishedFeed(Buffer.from(bytes.toString().replace('1.1.0', '9.9.9')), sig, opts)).toThrow(/does not verify/)
    expect(() => verifiedPublishedFeed(bytes, sig, { ...opts, channel: 'beta' })).toThrow(/says channel stable/)
    expect(() =>
      verifiedPublishedFeed(bytes, sig, { ...opts, trusted: [{ id: pair.id, publicKey: generateKeyPair().publicKey }] }),
    ).toThrow(/does not verify/)
  })

  it('reads notes with optional front matter', () => {
    expect(parseNotes('---\nminimumVersion: 1.0.0\n---\n## 新功能\n\n- A\n')).toEqual({
      meta: { minimumVersion: '1.0.0' },
      body: '## 新功能\n\n- A',
    })
    expect(parseNotes('plain\r\n')).toEqual({ meta: {}, body: 'plain' })
    expect(() => parseNotes('---\nfoo: 1\n---\n')).toThrow(/unknown key/)
    expect(() => parseNotes('---\nminimumVersion: soon\n---\n')).toThrow(/not a version/)
  })

  it('drops expired announcements', () => {
    const now = new Date('2026-06-01T00:00:00Z')
    expect(
      currentAnnouncements([{ id: 'a', until: '2026-01-01T00:00:00Z' }, { id: 'b', until: '2027-01-01T00:00:00Z' }, { id: 'c' }], now).map(
        (a) => a.id,
      ),
    ).toEqual(['b', 'c'])
  })

  it('assembles a feed the app accepts, with hashes, sizes and deltas newest first', () => {
    const dir = artifactsDir(temp())
    const urlFor = (file) => releaseAssetUrl('1.0.1', file)
    const platforms = describePlatforms(dir, '1.0.1', urlFor)
    expect(Object.keys(platforms)).toEqual(['linux-x64'])
    const linux = platforms['linux-x64']
    expect(linux.full).toEqual({
      url: urlFor('MossStudio-1.0.1-linux-x64-full.zip'),
      sha256: sha256Buffer(Buffer.from('full bytes')),
      size: 10,
    })
    expect(linux.deltas.map((delta) => delta.from)).toEqual(['1.0.0', '0.9.0'])
    expect(linux.setup.url).toBe(urlFor('MossStudio-Setup-1.0.1-linux-x64.run'))
    const feed = assembleFeed({
      channel: 'stable',
      version: '1.0.1',
      publishedAt: '2026-11-05T00:00:00.000Z',
      notes: 'notes',
      minimumVersion: '1.0.0',
      platforms,
    })
    expect(updateFeedSchema.parse(JSON.parse(feedBytes(feed).toString()))).toMatchObject({
      version: '1.0.1',
      minimumVersion: '1.0.0',
      channel: 'stable',
    })
    expect(() => assembleFeed({ channel: 'stable', version: '1.0.1', publishedAt: 'x', platforms: {} })).toThrow(/no platform/)
    expect(() => assembleFeed({ channel: 'stable', version: '1.0.1', publishedAt: 'x', platforms, minimumVersion: '2.0.0' })).toThrow(
      /above/,
    )
  })

  it('signs with a base64 seed or a PEM key and the app verifies it', () => {
    const pair = generateKeyPair()
    const bytes = Buffer.from('{"schema":1}\n')
    for (const source of [pair.privateKeyBase64, pair.privateKeyPem, `  ${pair.privateKeyBase64}\n`]) {
      const key = parsePrivateKey(source)
      expect(publicKeyBase64(key)).toBe(pair.publicKey)
      const sig = signFeed(bytes, key)
      expect(feedSignatureSchema.parse(sig)).toEqual(sig)
      expect(sig.keyId).toBe(pair.id)
      const trusted = parseUpdateKeys([{ id: pair.id, publicKey: pair.publicKey }])
      expect(verifyFeed(bytes, sig, trusted)).toBe(true)
      expect(verifyFeedSignature(bytes, Buffer.from(JSON.stringify(sig)), trusted)).toBe(pair.id)
      expect(verifyFeed(Buffer.from('{"schema":2}\n'), sig, trusted)).toBe(false)
      expect(() => verifyFeedSignature(Buffer.from('tampered'), Buffer.from(JSON.stringify(sig)), trusted)).toThrow()
    }
    expect(keyIdFor(pair.publicKey)).toMatch(/^ed25519-[0-9a-f]{16}$/)
    expect(() => parsePrivateKey('')).toThrow(/empty/)
    expect(() => parsePrivateKey(Buffer.alloc(16).toString('base64'))).toThrow(/32/)
  })

  it('verifies a signed feed against the artifacts and rejects other keys or changed files', () => {
    const dir = artifactsDir(temp())
    const pair = generateKeyPair()
    const feed = assembleFeed({
      channel: 'beta',
      version: '1.0.1',
      publishedAt: 'now',
      platforms: describePlatforms(dir, '1.0.1', (file) => releaseAssetUrl('1.0.1', file)),
    })
    const path = join(dir, 'update-beta.json')
    writeFileSync(path, feedBytes(feed))
    writeFileSync(`${path}.sig`, JSON.stringify(signFeed(feedBytes(feed), parsePrivateKey(pair.privateKeyBase64))))
    const trusted = [{ id: pair.id, publicKey: pair.publicKey }]
    const opts = { dir, trusted, updateFeedSchema, feedSignatureSchema, expectVersion: '1.0.1', urlPrefix: releaseAssetUrl('1.0.1', '') }
    expect(checkFeed(path, opts).version).toBe('1.0.1')
    expect(parseVerifiedFeed(readFileSync(path), readFileSync(`${path}.sig`), trusted, 'beta').version).toBe('1.0.1')
    const other = generateKeyPair()
    expect(() => checkFeed(path, { ...opts, trusted: [{ id: pair.id, publicKey: other.publicKey }] })).toThrow(/does not verify/)
    expect(() => checkFeed(path, { ...opts, urlPrefix: 'http://127.0.0.1/' })).toThrow(/not under/)
    writeFileSync(join(dir, artifactNames('1.0.1', 'linux-x64').full), 'changed')
    expect(() => checkFeed(path, opts)).toThrow(/does not match/)
  })
})

describe('setup files and portable packages', () => {
  function tarOf(dir, entries) {
    const tar = spawnSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-cf', '-', '-C', dir, ...entries], { maxBuffer: 1 << 28 })
    expect(tar.status, String(tar.stderr)).toBe(0)
    return tar.stdout
  }

  it('reads a stub + gzip(tar) + trailer setup file and checks it against the file list', () => {
    const root = temp()
    const { list } = buildVersion(root, '1.0.0', 0)
    writeFileSync(join(root, 'mossstudio'), '\x7fELF launcher')
    const payload = gzipSync(tarOf(root, ['app-1.0.0', 'mossstudio']))
    const stub = Buffer.from('\x7fELF launcher', 'latin1')
    const trailer = Buffer.alloc(TRAILER_SIZE)
    trailer.writeBigUInt64LE(BigInt(stub.length), 0)
    trailer.writeBigUInt64LE(BigInt(payload.length), 8)
    Buffer.from(sha256Buffer(payload), 'hex').copy(trailer, 16)
    trailer.writeUInt32LE(1, 48)
    trailer.write('MossPay1', 56, 'latin1')
    const setup = join(root, 'MossStudio-Setup-1.0.0-linux-x64.run')
    writeFileSync(setup, Buffer.concat([stub, payload, trailer]))
    expect(readSetupTar(setup).entries.some((entry) => entry.name === 'app-1.0.0/lib/libffmpeg.so' && entry.type === 'symlink')).toBe(true)
    checkSetupFile(setup, list)

    const broken = Buffer.concat([stub, payload, trailer])
    broken[stub.length + 20] ^= 0xff
    writeFileSync(setup, broken)
    expect(() => checkSetupFile(setup, list)).toThrow(/checksum/)
  })

  it('reads long PAX names from tar', () => {
    const root = temp()
    const deep = join(root, 'p', 'x'.repeat(90), 'y'.repeat(90))
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, '长文件名.txt'), 'deep')
    const gnu = readTar(tarOf(root, ['p']))
    expect(gnu.find((entry) => entry.name.endsWith('长文件名.txt'))).toMatchObject({
      type: 'file',
      name: `p/${'x'.repeat(90)}/${'y'.repeat(90)}/长文件名.txt`,
    })
    const entries = readTar(tarOf(root, ['--format=pax', 'p']))
    expect(entries.find((entry) => entry.name.endsWith('长文件名.txt'))).toMatchObject({
      type: 'file',
      name: `p/${'x'.repeat(90)}/${'y'.repeat(90)}/长文件名.txt`,
    })
  })

  it('checks the portable layout: launcher, app, portable.json and an empty data folder', async () => {
    const root = temp()
    const { list } = buildVersion(join(root, 'stage', 'MossStudio'), '1.0.0', 0)
    mkdirSync(join(root, 'stage', 'MossStudio', 'data'))
    writeFileSync(join(root, 'stage', 'MossStudio', 'portable.json'), portableMarker('1.0.0'))
    writeFileSync(join(root, 'stage', 'MossStudio', 'mossstudio'), 'launcher', { mode: 0o755 })
    // buildVersion also wrote its zip and list next to app-1.0.0; keep only the R layout.
    const stage = join(root, 'stage')
    const keep = walkTree(stage).filter((item) => !/MossStudio\/(full-|files-)/.test(item.path))
    const zipPath = join(root, 'portable.zip')
    zipTree(keep, zipPath, { platform: 'linux-x64' })
    await checkPortable(zipPath, list)
    const tgz = join(root, 'portable.tar.gz')
    const tar = spawnSync('tar', ['--exclude=MossStudio/full-*', '--exclude=MossStudio/files-*', '-czf', tgz, '-C', stage, 'MossStudio'])
    expect(tar.status, String(tar.stderr)).toBe(0)
    await checkPortable(tgz, list)
    writeFileSync(join(stage, 'MossStudio', 'portable.json'), portableMarker('9.9.9'))
    const bad = join(root, 'bad.zip')
    zipTree(
      walkTree(stage).filter((item) => !/MossStudio\/(full-|files-)/.test(item.path)),
      bad,
      { platform: 'linux-x64' },
    )
    await expect(checkPortable(bad, list)).rejects.toThrow(/portable.json/)
  })

  it('reads the app version from an asar file', () => {
    const root = temp()
    const { app } = buildVersion(root, '3.2.1', 0)
    expect(asarPackageJson(join(app, 'resources', 'app.asar')).version).toBe('3.2.1')
  })
})

describe('integration test server', () => {
  it('serves artifacts with ranges and switches feeds', async () => {
    const { startUpdateServer } = await import('../../../../tools/release/integration/server.mjs')
    const root = temp()
    mkdirSync(join(root, 'files'))
    mkdirSync(join(root, 'feed-a'))
    mkdirSync(join(root, 'feed-b'))
    writeFileSync(join(root, 'files', 'pkg 1.zip'), '0123456789')
    writeFileSync(join(root, 'feed-a', 'update-stable.json'), '{"v":"a"}')
    writeFileSync(join(root, 'feed-b', 'update-stable.json'), '{"v":"b"}')
    const server = await startUpdateServer({ filesDir: join(root, 'files'), feedDir: join(root, 'feed-a'), port: 0 })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const full = await fetch(`${base}/files/pkg%201.zip`)
      expect(await full.text()).toBe('0123456789')
      const part = await fetch(`${base}/files/pkg%201.zip`, { headers: { Range: 'bytes=4-' } })
      expect(part.status).toBe(206)
      expect(part.headers.get('content-range')).toBe('bytes 4-9/10')
      expect(await part.text()).toBe('456789')
      expect((await fetch(`${base}/files/pkg%201.zip`, { headers: { Range: 'bytes=20-' } })).status).toBe(416)
      expect((await fetch(`${base}/files/..%2Fsecret`)).status).toBe(404)
      expect(await (await fetch(`${base}/feed/update-stable.json`)).text()).toBe('{"v":"a"}')
      server.setFeedDir(join(root, 'feed-b'))
      expect(await (await fetch(`${base}/feed/update-stable.json`)).text()).toBe('{"v":"b"}')
      expect(server.requests.some((request) => request.range === 'bytes=4-')).toBe(true)
    } finally {
      await server.close()
    }
  })
})
