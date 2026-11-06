#!/usr/bin/env node
// Build delta packages from earlier versions to this one.
//
//   node tools/release/make-deltas.mjs --version 1.2.3 --previous <dir> [--artifacts dist/release/artifacts]
//        [--platform linux-x64 ...]
//
// <dir> holds earlier releases' files-<from>-<platform>.json (fetch-previous.mjs downloads
// them). For each of those whose platform has a new full package in --artifacts, this writes
// MossStudio-<from>-to-<v>-<platform>.delta.zip next to it. A delta that would not be smaller
// than the full package is dropped: clients would download the full package anyway.
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DIST_DIR, main } from './lib/cli.mjs'
import { writeDelta } from './lib/delta.mjs'
import { artifactNames, compareVersions, deltaName, isVersion, PLATFORMS } from './lib/version.mjs'

main(async () => {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      previous: { type: 'string' },
      artifacts: { type: 'string', default: join(DIST_DIR, 'artifacts') },
      platform: { type: 'string', multiple: true },
    },
  })
  const version = values.version
  if (!isVersion(version)) throw new Error('--version <semver> is required')
  if (!values.previous) throw new Error('--previous <dir> is required')
  const artifacts = resolve(values.artifacts)
  const previous = resolve(values.previous)
  const platforms = values.platform?.length ? values.platform : PLATFORMS
  const present = new Set(readdirSync(artifacts))
  let built = 0
  for (const file of readdirSync(previous).sort()) {
    const match = /^files-(.+)-(win32-x64|linux-x64|darwin-arm64|darwin-x64)\.json$/.exec(file)
    if (!match || !isVersion(match[1]) || !platforms.includes(match[2])) continue
    const [, from, platform] = match
    if (compareVersions(from, version) >= 0) continue
    const names = artifactNames(version, platform)
    if (!present.has(names.full) || !present.has(names.files)) continue
    const fromList = JSON.parse(readFileSync(join(previous, file), 'utf8'))
    if (fromList.version !== from || fromList.platform !== platform) throw new Error(`${file} describes ${fromList.version} ${fromList.platform}`)
    const filesJson = readFileSync(join(artifacts, names.files))
    const toList = JSON.parse(filesJson.toString('utf8'))
    const outPath = join(artifacts, deltaName(from, version, platform))
    const manifest = await writeDelta({ from: fromList, to: toList, filesJson, fullZip: join(artifacts, names.full), outPath, mtime: new Date() })
    const deltaSize = statSync(outPath).size
    const fullSize = statSync(join(artifacts, names.full)).size
    if (deltaSize >= fullSize) {
      rmSync(outPath)
      console.log(`skipped ${from} → ${version} ${platform}: delta (${deltaSize} B) is not smaller than full (${fullSize} B)`)
      continue
    }
    built++
    console.log(`${outPath}: ${manifest.changed.length} changed, ${manifest.removed.length} removed, ${deltaSize} B (full ${fullSize} B)`)
  }
  console.log(`${built} delta package(s) built`)
})
