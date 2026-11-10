#!/usr/bin/env node
// Re-verify built artifacts before they are uploaded.
//
//   node tools/release/verify-artifacts.mjs --version 1.2.3 [--artifacts dist/release/artifacts]
//        (--public-key <base64> | --keys <json [{id, publicKey}]> | --production-keys | --nightly-keys)
//        [--previous <dir of earlier files-*.json>] [--url-prefix https://github.com/...]
//        [--platform linux-x64 ...] [--feeds <dir, default = artifacts>] [--no-feeds | --feeds-optional]
//
// Checks, for every platform with a full package of this version:
//   files-<v>-<platform>.json  parses with fileListSchema, sorted, safe paths and links
//   full zip                   identical to the file list (content, modes, symlinks); app.asar version
//   setup (.exe/.run)          payload trailer + hash; app-<v>/ identical to the file list
//   portable                   layout (launcher, app, portable.json, data/) and app identical to the list
//   deltas                     manifest schema, built against this file list, contents; with
//                              --previous also the changed/removed plan
//   .dmg                       `hdiutil verify` (macOS hosts only)
// and every update-*.json: signature against the given keys, schema, every asset's sha256/size.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DIST_DIR, main, run } from './lib/cli.mjs'
import { loadInstallContract, loadNightlyKeys, loadProductionKeys } from './lib/contract.mjs'
import { keyIdFor } from './lib/sign.mjs'
import { artifactNames, isVersion, nightlyAssetUrl, parseDeltaName, PLATFORMS, releaseAssetUrl } from './lib/version.mjs'
import { checkDelta, checkFeed, checkFileList, checkFullZip, checkPortable, checkSetupFile } from './lib/verify.mjs'

main(async () => {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      artifacts: { type: 'string', default: join(DIST_DIR, 'artifacts') },
      'public-key': { type: 'string' },
      keys: { type: 'string' },
      'production-keys': { type: 'boolean', default: false },
      // update-nightly.json only, signed by a NIGHTLY_UPDATE_KEYS key, packages on the `updates` release.
      'nightly-keys': { type: 'boolean', default: false },
      previous: { type: 'string' },
      'url-prefix': { type: 'string' },
      platform: { type: 'string', multiple: true },
      'no-feeds': { type: 'boolean', default: false },
      feeds: { type: 'string' },
      'feeds-optional': { type: 'boolean', default: false },
      // Only the update files (full package, file list, deltas): see make-artifacts --update-only.
      'update-only': { type: 'boolean', default: false },
    },
  })
  const version = values.version
  if (!isVersion(version)) throw new Error('--version <semver> is required')
  const dir = resolve(values.artifacts)
  const contract = await loadInstallContract()
  const present = new Set(readdirSync(dir))

  let checkedPlatforms = 0
  for (const platform of values.platform?.length ? values.platform : PLATFORMS) {
    const names = artifactNames(version, platform)
    if (!present.has(names.full)) {
      if (values.platform?.length) throw new Error(`${names.full} missing`)
      continue
    }
    const listBytes = readFileSync(join(dir, names.files))
    const list = contract.fileListSchema.parse(JSON.parse(listBytes.toString('utf8')))
    checkFileList(list, { version, platform })
    await checkFullZip(join(dir, names.full), list)
    console.log(`ok  ${names.full} (${list.entries.length} entries)`)
    if (values['update-only']) {
      for (const name of [names.setup, names.portable]) if (present.has(name)) throw new Error(`${name} present in an --update-only check`)
    } else {
      if (!present.has(names.setup)) throw new Error(`${names.setup} missing`)
      if (platform.startsWith('darwin')) {
        if (process.platform === 'darwin') run('hdiutil', ['verify', join(dir, names.setup)], { stdio: 'ignore' })
        console.log(`ok  ${names.setup}${process.platform === 'darwin' ? '' : ' (present; hdiutil verify needs macOS)'}`)
      } else {
        checkSetupFile(join(dir, names.setup), list)
        console.log(`ok  ${names.setup}`)
      }
      if (!present.has(names.portable)) throw new Error(`${names.portable} missing`)
      await checkPortable(join(dir, names.portable), list)
      console.log(`ok  ${names.portable}`)
    }
    for (const file of [...present].sort()) {
      const delta = parseDeltaName(file)
      if (!delta || delta.to !== version || delta.platform !== platform) continue
      const fromPath = values.previous ? join(resolve(values.previous), `files-${delta.from}-${platform}.json`) : null
      const fromList = fromPath && existsSync(fromPath) ? contract.fileListSchema.parse(JSON.parse(readFileSync(fromPath, 'utf8'))) : undefined
      const manifest = await checkDelta(join(dir, file), { toList: list, toListBytes: listBytes, fromList, deltaManifestSchema: contract.deltaManifestSchema })
      console.log(`ok  ${file} (${manifest.changed.length} changed${fromList ? ', plan re-derived' : ''})`)
    }
    checkedPlatforms++
  }
  if (checkedPlatforms === 0) throw new Error(`no packages of ${version} in ${dir}`)

  if (values['no-feeds']) return
  let trusted
  if (values['nightly-keys']) trusted = await loadNightlyKeys()
  else if (values['production-keys']) trusted = await loadProductionKeys()
  else if (values.keys) trusted = JSON.parse(values.keys)
  else if (values['public-key']) trusted = [{ id: keyIdFor(values['public-key']), publicKey: values['public-key'] }]
  else throw new Error('pass --public-key, --keys or --production-keys (or --no-feeds)')
  const list = values['nightly-keys'] ? 'NIGHTLY_UPDATE_KEYS' : 'PRODUCTION_UPDATE_KEYS'
  if (trusted.length === 0) throw new Error(`no trusted keys: ${list} in apps/desktop/src/shared/updateKeys.ts is empty (run pnpm release:keygen)`)
  const feedDir = resolve(values.feeds ?? dir)
  // The nightly key may sign the nightly feed only; the production keys never verify it here.
  const feedPattern = values['nightly-keys'] ? /^update-nightly\.json$/ : /^update-(stable|beta)\.json$/
  const feeds = readdirSync(feedDir).filter((file) => feedPattern.test(file))
  if (feeds.length === 0) {
    if (values['feeds-optional']) { console.log('no feeds to verify (no channel takes this version)'); return }
    throw new Error(`no update-*.json feeds to verify in ${feedDir}`)
  }
  const urlPrefix = values['url-prefix'] ?? (values['nightly-keys'] ? nightlyAssetUrl('') : releaseAssetUrl(version, ''))
  for (const file of feeds) {
    const feed = checkFeed(join(feedDir, file), { dir, trusted, updateFeedSchema: contract.updateFeedSchema, feedSignatureSchema: contract.feedSignatureSchema, expectVersion: version, urlPrefix })
    console.log(`ok  ${file} (${feed.version}, ${Object.keys(feed.platforms).join(', ')}, signature verified)`)
  }
})
