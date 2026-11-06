import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FileList } from '@shared/install'
import { materialize, verifyTree } from '@main/update/materialize'
import { useTempDir } from '@test/helpers/tempDir'
import { fileListOf, makeZip, sha256, thisPlatform, type ZipItem } from './helpers'

const temp = useTempDir('moss-mat-')
const unix = process.platform !== 'win32'

function tree(root: string, files: Record<string, string | { data: string; mode?: number; link?: string }>): string {
  for (const [path, spec] of Object.entries(files)) {
    const full = join(root, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    const value = typeof spec === 'string' ? { data: spec } : spec
    if (value.link !== undefined) {
      symlinkSync(value.link, full)
      continue
    }
    writeFileSync(full, value.data)
    if (unix) chmodSync(full, value.mode ?? 0o644)
  }
  return root
}

/** The zip of `dir` as the pipeline would build it. */
function zipOf(list: FileList, dir: string, prefix = ''): ZipItem[] {
  return list.entries.map((entry) =>
    entry.type === 'symlink'
      ? { name: `${prefix}${entry.path}`, symlink: entry.target }
      : { name: `${prefix}${entry.path}`, data: readFileSync(join(dir, ...entry.path.split('/'))), mode: entry.mode },
  )
}

function write(name: string, data: Buffer): string {
  const file = join(temp(), name)
  writeFileSync(file, data)
  return file
}

const platform = thisPlatform()

function newVersion(): { dir: string; list: FileList } {
  const dir = tree(join(temp(), 'source-1.1.0'), {
    MossStudio: { data: 'binary 1.1.0', mode: 0o755 },
    'resources/app.asar': 'asar 1.1.0',
    'resources/unchanged.pak': 'same in both',
    'locales/zh-CN.pak': '中文',
    'new/feature.js': 'new file',
    ...(unix ? { 'lib/current': { data: '', link: 'v2' }, 'lib/v2/libx.so': { data: 'lib', mode: 0o755 } } : {}),
  })
  return { dir, list: fileListOf(dir, '1.1.0', platform) }
}

describe('materialize (full package)', () => {
  it('unpacks, verifies every entry and renames app-<v>.partial to app-<v>', async () => {
    const { dir, list } = newVersion()
    const zip = write('full.zip', makeZip(zipOf(list, dir)))
    const root = join(temp(), 'R')
    const finalDir = await materialize({
      kind: 'full',
      zipPath: zip,
      fileList: list,
      partialDir: join(root, 'app-1.1.0.partial'),
      finalDir: join(root, 'app-1.1.0'),
    })
    expect(finalDir).toBe(join(root, 'app-1.1.0'))
    expect(existsSync(join(root, 'app-1.1.0.partial'))).toBe(false)
    expect(readFileSync(join(finalDir, 'resources', 'app.asar'), 'utf8')).toBe('asar 1.1.0')
    if (unix) {
      expect(statSync(join(finalDir, 'MossStudio')).mode & 0o777).toBe(0o755)
      expect(readlinkSync(join(finalDir, 'lib', 'current'))).toBe('v2')
    }
  })

  it.each([
    ['an extra file', (items: ZipItem[]) => [...items, { name: 'evil.dll', data: 'x' }], '清单之外'],
    ['a missing file', (items: ZipItem[]) => items.filter((item) => item.name !== 'locales/zh-CN.pak'), '缺少文件'],
    [
      'a changed byte',
      (items: ZipItem[]) => items.map((item) => (item.name === 'resources/app.asar' ? { ...item, data: 'asar 1.1.1' } : item)),
      '校验失败',
    ],
    [
      'a wrong size',
      (items: ZipItem[]) => items.map((item) => (item.name === 'resources/app.asar' ? { ...item, data: 'asar' } : item)),
      '大小不符',
    ],
  ])('refuses %s and removes the partial folder', async (_name, change, message) => {
    const { dir, list } = newVersion()
    const zip = write('full.zip', makeZip(change(zipOf(list, dir))))
    const root = join(temp(), 'R')
    await expect(
      materialize({
        kind: 'full',
        zipPath: zip,
        fileList: list,
        partialDir: join(root, 'app-1.1.0.partial'),
        finalDir: join(root, 'app-1.1.0'),
      }),
    ).rejects.toThrow(message)
    expect(existsSync(join(root, 'app-1.1.0.partial'))).toBe(false)
    expect(existsSync(join(root, 'app-1.1.0'))).toBe(false)
  })

  it.runIf(unix)('refuses a wrong mode and a wrong symlink target', async () => {
    const { dir, list } = newVersion()
    const root = join(temp(), 'R')
    const run = (items: ZipItem[]) =>
      materialize({
        kind: 'full',
        zipPath: write('full.zip', makeZip(items)),
        fileList: list,
        partialDir: join(root, 'p'),
        finalDir: join(root, 'f'),
      })
    await expect(run(zipOf(list, dir).map((item) => (item.name === 'MossStudio' ? { ...item, mode: 0o644 } : item)))).rejects.toThrow(
      '权限不符',
    )
    await expect(run(zipOf(list, dir).map((item) => (item.name === 'lib/current' ? { ...item, symlink: 'v1' } : item)))).rejects.toThrow(
      '目标不符',
    )
  })

  it('refuses a traversal entry before writing anything outside', async () => {
    const { dir, list } = newVersion()
    const zip = write('full.zip', makeZip([...zipOf(list, dir), { name: '../../escaped.txt', data: 'x' }]))
    const root = join(temp(), 'R')
    await expect(
      materialize({
        kind: 'full',
        zipPath: zip,
        fileList: list,
        partialDir: join(root, 'app-1.1.0.partial'),
        finalDir: join(root, 'app-1.1.0'),
      }),
    ).rejects.toThrow()
    expect(existsSync(join(temp(), 'escaped.txt'))).toBe(false)
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false)
  })
})

describe('materialize (delta)', () => {
  function setup() {
    const base = tree(join(temp(), 'R', 'app-1.0.3'), {
      MossStudio: { data: 'binary 1.0.3', mode: 0o755 },
      'resources/app.asar': 'asar 1.0.3',
      'resources/unchanged.pak': 'same in both',
      'locales/zh-CN.pak': '中文',
      'removed/old.js': 'gone in 1.1.0',
      ...(unix
        ? {
            'lib/current': { data: '', link: 'v1' },
            'lib/v1/libx.so': { data: 'old lib', mode: 0o755 },
            'lib/v2/libx.so': { data: 'lib', mode: 0o755 },
          }
        : {}),
    })
    const { dir, list } = newVersion()
    const filesJson = Buffer.from(JSON.stringify(list))
    const changed = ['MossStudio', 'resources/app.asar', 'new/feature.js', ...(unix ? ['lib/current'] : [])]
    const manifest = {
      schema: 1,
      platform,
      from: '1.0.3',
      to: '1.1.0',
      files: { sha256: sha256(filesJson), size: filesJson.length },
      changed,
      removed: ['removed/old.js', ...(unix ? ['lib/v1/libx.so'] : [])],
    }
    const items = (patch: { manifest?: object; extra?: ZipItem[] } = {}): ZipItem[] => [
      { name: 'delta.json', data: JSON.stringify(patch.manifest ?? manifest) },
      ...zipOf({ ...list, entries: list.entries.filter((entry) => changed.includes(entry.path)) }, dir, 'files/'),
      ...(patch.extra ?? []),
    ]
    const root = join(temp(), 'R')
    const run = (zipItems: ZipItem[], baseVersion = '1.0.3') =>
      materialize({
        kind: 'delta',
        zipPath: write('delta.zip', makeZip(zipItems)),
        fileList: list,
        baseDir: base,
        baseVersion,
        filesSha256: manifest.files.sha256,
        partialDir: join(root, 'app-1.1.0.partial'),
        finalDir: join(root, 'app-1.1.0'),
      })
    return { base, list, manifest, items, run, root }
  }

  it('builds app-<v> from unchanged base files, the changed files and the deletions', async () => {
    const { base, items, run, root, list } = setup()
    const out = await run(items())
    expect(readFileSync(join(out, 'MossStudio'), 'utf8')).toBe('binary 1.1.0')
    expect(readFileSync(join(out, 'resources', 'unchanged.pak'), 'utf8')).toBe('same in both')
    expect(readFileSync(join(out, 'new', 'feature.js'), 'utf8')).toBe('new file')
    expect(existsSync(join(out, 'removed'))).toBe(false)
    expect(existsSync(join(root, 'app-1.1.0.partial.delta'))).toBe(false)
    // The running version is untouched.
    expect(readFileSync(join(base, 'MossStudio'), 'utf8')).toBe('binary 1.0.3')
    if (unix) {
      expect(readlinkSync(join(out, 'lib', 'current'))).toBe('v2')
      expect(existsSync(join(out, 'lib', 'v1'))).toBe(false)
      // Unchanged files are hardlinks of the running version when the volume allows it.
      expect(lstatSync(join(out, 'resources', 'unchanged.pak')).ino).toBe(lstatSync(join(base, 'resources', 'unchanged.pak')).ino)
    }
    await expect(verifyTree(out, list)).resolves.toBeUndefined()
  })

  it.runIf(unix)('copies (does not hardlink) a base file whose mode changes, leaving the base mode alone', async () => {
    const { base, items, run, list } = setup()
    chmodSync(join(base, 'locales', 'zh-CN.pak'), 0o600)
    const entry = list.entries.find((item) => item.path === 'locales/zh-CN.pak')
    expect(entry && entry.type === 'file' && entry.mode).toBe(0o644)
    const out = await run(items())
    expect(statSync(join(out, 'locales', 'zh-CN.pak')).mode & 0o777).toBe(0o644)
    expect(statSync(join(base, 'locales', 'zh-CN.pak')).mode & 0o777).toBe(0o600)
  })

  it('fails on a modified base file (hash mismatch) and cleans up', async () => {
    const { base, items, run, root } = setup()
    writeFileSync(join(base, 'resources', 'unchanged.pak'), 'same in bot!')
    await expect(run(items())).rejects.toThrow('校验失败')
    expect(existsSync(join(root, 'app-1.1.0.partial'))).toBe(false)
    expect(existsSync(join(root, 'app-1.1.0'))).toBe(false)
  })

  it('fails when a base file is missing', async () => {
    const { base, items, run } = setup()
    const { rmSync } = await import('node:fs')
    rmSync(join(base, 'locales', 'zh-CN.pak'))
    await expect(run(items())).rejects.toThrow('缺少基础文件')
  })

  it('refuses a delta built from another version or against another file list', async () => {
    const { items, run, manifest } = setup()
    await expect(run(items(), '1.0.2')).rejects.toThrow('基于 1.0.3')
    await expect(run(items({ manifest: { ...manifest, files: { sha256: 'c'.repeat(64), size: 1 } } }))).rejects.toThrow('文件清单不符')
    await expect(run(items({ manifest: { ...manifest, to: '1.2.0' } }))).rejects.toThrow('目标版本不符')
  })

  it('refuses extra files in the delta and changes outside the file list', async () => {
    const { items, run, manifest } = setup()
    await expect(run(items({ extra: [{ name: 'files/evil.dll', data: 'x' }] }))).rejects.toThrow('清单之外')
    await expect(run(items({ extra: [{ name: 'stray.txt', data: 'x' }] }))).rejects.toThrow('清单之外')
    await expect(run(items({ manifest: { ...manifest, changed: [...manifest.changed, 'not/listed.js'] } }))).rejects.toThrow('清单之外')
  })

  it('fails when a changed file is missing from the delta, or delta.json is', async () => {
    const { items, run } = setup()
    await expect(run(items().filter((item) => item.name !== 'files/new/feature.js'))).rejects.toThrow('增量包缺少文件')
    await expect(run(items().filter((item) => item.name !== 'delta.json'))).rejects.toThrow('delta.json')
  })
})
