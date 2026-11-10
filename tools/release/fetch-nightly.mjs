#!/usr/bin/env node
// Download what a nightly's publish job needs from the last nightly, all on the `updates` release:
//   - its file lists files-<previous>-<platform>.json, into --out, so make-deltas.mjs builds deltas
//     from the nightly clients most likely run
//   - update-nightly.json, signature-checked against NIGHTLY_UPDATE_KEYS, as
//     --out/current-update-nightly.json (make-feed --current-nightly)
// Without an earlier nightly's packages there is no delta.
//
//   GITHUB_TOKEN=... node tools/release/fetch-nightly.mjs --out <dir> [--repo owner/name]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { main } from './lib/cli.mjs'
import { loadInstallContract, loadNightlyKeys } from './lib/contract.mjs'
import { verifiedPublishedFeed } from './lib/verify.mjs'
import { isNightly, isVersion, RELEASE_REPO, UPDATES_TAG } from './lib/version.mjs'

function headers(accept) {
  const out = { 'User-Agent': 'mossstudio-release', Accept: accept }
  if (process.env.GITHUB_TOKEN) out.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return out
}

async function release(repo, tag) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: headers('application/vnd.github+json'),
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`release ${tag}: ${response.status} ${await response.text()}`)
  return response.json()
}

async function download(asset) {
  const response = await fetch(asset.url, {
    headers: headers('application/octet-stream'),
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`download ${asset.name}: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

main(async () => {
  const { values } = parseArgs({ options: { out: { type: 'string' }, repo: { type: 'string', default: RELEASE_REPO } } })
  if (!values.out) throw new Error('--out <dir> is required')
  const out = resolve(values.out)
  mkdirSync(out, { recursive: true })

  const updates = await release(values.repo, UPDATES_TAG)
  const lists = (updates?.assets ?? []).filter((asset) => {
    const version = /^files-(.+)-(win32-x64|linux-x64|darwin-arm64|darwin-x64)\.json$/.exec(asset.name)?.[1]
    return Boolean(version && isVersion(version) && isNightly(version))
  })
  if (lists.length === 0) console.log('no nightly file lists on the updates release: no deltas')
  for (const asset of lists) {
    writeFileSync(join(out, asset.name), await download(asset))
    console.log(`  ${asset.name}`)
  }

  const trusted = await loadNightlyKeys()
  if (trusted.length === 0) {
    console.log('NIGHTLY_UPDATE_KEYS is empty: no published nightly feed can be trusted')
    return
  }
  const feedAsset = updates?.assets.find((item) => item.name === 'update-nightly.json')
  if (!feedAsset) {
    console.log('  no published update-nightly.json')
    return
  }
  const sigAsset = updates.assets.find((item) => item.name === 'update-nightly.json.sig')
  const bytes = await download(feedAsset)
  const contract = await loadInstallContract()
  const feed = verifiedPublishedFeed(bytes, sigAsset ? await download(sigAsset) : null, {
    channel: 'nightly',
    trusted,
    updateFeedSchema: contract.updateFeedSchema,
    feedSignatureSchema: contract.feedSignatureSchema,
  })
  writeFileSync(join(out, 'current-update-nightly.json'), bytes)
  console.log(`  current update-nightly.json: ${feed.version} (signature verified)`)
})
