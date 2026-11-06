#!/usr/bin/env node
// Turn a packaged app (package-app.mjs) into the downloads of one version and platform.
//
//   node tools/release/make-artifacts.mjs --platform linux-x64 --version 1.2.3
//        [--app dist/release/app/<v>/<platform>] [--out dist/release/artifacts]
//
// Windows  MossStudio-Setup-<v>-x64.exe            launcher stub + payload (launcher `pack`)
//          MossStudio-<v>-win-x64-portable.zip
// Linux    MossStudio-Setup-<v>-linux-x64.run
//          MossStudio-<v>-linux-x64-portable.tar.gz
// macOS    MossStudio-<v>-mac-<arch>.dmg            (hdiutil; MossStudio.app + Applications link)
//          MossStudio-<v>-mac-<arch>-portable.zip
// All      MossStudio-<v>-<platform>-full.zip      update package (symlinks and modes kept)
//          files-<v>-<platform>.json                FileList of the full package
//
// Portable layout: MossStudio/ holding the launcher, app-<v>/, portable.json and an empty
// data/ (macOS: MossStudio.app, portable.json, data/).
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DIST_DIR, hostPlatform, launcherBinary, main, REPO_ROOT, run } from './lib/cli.mjs'
import { signInstaller } from './lib/signing.mjs'
import { fileListFromTree, walkTree, zipTree } from './lib/tree.mjs'
import { artifactNames, isVersion, portableMarker, splitPlatform } from './lib/version.mjs'

const LAUNCHER_NAME = { win32: 'MossStudio.exe', linux: 'mossstudio' }

/**
 * Move `from` to `to` for the duration of `fn` and always move it back: the app folder is
 * hundreds of MB and the payload/portable/DMG staging folders only need it briefly.
 */
async function borrow(from, to, fn) {
  mkdirSync(join(to, '..'), { recursive: true })
  renameSync(from, to)
  try {
    return await fn()
  } finally {
    renameSync(to, from)
  }
}

function writeFileList(tree, path, { version, platform }) {
  const list = fileListFromTree(tree, { version, platform })
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`)
  return list
}

/**
 * `pack` (launcher/main.go) writes stub + payload; any host can pack any stub. On Windows the
 * launcher exe is a GUI-subsystem binary that shells may not wait for, so pack runs through
 * `go run` (a console build) there; elsewhere the Linux binary does it.
 */
function pack(args) {
  if (hostPlatform() === 'linux-x64') return run(launcherBinary('linux-x64'), ['pack', ...args])
  return run('go', ['-C', join(REPO_ROOT, 'apps', 'launcher'), 'run', '.', 'pack', ...args])
}

async function winLinuxArtifacts({ platform, os, version, appDir, out, names, mtime, staging }) {
  const appTree = walkTree(appDir)
  zipTree(appTree, join(out, names.full), { platform, mtime })
  writeFileList(appTree, join(out, names.files), { version, platform })

  const stub = launcherBinary(platform)
  const payloadDir = join(staging, 'payload')
  await borrow(appDir, join(payloadDir, `app-${version}`), () => {
    // Level 6: within 0.5% of 9 on Electron's binaries at less than half the time.
    pack(['--stub', stub, '--payload', payloadDir, '--out', join(out, names.setup), '--level', '6'])
  })
  if (os === 'linux') chmodSync(join(out, names.setup), 0o755)
  signInstaller({ os })

  const portableRoot = join(staging, 'portable', 'MossStudio')
  mkdirSync(join(portableRoot, 'data'), { recursive: true })
  copyFileSync(stub, join(portableRoot, LAUNCHER_NAME[os]))
  if (os === 'linux') chmodSync(join(portableRoot, LAUNCHER_NAME[os]), 0o755)
  writeFileSync(join(portableRoot, 'portable.json'), portableMarker(version))
  await borrow(appDir, join(portableRoot, `app-${version}`), () => {
    if (os === 'win32') {
      zipTree(walkTree(join(staging, 'portable')), join(out, names.portable), { platform, mtime })
    } else {
      // GNU tar keeps modes and symlinks; owner is normalised so extraction never needs root.
      run('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', join(out, names.portable), '-C', join(staging, 'portable'), 'MossStudio'])
    }
  })
}

async function macArtifacts({ platform, version, appDir, out, names, mtime, staging }) {
  const bundle = join(appDir, 'MossStudio.app')
  if (!existsSync(bundle)) throw new Error(`${bundle} is missing`)
  // Bundle-relative (Contents/...): the updater extracts into .MossStudio-<v>.app itself.
  const appTree = walkTree(bundle)
  zipTree(appTree, join(out, names.full), { platform, mtime })
  writeFileList(appTree, join(out, names.files), { version, platform })

  const dmgRoot = join(staging, 'dmg')
  mkdirSync(dmgRoot, { recursive: true })
  symlinkSync('/Applications', join(dmgRoot, 'Applications'))
  await borrow(bundle, join(dmgRoot, 'MossStudio.app'), async () => {
    // hdiutil on hosted runners fails now and then with "Resource busy"; a retry clears it.
    for (let attempt = 1; ; attempt++) {
      rmSync(join(out, names.setup), { force: true })
      try {
        run('hdiutil', ['create', '-volname', `MossStudio ${version}`, '-srcfolder', dmgRoot, '-fs', 'HFS+', '-format', 'UDZO', '-imagekey', 'zlib-level=6', '-ov', join(out, names.setup)])
        break
      } catch (error) {
        if (attempt >= 3) throw error
        console.warn(`hdiutil create failed (attempt ${attempt}), retrying: ${error.message}`)
        await new Promise((done) => setTimeout(done, 5000 * attempt))
      }
    }
  })
  signInstaller({ os: 'darwin' })

  const portableRoot = join(staging, 'portable', 'MossStudio')
  mkdirSync(join(portableRoot, 'data'), { recursive: true })
  writeFileSync(join(portableRoot, 'portable.json'), portableMarker(version))
  await borrow(bundle, join(portableRoot, 'MossStudio.app'), () => {
    zipTree(walkTree(join(staging, 'portable')), join(out, names.portable), { platform, mtime })
  })
}

main(async () => {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string', default: hostPlatform() },
      version: { type: 'string' },
      app: { type: 'string' },
      out: { type: 'string', default: join(DIST_DIR, 'artifacts') },
    },
  })
  const { platform } = values
  const version = values.version
  if (!isVersion(version)) throw new Error('--version <semver> is required')
  const { os } = splitPlatform(platform)
  const appDir = resolve(values.app ?? join(DIST_DIR, 'app', version, platform))
  if (!existsSync(appDir)) throw new Error(`app folder missing: ${appDir} (run package-app first)`)
  const out = resolve(values.out)
  mkdirSync(out, { recursive: true })
  const names = artifactNames(version, platform)
  const staging = join(out, `.staging-${version}-${platform}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const mtime = new Date()
  try {
    if (os === 'darwin') await macArtifacts({ platform, version, appDir, out, names, mtime, staging })
    else await winLinuxArtifacts({ platform, os, version, appDir, out, names, mtime, staging })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  for (const file of Object.values(names)) console.log(join(out, file))
})
