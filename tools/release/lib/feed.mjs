// Feed assembly (shared/install.ts updateFeedSchema) from built artifacts.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { artifactNames, compareVersions, isPrerelease, isVersion, parseDeltaName, parseVersion, PLATFORMS } from './version.mjs'
import { sha256File } from './tree.mjs'

/**
 * Which feeds a version goes to, and which it must leave alone. A prerelease targets beta
 * only; a stable release targets stable and beta. A target channel whose current feed already
 * carries the same or a newer version is skipped, so a backport tag (v1.0.9 after v1.1.0) or a
 * stable release older than the running beta never sends clients backwards.
 * Returns { channels, skipped: [{ channel, current }] }.
 */
export function channelsFor(version, { currentStable, currentBeta } = {}) {
  const targets = isPrerelease(version) ? ['beta'] : ['stable', 'beta']
  const current = { stable: currentStable, beta: currentBeta }
  const channels = []
  const skipped = []
  for (const channel of targets) {
    if (current[channel] && compareVersions(current[channel], version) >= 0) skipped.push({ channel, current: current[channel] })
    else channels.push(channel)
  }
  return { channels, skipped }
}

/**
 * Whether a nightly may replace the published update-nightly.json: only with a newer version, so
 * re-running an old build never sends nightly clients backwards. Returns null when it may, else why not.
 */
export function nightlySkipReason(version, currentNightly) {
  if (!isVersion(version) || parseVersion(version).pre[0] !== 'nightly') return `${version} is not a nightly version`
  if (currentNightly && compareVersions(currentNightly, version) >= 0) return `update-nightly.json keeps ${currentNightly} (not older than ${version})`
  return null
}

/** The in-app notes of a nightly: where it comes from and the commit subjects since the last one. */
export function nightlyNotes({ sha, repo, subjects, limit = 40 }) {
  const lines = [`每日构建，来自 \`main\` 的 [\`${sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${sha})。`]
  if (subjects.length) {
    lines.push('', ...subjects.slice(0, limit).map((subject) => `- ${subject}`))
    if (subjects.length > limit) lines.push(`- 以及另外 ${subjects.length - limit} 项改动`)
  }
  return lines.join('\n')
}

/**
 * Split release notes into front matter and body. Front matter is optional:
 *   ---
 *   minimumVersion: 1.0.0
 *   ---
 */
export function parseNotes(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  const meta = {}
  let body = normalized
  if (match) {
    body = normalized.slice(match[0].length)
    for (const line of match[1].split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue
      const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/.exec(line)
      if (!kv) throw new Error(`release notes front matter: cannot read "${line}"`)
      meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
    }
  }
  const allowed = new Set(['minimumVersion'])
  for (const key of Object.keys(meta)) if (!allowed.has(key)) throw new Error(`release notes front matter: unknown key ${key}`)
  if (meta.minimumVersion !== undefined && !isVersion(meta.minimumVersion)) throw new Error(`minimumVersion is not a version: ${meta.minimumVersion}`)
  return { meta, body: body.trim() }
}

function assetFor(dir, file, urlFor) {
  const path = join(dir, file)
  return { url: urlFor(file), sha256: sha256File(path), size: statSync(path).size }
}

/**
 * The `platforms` map for `version` from the files in `dir`. A platform is included when its
 * full package and file list exist; setup, portable and deltas are added when present.
 */
export function describePlatforms(dir, version, urlFor) {
  const present = new Set(readdirSync(dir))
  const platforms = {}
  for (const platform of PLATFORMS) {
    const names = artifactNames(version, platform)
    if (!present.has(names.full) || !present.has(names.files)) continue
    const entry = { full: assetFor(dir, names.full, urlFor), files: assetFor(dir, names.files, urlFor), deltas: [] }
    if (present.has(names.setup)) entry.setup = assetFor(dir, names.setup, urlFor)
    if (present.has(names.portable)) entry.portable = assetFor(dir, names.portable, urlFor)
    for (const file of [...present].sort()) {
      const delta = parseDeltaName(file)
      if (delta && delta.to === version && delta.platform === platform) entry.deltas.push({ from: delta.from, ...assetFor(dir, file, urlFor) })
    }
    entry.deltas.sort((a, b) => compareVersions(b.from, a.from))
    platforms[platform] = entry
  }
  return platforms
}

/** Announcements still current at `now` (entries whose `until` has passed are dropped). */
export function currentAnnouncements(list, now = new Date()) {
  return (list ?? []).filter((item) => !item.until || Date.parse(item.until) > now.getTime())
}

export function assembleFeed({ channel, version, publishedAt, notes = '', notesUrl, minimumVersion, platforms, announcements = [] }) {
  if (Object.keys(platforms).length === 0) throw new Error(`no platform packages found for ${version}`)
  if (minimumVersion && compareVersions(minimumVersion, version) > 0) throw new Error(`minimumVersion ${minimumVersion} is above the release ${version}`)
  const feed = { schema: 1, channel, version, publishedAt, notes }
  if (notesUrl) feed.notesUrl = notesUrl
  if (minimumVersion) feed.minimumVersion = minimumVersion
  feed.platforms = platforms
  feed.announcements = announcements
  return feed
}

/** The exact bytes that are signed and uploaded. */
export function feedBytes(feed) {
  return Buffer.from(`${JSON.stringify(feed, null, 2)}\n`, 'utf8')
}

export function readNotes(notesDir, version, { required }) {
  const path = join(notesDir, `${version}.md`)
  if (!existsSync(path)) {
    if (required) throw new Error(`release notes missing: ${path}`)
    return { meta: {}, body: '' }
  }
  return parseNotes(readFileSync(path, 'utf8'))
}
