import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertLinksResolveInside, assertSafeLinkTarget, safeParts } from '@main/update/paths'
import { extractZip } from '@main/update/zip'
import { useTempDir } from '@test/helpers/tempDir'
import { makeZip, type ZipItem } from './helpers'

const temp = useTempDir('moss-zip-')
const unix = process.platform !== 'win32'

async function extract(items: ZipItem[], options: { maxBytes?: number } = {}) {
  const zip = join(temp(), 'pkg.zip')
  writeFileSync(zip, makeZip(items))
  const dest = join(temp(), 'out', 'app')
  mkdirSync(dest, { recursive: true })
  return { dest, result: extractZip(zip, dest, options) }
}

describe('safeParts', () => {
  it('accepts plain relative paths', () => {
    expect(safeParts('resources/app.asar', 'linux')).toEqual(['resources', 'app.asar'])
    expect(safeParts('Contents/MacOS/MossStudio', 'darwin')).toEqual(['Contents', 'MacOS', 'MossStudio'])
  })

  it.each([['../evil'], ['a/../../evil'], ['/etc/passwd'], ['C:/Windows/x'], ['a\\b'], ['a//b'], ['./a'], ['a/./b'], [''], ['a\0b']])(
    'refuses %j',
    (path) => {
      expect(() => safeParts(path, 'linux')).toThrow('不安全的路径')
    },
  )

  it('refuses Windows device names and streams on Windows', () => {
    expect(() => safeParts('a/CON', 'win32')).toThrow()
    expect(() => safeParts('a/file.txt:stream', 'win32')).toThrow()
    expect(() => safeParts('trailing.', 'win32')).toThrow()
  })
})

describe('assertSafeLinkTarget', () => {
  it('allows links that stay inside the root and refuses escapes and absolute targets', () => {
    const root = join(temp(), 'root')
    expect(() => assertSafeLinkTarget(root, join(root, 'A.framework', 'A'), 'Versions/Current/A')).not.toThrow()
    expect(() => assertSafeLinkTarget(root, join(root, 'a', 'b', 'link'), '../../x')).not.toThrow()
    expect(() => assertSafeLinkTarget(root, join(root, 'a', 'link'), '../../outside')).toThrow('之外')
    expect(() => assertSafeLinkTarget(root, join(root, 'link'), '/etc/passwd')).toThrow('不安全')
    expect(() => assertSafeLinkTarget(root, join(root, 'link'), 'C:\\Windows')).toThrow('不安全')
  })
})

describe('extractZip', () => {
  it('unpacks files into nested folders', async () => {
    const { dest, result } = await extract([
      { name: 'resources/', dir: true },
      { name: 'resources/app.asar', data: 'asar' },
      { name: '中文 目录/文件.txt', data: '你好' },
    ])
    expect(await result).toEqual([
      { path: 'resources/app.asar', type: 'file' },
      { path: '中文 目录/文件.txt', type: 'file' },
    ])
    expect(readFileSync(join(dest, 'resources', 'app.asar'), 'utf8')).toBe('asar')
    expect(readFileSync(join(dest, '中文 目录', '文件.txt'), 'utf8')).toBe('你好')
  })

  it.runIf(unix)('keeps unix modes and creates symlinks last', async () => {
    const { dest, result } = await extract([
      { name: 'A.framework/Versions/Current', symlink: 'A' },
      { name: 'A.framework/Versions/A/bin', data: '#!/bin/sh\n', mode: 0o755 },
      { name: 'A.framework/Versions/A/data', data: 'x', mode: 0o600 },
    ])
    await result
    expect(lstatSync(join(dest, 'A.framework/Versions/A/bin')).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(dest, 'A.framework/Versions/A/data')).mode & 0o777).toBe(0o600)
    expect(readlinkSync(join(dest, 'A.framework/Versions/Current'))).toBe('A')
  })

  it.each([['../evil.txt'], ['nested/../../evil.txt'], ['/abs/evil.txt']])(
    'refuses the traversal entry %j and writes nothing outside',
    async (name) => {
      const { result } = await extract([{ name, data: 'pwned' }])
      await expect(result).rejects.toThrow()
      expect(existsSync(join(temp(), 'evil.txt'))).toBe(false)
      expect(existsSync(join(temp(), 'out', 'evil.txt'))).toBe(false)
    },
  )

  it('refuses a symlink that escapes the folder', async () => {
    const { result } = await extract([{ name: 'link', symlink: '../../../etc' }])
    await expect(result).rejects.toThrow('之外')
  })

  it('refuses an absolute symlink target', async () => {
    const { result } = await extract([{ name: 'link', symlink: '/etc/passwd' }])
    await expect(result).rejects.toThrow('不安全的符号链接')
  })

  it.runIf(unix)('never writes a file through a symlinked folder', async () => {
    // A link "dir" → "../outside" (refused anyway) followed by "dir/x": "dir" is created as a real
    // folder first because links are deferred, so the link then collides instead of redirecting.
    const { dest, result } = await extract([
      { name: 'dir', symlink: 'sub' },
      { name: 'dir/x', data: 'x' },
    ])
    await expect(result).rejects.toThrow()
    expect(lstatSync(join(dest, 'dir')).isDirectory()).toBe(true)
  })

  it('refuses duplicate entries', async () => {
    const { result } = await extract([
      { name: 'a.txt', data: '1' },
      { name: 'a.txt', data: '2' },
    ])
    await expect(result).rejects.toThrow()
  })

  it('refuses archives larger than expected', async () => {
    const { result } = await extract([{ name: 'big.bin', data: Buffer.alloc(4096) }], { maxBytes: 1000 })
    await expect(result).rejects.toThrow('超过预期大小')
  })
})

describe.runIf(unix)('assertLinksResolveInside', () => {
  it('accepts links that resolve inside and dangling links whose folder is inside', async () => {
    const root = join(temp(), 'root')
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'f'), 'x')
    symlinkSync('a/b', join(root, 'ab'))
    symlinkSync('ab/f', join(root, 'chain'))
    symlinkSync('missing', join(root, 'dangling'))
    await expect(assertLinksResolveInside(root, [join(root, 'ab'), join(root, 'chain'), join(root, 'dangling')])).resolves.toBeUndefined()
  })

  it('refuses a link that really resolves outside (through another link)', async () => {
    const root = join(temp(), 'root')
    const outside = join(temp(), 'outside')
    mkdirSync(join(outside, 'x'), { recursive: true })
    mkdirSync(root, { recursive: true })
    symlinkSync(outside, join(root, 'out'))
    symlinkSync('out/x', join(root, 'via'))
    await expect(assertLinksResolveInside(root, [join(root, 'via')])).rejects.toThrow('之外')
  })
})
