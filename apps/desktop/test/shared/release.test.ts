import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  findInstaller,
  parseReleaseMarkdown,
  pickLatestVersion,
  RELEASE_MARKER,
  RELEASE_SCHEMA_VERSION,
  type ReleaseInstaller,
  releaseInstallerSchema,
  releaseVersionCandidates,
} from '@shared/release'

const SHA = 'a'.repeat(64)

const installer = (overrides: Partial<ReleaseInstaller> = {}): ReleaseInstaller => ({
  platform: 'win32',
  arch: 'x64',
  kind: 'exe',
  url: 'https://example.com/setup.exe',
  sha256: SHA,
  size_bytes: 10,
  ...overrides,
})

function machineBlock(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    app: { name: 'MossStudio', channel: 'stable', version: '1.0.3', published_at: '2026-11-03T00:00:00Z' },
    ...overrides,
  }
}

const markdown = (machine: unknown, { before = '# MossStudio 1.0.3\n\n', after = '\n', info = '' } = {}) =>
  `${before}\`\`\`json ${RELEASE_MARKER}${info}\n${typeof machine === 'string' ? machine : JSON.stringify(machine)}\n\`\`\`${after}`

function releaseDocument(kind: string) {
  return markdown(
    machineBlock({
      installers: [{ ...installer(), kind, url: 'https://example.com/MossStudio-Setup-1.0.3-x64.exe', size_bytes: 1024 }],
    }),
  )
}

describe('compareSemver', () => {
  it('compares manifest and GitHub tags like semver', () => {
    expect(compareSemver('v1.0.2', '1.0.1')).toBe(1)
    expect(compareSemver('1.0.1', 'v1.0.1')).toBe(0)
    expect(compareSemver('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1)
  })

  it('returns exactly 1, 0 or -1', () => {
    expect(compareSemver('10.0.0', '1.0.0')).toBe(1)
    expect(compareSemver('1.0.0', '10.0.0')).toBe(-1)
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0)
  })

  it('treats missing core parts as zero and ignores build metadata', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0)
    expect(compareSemver('1', '1.0.1')).toBe(-1)
    expect(compareSemver('1.0.0.1', '1.0.0')).toBe(1)
    expect(compareSemver('1.0.0+build.5', '1.0.0+build.9')).toBe(0)
    expect(compareSemver('V1.0.0', 'v1.0.0')).toBe(0)
    expect(compareSemver(' 1.0.0 ', '1.0.0')).toBe(0)
  })

  it('follows semver prerelease precedence', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expect(compareSemver(ordered[index]!, ordered[index + 1]!)).toBe(-1)
      expect(compareSemver(ordered[index + 1]!, ordered[index]!)).toBe(1)
    }
    expect(compareSemver('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0)
  })

  it('lets a higher core beat any prerelease', () => {
    expect(compareSemver('1.0.1-alpha', '1.0.0')).toBe(1)
  })

  it('falls back to string comparison for unparseable versions', () => {
    expect(compareSemver('nightly', 'nightly')).toBe(0)
    expect(compareSemver('abc', 'abd')).toBeLessThan(0)
    expect(compareSemver('1.x.0', '1.x.0')).toBe(0)
    expect(compareSemver('1.-1.0', '1.0.0')).not.toBe(0)
  })
})

describe('releaseVersionCandidates', () => {
  it('does not let a drifted tag hide the version that shipped', () => {
    // The real v1.0.1 release is tagged `v0.1.0`, titled "MossStudio 1.0.1 ..." and
    // ships MossStudio-1.0.1-win32-x64.zip: reading only the tag blinds every client.
    expect(
      releaseVersionCandidates({
        tag: 'v0.1.0',
        name: 'MossStudio 1.0.1 万象初绘：一念落纸上，万象入画来',
        assets: ['MossStudio-1.0.1-win32-x64.zip', 'release.md'],
        // Changelog lines mention older versions; only the title counts.
        body: '# MossStudio 1.0.1 — 万象初绘\n\n## 发布说明\n- 旧版本 0.9.9 的说明不要当成新版本',
      }),
    ).toEqual(['1.0.1', '0.1.0'])
  })

  it('keeps prerelease markers but not platform suffixes', () => {
    expect(
      releaseVersionCandidates({ tag: 'v1.2.0-beta.1', name: 'MossStudio 1.2.0', assets: ['MossStudio-1.2.0-win32-x64.zip'], body: '' }),
    ).toEqual(['1.2.0', '1.2.0-beta.1'])
    expect(releaseVersionCandidates({ tag: 'v1.2.0', name: 'MossStudio 1.2.0', assets: [], body: '' })).toEqual(['1.2.0'])
  })

  it('recognises each known prerelease keyword, case-insensitively', () => {
    expect(releaseVersionCandidates({ tag: '2.0.0-RC1' })).toEqual(['2.0.0-RC1'])
    expect(releaseVersionCandidates({ tag: '2.0.0-alpha' })).toEqual(['2.0.0-alpha'])
    expect(releaseVersionCandidates({ tag: '2.0.0-pre.3' })).toEqual(['2.0.0-pre.3'])
    expect(releaseVersionCandidates({ tag: '2.0.0-dev' })).toEqual(['2.0.0-dev'])
    expect(releaseVersionCandidates({ tag: '2.0.0-next.1' })).toEqual(['2.0.0-next.1'])
    expect(releaseVersionCandidates({ tag: '2.0.0-nightly' })).toEqual(['2.0.0'])
  })

  it('returns nothing when no source carries a version', () => {
    expect(releaseVersionCandidates({ tag: 'nightly', name: null, assets: null, body: null })).toEqual([])
    expect(releaseVersionCandidates({})).toEqual([])
    expect(releaseVersionCandidates({ tag: 'v1.2', name: 'build 7' })).toEqual([])
  })

  it('reads only the first heading of the body', () => {
    expect(releaseVersionCandidates({ body: 'intro 9.9.9\n# Title 1.4.0\n# Older 1.3.0' })).toEqual(['1.4.0'])
    expect(releaseVersionCandidates({ body: '   # Indented 1.5.0' })).toEqual(['1.5.0'])
    expect(releaseVersionCandidates({ body: 'no heading 2.0.0' })).toEqual([])
  })

  it('dedupes and sorts newest first across every source', () => {
    expect(
      releaseVersionCandidates({
        tag: 'v1.0.0',
        name: '1.0.0 and 1.1.0 (after 1.1.0-rc.1)',
        assets: ['a-1.1.0.zip', 'b-0.9.0.zip'],
      }),
    ).toEqual(['1.1.0', '1.1.0-rc.1', '1.0.0', '0.9.0'])
  })
})

describe('pickLatestVersion', () => {
  it('lets a GitHub release win when the manifest lags', () => {
    expect(pickLatestVersion({ manifest: '1.0.1', github: '1.0.2', current: '1.0.1' })).toEqual({
      version: '1.0.2',
      updateAvailable: true,
      from: 'github',
    })
    // A tag with the `v` prefix straight from the API must work too.
    expect(pickLatestVersion({ manifest: '1.0.1', github: 'v1.0.2', current: '1.0.1' })).toEqual({
      version: 'v1.0.2',
      updateAvailable: true,
      from: 'github',
    })
  })

  it('uses GitHub alone when there is no manifest version', () => {
    expect(pickLatestVersion({ manifest: null, github: '1.0.2', current: '1.0.1' })).toEqual({
      version: '1.0.2',
      updateAvailable: true,
      from: 'github',
    })
    expect(pickLatestVersion({ manifest: null, github: '1.0.1', current: '1.0.1' })).toEqual({
      version: '1.0.1',
      updateAvailable: false,
      from: 'none',
    })
  })

  it('lets a bumped manifest win without a GitHub answer', () => {
    expect(pickLatestVersion({ manifest: '1.0.3', github: null, current: '1.0.1' })).toEqual({
      version: '1.0.3',
      updateAvailable: true,
      from: 'manifest',
    })
    // GitHub cannot downgrade what the manifest already offers.
    expect(pickLatestVersion({ manifest: '1.0.3', github: '1.0.2', current: '1.0.1' })).toEqual({
      version: '1.0.3',
      updateAvailable: true,
      from: 'manifest',
    })
  })

  it('reports no update when both sources are at or below the running version', () => {
    expect(pickLatestVersion({ manifest: '1.0.1', github: '1.0.1', current: '1.0.1' })).toEqual({
      version: '1.0.1',
      updateAvailable: false,
      from: 'none',
    })
    expect(pickLatestVersion({ manifest: null, github: null, current: '1.0.1' })).toEqual({
      version: null,
      updateAvailable: false,
      from: 'none',
    })
    // An older GitHub tag must not resurrect an update the manifest already dropped.
    expect(pickLatestVersion({ manifest: '1.0.0', github: '0.9.9', current: '1.0.0' })).toEqual({
      version: '1.0.0',
      updateAvailable: false,
      from: 'none',
    })
  })

  it('does not offer a prerelease of the running version as an update', () => {
    expect(pickLatestVersion({ manifest: '1.0.1-beta.1', github: null, current: '1.0.1' }).updateAvailable).toBe(false)
    expect(pickLatestVersion({ manifest: '1.0.1', github: null, current: '1.0.1-beta.1' })).toEqual({
      version: '1.0.1',
      updateAvailable: true,
      from: 'manifest',
    })
  })
})

describe('findInstaller', () => {
  const zip = installer({ kind: 'zip', url: 'https://example.com/a.zip' })
  const exe = installer({ kind: 'exe', url: 'https://example.com/setup.exe' })
  const nsis = installer({ kind: 'nsis', url: 'https://example.com/nsis.exe' })

  it('prefers the setup exe over the portable zip for the same platform', () => {
    expect(findInstaller([zip, exe], 'win32', 'x64')?.kind).toBe('exe')
    expect(findInstaller([zip], 'win32', 'x64')?.kind).toBe('zip')
    expect(findInstaller([exe], 'win32', 'arm64')).toBeNull()
  })

  it('ranks exe, then nsis, then zip, then anything else', () => {
    const dmg = installer({ platform: 'win32', kind: 'dmg' })
    expect(findInstaller([dmg, zip, nsis], 'win32', 'x64')?.kind).toBe('nsis')
    expect(findInstaller([dmg, zip], 'win32', 'x64')?.kind).toBe('zip')
    expect(findInstaller([dmg], 'win32', 'x64')?.kind).toBe('dmg')
  })

  it('maps aarch64 to arm64 and filters by platform', () => {
    const mac = installer({ platform: 'darwin', arch: 'arm64', kind: 'dmg' })
    expect(findInstaller([exe, mac], 'darwin', 'aarch64')).toBe(mac)
    expect(findInstaller([exe, mac], 'linux', 'x64')).toBeNull()
    expect(findInstaller([], 'win32', 'x64')).toBeNull()
  })

  it('does not reorder the caller’s list', () => {
    const list = [zip, exe]
    findInstaller(list, 'win32', 'x64')
    expect(list).toEqual([zip, exe])
  })
})

describe('releaseInstallerSchema', () => {
  it('accepts a valid installer and an uppercase digest', () => {
    expect(releaseInstallerSchema.parse(installer())).toEqual(installer())
    expect(releaseInstallerSchema.safeParse(installer({ sha256: 'A'.repeat(64) })).success).toBe(true)
    expect(releaseInstallerSchema.safeParse(installer({ size_bytes: 0 })).success).toBe(true)
  })

  it.each([
    ['unknown platform', { platform: 'freebsd' }],
    ['unknown arch', { arch: 'ia32' }],
    ['unknown kind', { kind: 'msi' }],
    ['relative url', { url: '/setup.exe' }],
    ['overlong url', { url: `https://example.com/${'a'.repeat(4096)}` }],
    ['short digest', { sha256: 'a'.repeat(63) }],
    ['non-hex digest', { sha256: 'g'.repeat(64) }],
    ['negative size', { size_bytes: -1 }],
    ['fractional size', { size_bytes: 1.5 }],
  ])('rejects %s', (_label, patch) => {
    expect(releaseInstallerSchema.safeParse({ ...installer(), ...patch }).success).toBe(false)
  })

  it('strips unknown keys', () => {
    expect(releaseInstallerSchema.parse({ ...installer(), extra: true })).not.toHaveProperty('extra')
  })
})

describe('parseReleaseMarkdown', () => {
  it('parses the exe installer kind and rejects unknown kinds', () => {
    expect(parseReleaseMarkdown(releaseDocument('exe')).document.installers[0]?.kind).toBe('exe')
    expect(parseReleaseMarkdown(releaseDocument('zip')).document.installers[0]?.kind).toBe('zip')
    expect(() => parseReleaseMarkdown(releaseDocument('msi'))).toThrow(/机器数据格式不合法/)
  })

  it('returns the notes without the machine block and keeps the raw markdown', () => {
    const source = markdown(machineBlock(), { before: '# MossStudio 1.0.3\n\nNotes here.\n\n', after: '\n\n## More\n' })
    const parsed = parseReleaseMarkdown(source)
    expect(parsed.body).toBe('# MossStudio 1.0.3\n\nNotes here.\n\n\n\n## More')
    expect(parsed.raw).toBe(source)
    expect(parsed.document.app.version).toBe('1.0.3')
  })

  it('defaults installers and announcements to empty lists', () => {
    const { document } = parseReleaseMarkdown(markdown(machineBlock()))
    expect(document.installers).toEqual([])
    expect(document.announcements).toEqual([])
    expect(document.catalog).toBeUndefined()
    expect(document.home).toBeUndefined()
  })

  it('accepts CRLF line endings, trailing info text and an uppercase fence tag', () => {
    const crlf = `# Notes\r\n\`\`\`JSON CLOVER-RELEASE v2\r\n${JSON.stringify(machineBlock())}\r\n\`\`\`\r\n`
    expect(parseReleaseMarkdown(crlf).document.app.name).toBe('MossStudio')
  })

  it('uses only the first machine block', () => {
    const second = machineBlock({ app: { name: 'Second', channel: 'beta', version: '9.9.9', published_at: 'x' } })
    const doc = markdown(machineBlock()) + markdown(second, { before: '\n' })
    expect(parseReleaseMarkdown(doc).document.app.version).toBe('1.0.3')
  })

  it('parses announcements, catalog and home copy', () => {
    const { document } = parseReleaseMarkdown(
      markdown(
        machineBlock({
          catalog: { updated_at: '2026-11-01', models_url: 'https://example.com/models.json', models_sha256: SHA },
          home: { chapter: '第一章', title: '万象', subtitle: '入画' },
          announcements: [
            {
              id: 'welcome',
              level: 'info',
              title: 'Hello',
              body_markdown: '**hi**',
              starts_at: '2026-11-01T00:00:00Z',
              ends_at: null,
              dismissible: false,
              pinned: true,
              action: { label: 'Update', kind: 'check_update' },
            },
          ],
        }),
      ),
    )
    expect(document.catalog?.models_sha256).toBe(SHA)
    expect(document.home).toEqual({ chapter: '第一章', title: '万象', subtitle: '入画' })
    expect(document.announcements[0]).toMatchObject({ id: 'welcome', ends_at: null, pinned: true, action: { kind: 'check_update' } })
  })

  it('strips unknown keys from the document', () => {
    const { document } = parseReleaseMarkdown(markdown(machineBlock({ extra: 1 })))
    expect(document).not.toHaveProperty('extra')
  })

  it('fails without a machine block', () => {
    expect(() => parseReleaseMarkdown('# Just notes')).toThrow('release.md 缺少 json clover-release 机器数据块')
    expect(() => parseReleaseMarkdown('```json\n{}\n```')).toThrow(/缺少 json clover-release/)
    // The marker must follow `json` on the same line.
    expect(() => parseReleaseMarkdown('```json\nclover-release\n{}\n```')).toThrow(/缺少 json clover-release/)
  })

  it('fails on an empty block', () => {
    expect(() => parseReleaseMarkdown('```json clover-release\n```')).toThrow(/缺少 json clover-release/)
  })

  it('fails on invalid JSON with the parser message', () => {
    expect(() => parseReleaseMarkdown(markdown('{ not json'))).toThrow(/^release\.md 机器数据不是合法 JSON：/)
  })

  it.each([
    ['wrong schema version', machineBlock({ schema_version: 1 })],
    ['current schema as string', machineBlock({ schema_version: String(RELEASE_SCHEMA_VERSION) })],
    ['missing app', { schema_version: 2 }],
    ['unknown channel', machineBlock({ app: { name: 'M', channel: 'nightly', version: '1', published_at: 'x' } })],
    ['empty version', machineBlock({ app: { name: 'M', channel: 'stable', version: '', published_at: 'x' } })],
    ['bad notes url', machineBlock({ app: { name: 'M', channel: 'stable', version: '1', published_at: 'x', notes_url: 'nope' } })],
    ['too many installers', machineBlock({ installers: Array.from({ length: 41 }, () => installer()) })],
    ['bad catalog digest', machineBlock({ catalog: { updated_at: 'x', models_url: 'https://e.com/m', models_sha256: 'short' } })],
    ['empty home title', machineBlock({ home: { title: '' } })],
    ['unknown announcement level', machineBlock({ announcements: [{ id: 'a', level: 'debug', title: 't' }] })],
    ['empty announcement id', machineBlock({ announcements: [{ id: '', level: 'info', title: 't' }] })],
    ['unknown action kind', machineBlock({ announcements: [{ id: 'a', level: 'info', title: 't', action: { label: 'x', kind: 'run' } }] })],
    ['too many announcements', machineBlock({ announcements: Array.from({ length: 101 }, (_, i) => ({ id: `a${i}`, level: 'info', title: 't' })) })],
    ['array document', [machineBlock()]],
  ])('rejects %s', (_label, machine) => {
    expect(() => parseReleaseMarkdown(markdown(machine))).toThrow(/^release\.md 机器数据格式不合法：/)
  })

  it('accepts the documented limits', () => {
    const { document } = parseReleaseMarkdown(
      markdown(
        machineBlock({
          installers: Array.from({ length: 40 }, () => installer()),
          announcements: Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, level: 'critical', title: 'x'.repeat(240) })),
        }),
      ),
    )
    expect(document.installers).toHaveLength(40)
    expect(document.announcements).toHaveLength(100)
  })
})

describe('releaseVersionCandidates with prerelease assets', () => {
  it('does not swallow the platform suffix into the prerelease', () => {
    expect(releaseVersionCandidates({ assets: ['MossStudio-1.2.0-beta.1-win32-x64.zip'] })).toEqual(['1.2.0-beta.1'])
    expect(releaseVersionCandidates({ assets: ['MossStudio-1.2.0-rc2-win32-x64.exe'] })).toEqual(['1.2.0-rc2'])
    expect(releaseVersionCandidates({ tag: 'v1.2.0-beta', assets: ['MossStudio-1.2.0-win32-x64.zip'] })).toEqual(['1.2.0', '1.2.0-beta'])
  })
})
