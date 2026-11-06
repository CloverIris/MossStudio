#!/usr/bin/env node
// Assemble update-<channel>.json for a version from the built artifacts.
//
//   node tools/release/make-feed.mjs --version 1.2.3 [--artifacts dist/release/artifacts]
//        [--out <dir, default = artifacts>] [--current-stable update-stable.json] [--current-beta update-beta.json]
//        [--base-url http://127.0.0.1:8080/] [--channel stable ...] [--require-notes]
//
// Notes: release/notes/<version>.md (optional front matter `minimumVersion: x.y.z`).
// Announcements: release/announcements.json (optional array; expired `until` entries dropped).
// Channels: a prerelease goes to beta only, a stable release to stable and beta; a channel
// whose current feed (--current-stable / --current-beta) is the same or newer is left alone.
// --channel overrides that (tests). --base-url replaces the GitHub
// release download URL (tests serve the artifacts locally).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DIST_DIR, main, REPO_ROOT } from './lib/cli.mjs'
import { assembleFeed, channelsFor, currentAnnouncements, describePlatforms, feedBytes, readNotes } from './lib/feed.mjs'
import { feedName, isVersion, RELEASE_REPO, releaseAssetUrl } from './lib/version.mjs'

main(async () => {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      artifacts: { type: 'string', default: join(DIST_DIR, 'artifacts') },
      out: { type: 'string' },
      'current-stable': { type: 'string' },
      'current-beta': { type: 'string' },
      'base-url': { type: 'string' },
      channel: { type: 'string', multiple: true },
      'notes-dir': { type: 'string', default: join(REPO_ROOT, 'release', 'notes') },
      announcements: { type: 'string', default: join(REPO_ROOT, 'release', 'announcements.json') },
      'require-notes': { type: 'boolean', default: false },
      'published-at': { type: 'string' },
    },
  })
  const version = values.version
  if (!isVersion(version)) throw new Error('--version <semver> is required')
  const artifacts = resolve(values.artifacts)
  const out = resolve(values.out ?? artifacts)
  mkdirSync(out, { recursive: true })

  const baseUrl = values['base-url']
  const urlFor = baseUrl ? (file) => new URL(encodeURIComponent(file), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href : (file) => releaseAssetUrl(version, file)
  const notes = readNotes(resolve(values['notes-dir']), version, { required: values['require-notes'] })
  const announcements = existsSync(values.announcements) ? currentAnnouncements(JSON.parse(readFileSync(values.announcements, 'utf8'))) : []
  // The live feeds (fetch-previous.mjs downloads and signature-checks them).
  const currentOf = (option) => {
    const path = values[option]
    if (!path || !existsSync(path)) return undefined
    const current = JSON.parse(readFileSync(path, 'utf8')).version
    if (!isVersion(current)) throw new Error(`--${option} holds no version: ${path}`)
    return current
  }
  const routed = channelsFor(version, { currentStable: currentOf('current-stable'), currentBeta: currentOf('current-beta') })
  const channels = values.channel?.length ? values.channel : routed.channels
  if (!values.channel?.length) {
    for (const { channel, current } of routed.skipped) console.log(`${channel}: keeps ${current} (not older than ${version}); update-${channel}.json is not replaced`)
  }
  const platforms = describePlatforms(artifacts, version, urlFor)
  const publishedAt = values['published-at'] ?? new Date().toISOString()

  for (const channel of channels) {
    if (channel !== 'stable' && channel !== 'beta') throw new Error(`unknown channel ${channel}`)
    const feed = assembleFeed({
      channel,
      version,
      publishedAt,
      notes: notes.body,
      notesUrl: baseUrl ? undefined : `https://github.com/${RELEASE_REPO}/releases/tag/v${version}`,
      minimumVersion: notes.meta.minimumVersion,
      platforms,
      announcements,
    })
    const path = join(out, feedName(channel))
    writeFileSync(path, feedBytes(feed))
    console.log(`${path}: ${version} for ${Object.keys(platforms).join(', ')}`)
  }
  if (channels.length === 0) console.log(`no feed written: ${version} is not newer than any channel`)
})
