#!/usr/bin/env node
// Build everything the install → update → rollback test serves, from ONE `pnpm build` made
// with the test environment (MOSS_UPDATE_TEST_KEYS = the test public key, MOSS_UPDATE_FEED_URL
// = this server's /feed/):
//   X    = the package version     installed by the setup file (every artifact: setup, portable, full)
//   X+1  = same build, stamped     offered first (full + delta from X)
//   X+2  = same build, stamped     offered next; the test makes it crash at start → rollback
// X+1 and X+2 are only ever updated to, so they get the update files alone (--update-only):
// no setup, DMG or portable package, which were most of this script's time.
//
//   node tools/release/integration/prepare.mjs --key-file <seed file> [--platform linux-x64]
//        [--out dist/it] [--skip-package]
//
// Output (<out>/<platform>/): app/<v>/..., artifacts/ (all three versions + deltas),
// feeds/<X+1>/ and feeds/<X+2>/ (signed update-stable.json + update-beta.json), versions.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DESKTOP_DIR, hostPlatform, main, readJson, REPO_ROOT, run } from '../lib/cli.mjs'
import { parsePrivateKey, publicKeyBase64 } from '../lib/sign.mjs'
import { bumpPatch } from '../lib/version.mjs'
import { itFilesUrl } from './server.mjs'

const tool = (name) => join(REPO_ROOT, 'tools', 'release', name)
const node = (script, args) => run(process.execPath, ['--no-warnings', tool(script), ...args])

main(async () => {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string', default: hostPlatform() },
      'key-file': { type: 'string' },
      out: { type: 'string', default: join(REPO_ROOT, 'dist', 'it') },
      'skip-package': { type: 'boolean', default: false },
    },
  })
  const { platform } = values
  if (!values['key-file']) throw new Error('--key-file <private key> is required')
  const publicKey = publicKeyBase64(parsePrivateKey(readFileSync(values['key-file'], 'utf8')))
  const x = readJson(join(DESKTOP_DIR, 'package.json')).version
  const versions = [x, bumpPatch(x, 1), bumpPatch(x, 2)]
  const base = join(resolve(values.out), platform)
  const appOut = join(base, 'app')
  const artifacts = join(base, 'artifacts')
  mkdirSync(artifacts, { recursive: true })

  if (!values['skip-package']) {
    node('package-app.mjs', ['--platform', platform, '--out', appOut, ...versions.flatMap((v) => ['--version', v])])
  }
  for (const version of versions) {
    const only = version === versions[0] ? [] : ['--update-only']
    node('make-artifacts.mjs', ['--platform', platform, '--version', version, '--app', join(appOut, version, platform), '--out', artifacts, ...only])
  }
  // Deltas X → X+1 and X+1 → X+2 (the file lists of the earlier versions sit in artifacts/).
  node('make-deltas.mjs', ['--version', versions[1], '--previous', artifacts, '--artifacts', artifacts, '--platform', platform])
  node('make-deltas.mjs', ['--version', versions[2], '--previous', artifacts, '--artifacts', artifacts, '--platform', platform])

  for (const version of versions.slice(1)) {
    const feeds = join(base, 'feeds', version)
    node('make-feed.mjs', ['--version', version, '--artifacts', artifacts, '--out', feeds, '--base-url', itFilesUrl(), '--channel', 'stable', '--channel', 'beta', '--notes-dir', join(base, 'notes')])
    node('sign-feed.mjs', ['--key-file', values['key-file'], join(feeds, 'update-stable.json'), join(feeds, 'update-beta.json')])
  }
  for (const version of versions) {
    const feedArgs = version === versions[0] ? ['--no-feeds'] : ['--update-only', '--feeds', join(base, 'feeds', version), '--public-key', publicKey, '--url-prefix', itFilesUrl()]
    node('verify-artifacts.mjs', ['--version', version, '--artifacts', artifacts, '--platform', platform, '--previous', artifacts, ...feedArgs])
  }
  writeFileSync(join(base, 'versions.json'), `${JSON.stringify({ platform, versions, publicKey }, null, 2)}\n`)
  console.log(`integration fixtures ready in ${base}: ${versions.join(', ')}`)
})
