// Fixture trees for the release-pipeline tests: small fake app folders with the shapes that
// matter (nested folders, executable bits, symlinks like a macOS framework, non-ASCII names).
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

export function useTemp() {
  let dir = ''
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'moss release 发布-')))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return () => dir
}

/** A fake asar whose packed package.json carries `version` (enough for the version checks). */
export function fakeAsar(version) {
  const pkg = Buffer.from(JSON.stringify({ name: '@clover/desktop', version }))
  const header = Buffer.from(JSON.stringify({ files: { 'package.json': { size: pkg.length, offset: '0' } } }))
  const pickle = Buffer.alloc(16)
  pickle.writeUInt32LE(4, 0)
  pickle.writeUInt32LE(header.length + 8, 4)
  pickle.writeUInt32LE(header.length + 4, 8)
  pickle.writeUInt32LE(header.length, 12)
  return Buffer.concat([pickle, header, pkg])
}

function put(root, path, content, mode = 0o644) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  chmodSync(full, mode)
}

/**
 * Linux-like app folder (contents of app-<version>/). `variant` changes some files so two
 * versions differ the way real releases do: one changed, one added, one removed, one mode change.
 */
export function makeAppTree(root, version, variant = 0) {
  put(root, 'MossStudio', `#!/bin/sh\necho moss ${variant < 2 ? 'same' : 'new'}\n`, 0o755)
  put(root, 'chrome_crashpad_handler', 'crashpad', variant === 0 ? 0o644 : 0o755)
  put(root, 'resources/app.asar', fakeAsar(version))
  put(root, 'resources/models.json', `{"v":"${version}"}`)
  put(root, 'locales/zh-CN.pak', 'zh')
  put(root, 'resources/内容 文件.txt', '中文 content with space')
  put(root, 'libffmpeg.so', Buffer.alloc(64 * 1024, 7), 0o755)
  if (variant === 0) put(root, 'old-only.dat', 'gone in the next version')
  else put(root, 'new-only.dat', 'added in the next version')
  mkdirSync(join(root, 'lib'), { recursive: true })
  symlinkSync('../libffmpeg.so', join(root, 'lib', 'libffmpeg.so'))
  symlinkSync(variant === 0 ? 'zh-CN.pak' : '../resources/models.json', join(root, 'locales', 'current'))
}

/** macOS-like bundle with framework symlinks, as MossStudio.app/... */
export function makeMacBundle(parent, version) {
  const app = join(parent, 'MossStudio.app')
  put(app, 'Contents/MacOS/MossStudio', 'macho', 0o755)
  put(app, 'Contents/Resources/app.asar', fakeAsar(version))
  const fw = join(app, 'Contents/Frameworks/Electron Framework.framework')
  put(fw, 'Versions/A/Electron Framework', 'framework', 0o755)
  put(fw, 'Versions/A/Resources/Info.plist', '<plist/>')
  symlinkSync('A', join(fw, 'Versions/Current'))
  symlinkSync('Versions/Current/Electron Framework', join(fw, 'Electron Framework'))
  symlinkSync('Versions/Current/Resources', join(fw, 'Resources'))
  return app
}
