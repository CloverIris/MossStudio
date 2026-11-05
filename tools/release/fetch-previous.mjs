#!/usr/bin/env node
// Download what the publish job needs from earlier releases on GitHub:
//   - files-<from>-<platform>.json of the delta bases (2 newest stable releases below
//     --version; for a prerelease also the newest earlier prerelease), into --out
//   - the current update-stable.json and update-beta.json of the rolling `updates` release,
//     signature-checked against PRODUCTION_UPDATE_KEYS, as --out/current-update-<channel>.json
// Releases without file lists (the 1.0.x line) are skipped: they get no delta.
//
//   GITHUB_TOKEN=... node tools/release/fetch-previous.mjs --version 1.2.3 --out <dir> [--repo owner/name]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { main } from './lib/cli.mjs'
import { loadInstallContract, loadProductionKeys } from './lib/contract.mjs'
import { verifiedPublishedFeed } from './lib/verify.mjs'
import { deltaBases } from './lib/delta.mjs'
import { compareVersions, isPrerelease, isVersion, PLATFORMS, RELEASE_REPO } from './lib/version.mjs'

function headers(accept) {
  const out = { 'User-Agent': 'mossstudio-release', Accept: accept }
  if (process.env.GITHUB_TOKEN) out.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return out
}

async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers: headers('application/vnd.github+json') })
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

async function download(asset) {
  const response = await fetch(asset.url, { headers: headers('application/octet-stream'), redirect: 'follow' })
  if (!response.ok) throw new Error(`download ${asset.name}: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

main(async () => {
  const { values } = parseArgs({ options: { version: { type: 'string' }, out: { type: 'string' }, repo: { type: 'string', default: RELEASE_REPO } } })
  if (!isVersion(values.version)) throw new Error('--version <semver> is required')
  if (!values.out) throw new Error('--out <dir> is required')
  const out = resolve(values.out)
  mkdirSync(out, { recursive: true })

  const releases = []
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/repos/${values.repo}/releases?per_page=100&page=${page}`)
    releases.push(...batch)
    if (batch.length < 100) break
  }
  const byVersion = new Map()
  for (const release of releases) {
    const version = /^v(.+)$/.exec(release.tag_name)?.[1]
    if (release.draft || !version || !isVersion(version)) continue
    byVersion.set(version, release)
  }
  const bases = deltaBases(values.version, [...byVersion.keys()], { compare: compareVersions, isPrerelease })
  console.log(`delta bases for ${values.version}: ${bases.join(', ') || '(none)'}`)
  for (const base of bases) {
    const assets = byVersion.get(base).assets
    for (const platform of PLATFORMS) {
      const name = `files-${base}-${platform}.json`
      const asset = assets.find((item) => item.name === name)
      if (!asset) { console.log(`  ${base} ${platform}: no file list, no delta`); continue }
      writeFileSync(join(out, name), await download(asset))
      console.log(`  ${name}`)
    }
  }

  // The live feeds decide which channels this release may replace (make-feed --current-*),
  // so they count only when their signature verifies against the production keys.
  const updates = releases.find((release) => release.tag_name === 'updates')
  const contract = await loadInstallContract()
  const trusted = await loadProductionKeys()
  for (const channel of ['stable', 'beta']) {
    const feedAsset = updates?.assets.find((item) => item.name === `update-${channel}.json`)
    if (!feedAsset) { console.log(`  no published update-${channel}.json`); continue }
    const sigAsset = updates.assets.find((item) => item.name === `update-${channel}.json.sig`)
    const bytes = await download(feedAsset)
    const feed = verifiedPublishedFeed(bytes, sigAsset ? await download(sigAsset) : null, { channel, trusted, updateFeedSchema: contract.updateFeedSchema, feedSignatureSchema: contract.feedSignatureSchema })
    writeFileSync(join(out, `current-update-${channel}.json`), bytes)
    console.log(`  current update-${channel}.json: ${feed.version} (signature verified)`)
  }
})
