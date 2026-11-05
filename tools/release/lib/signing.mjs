// Code signing. Releases are not Authenticode-signed or notarized yet; macOS bundles are
// ad-hoc signed because arm64 macOS refuses to run unsigned code.
//
// REAL SIGNING HOOK: when certificates exist, put the platform signing here and give the
// workflows the secrets below. Until then a configured secret stops the build instead of
// silently publishing unsigned binaries as if they were signed.
//   Windows: MOSS_WINDOWS_SIGN_CERT (+ MOSS_WINDOWS_SIGN_PASSWORD)  → signtool the exe/dll files
//   macOS:   MOSS_MAC_SIGN_IDENTITY (+ MOSS_MAC_NOTARY_*)            → codesign --options runtime + notarytool
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './cli.mjs'
import { walkTree } from './tree.mjs'

const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

function isMachO(path) {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && MACHO_MAGIC.has(head.readUInt32BE(0))
  } finally {
    closeSync(fd)
  }
}

const REAL_SIGNING_SECRETS = {
  win32: ['MOSS_WINDOWS_SIGN_CERT'],
  darwin: ['MOSS_MAC_SIGN_IDENTITY'],
  linux: [],
}

function requestedRealSigning(os, env) {
  return (REAL_SIGNING_SECRETS[os] ?? []).filter((name) => env[name])
}

function refuseUnwiredSigning(os, env) {
  const set = requestedRealSigning(os, env)
  if (set.length > 0) {
    throw new Error(`${set.join(', ')} is set but real ${os} signing is not wired up yet: implement it in tools/release/lib/signing.mjs`)
  }
}

/** Sign the packaged app (folder on Windows/Linux, MossStudio.app on macOS). */
export function signApp({ os, appPath, env = process.env }) {
  refuseUnwiredSigning(os, env)
  if (os === 'darwin') {
    // --deep reaches nested bundles and frameworks, not loose Mach-O files such as dugite's git
    // in Resources/app.asar.unpacked; arm64 kills unsigned code it executes, so sign those first.
    const unpacked = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked')
    if (existsSync(unpacked)) {
      for (const item of walkTree(unpacked)) {
        if (item.type === 'file' && isMachO(item.abs)) run('codesign', ['--force', '--sign', '-', item.abs], { stdio: 'ignore' })
      }
    }
    run('codesign', ['--force', '--deep', '--sign', '-', appPath])
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  }
}

/** Sign a first-install download (Setup .exe, .dmg). Ad-hoc signing does not apply to these. */
export function signInstaller({ os, env = process.env }) {
  refuseUnwiredSigning(os, env)
}
