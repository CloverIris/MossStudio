// Re-checks of built artifacts against each other, used by verify-artifacts.mjs and the tests.
// Every function throws on the first inconsistency with a message naming the file and entry.
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { forEachZipEntry, readZip } from './unzip.mjs'
import { asarPackageJsonFromBuffer, readSetupTar, readTar } from './inspect.mjs'
import { sha256Buffer, sha256File, symlinkTargetIsSafe } from './tree.mjs'
import { verifyFeed } from './sign.mjs'
import { DELTA_FILES_PREFIX, DELTA_MANIFEST, planDelta } from './delta.mjs'

const posixPlatform = (platform) => !platform.startsWith('win32')

/**
 * Compare a set of { path, kind: 'file'|'symlink', mode, data|target } with a FileList.
 * Directories are ignored. Every listed entry must be present and identical, and nothing else.
 */
export function compareWithFileList(label, entries, list) {
  const expected = new Map(list.entries.map((entry) => [entry.path, entry]))
  const seen = new Set()
  for (const entry of entries) {
    if (entry.kind === 'directory' || entry.kind === 'dir') continue
    const want = expected.get(entry.path)
    if (!want) throw new Error(`${label}: ${entry.path} is not in the file list`)
    if (seen.has(entry.path)) throw new Error(`${label}: ${entry.path} appears twice`)
    seen.add(entry.path)
    if (want.type === 'symlink') {
      if (entry.kind !== 'symlink') throw new Error(`${label}: ${entry.path} should be a symlink`)
      if (entry.target !== want.target) throw new Error(`${label}: ${entry.path} links to ${entry.target}, list says ${want.target}`)
    } else {
      if (entry.kind !== 'file') throw new Error(`${label}: ${entry.path} should be a regular file`)
      if (entry.data.length !== want.size || sha256Buffer(entry.data) !== want.sha256) throw new Error(`${label}: ${entry.path} content differs from the file list`)
      if (posixPlatform(list.platform) && entry.mode !== undefined && (entry.mode & 0o777) !== want.mode) {
        throw new Error(`${label}: ${entry.path} mode ${(entry.mode & 0o777).toString(8)}, list says ${want.mode.toString(8)}`)
      }
    }
  }
  const missing = list.entries.filter((entry) => !seen.has(entry.path))
  if (missing.length > 0) throw new Error(`${label}: ${missing.length} listed entries missing, e.g. ${missing[0].path}`)
}

/** Validate a FileList's own rules (schema done by the caller): sorted, unique, safe paths and links. */
export function checkFileList(list, { version, platform }) {
  if (list.version !== version || list.platform !== platform) throw new Error(`file list is for ${list.version} ${list.platform}, expected ${version} ${platform}`)
  let last = ''
  for (const entry of list.entries) {
    if (entry.path <= last) throw new Error(`file list not sorted/unique at ${entry.path}`)
    last = entry.path
    if (entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      throw new Error(`file list has an unsafe path: ${entry.path}`)
    }
    if (entry.type === 'symlink' && !symlinkTargetIsSafe(entry.path, entry.target)) throw new Error(`file list symlink escapes: ${entry.path} -> ${entry.target}`)
  }
}

/** Full zip vs FileList, plus the app version inside app.asar. */
export async function checkFullZip(zipPath, list) {
  const entries = []
  let asarVersion
  await forEachZipEntry(zipPath, async (entry) => {
    if (entry.kind === 'directory') return
    const data = await entry.read()
    if (entry.kind === 'symlink') entries.push({ path: entry.name, kind: 'symlink', target: data.toString('utf8') })
    else entries.push({ path: entry.name, kind: 'file', mode: entry.mode, data })
    if (/(^|\/)resources\/app\.asar$/i.test(entry.name) || /(^|\/)Contents\/Resources\/app\.asar$/.test(entry.name)) {
      asarVersion = asarPackageJsonFromBuffer(data).version
    }
  })
  compareWithFileList(basename(zipPath), entries, list)
  if (asarVersion !== list.version) throw new Error(`${basename(zipPath)}: app.asar says version ${asarVersion}, expected ${list.version}`)
}

/** Strip `prefix` from entry paths, dropping entries outside it. */
function under(entries, prefix) {
  return entries.filter((entry) => entry.path.startsWith(prefix)).map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }))
}

/** Windows/Linux setup file: valid trailer, app-<v>/ identical to the FileList, launcher present. */
export function checkSetupFile(path, list) {
  const os = list.platform.split('-')[0]
  const { stub, entries } = readSetupTar(path)
  const exe = os === 'win32' ? stub.subarray(0, 2).toString('latin1') === 'MZ' : stub.equals(Buffer.from('\x7fELF', 'latin1'))
  if (!exe) throw new Error(`${basename(path)}: the stub is not a ${os} executable`)
  const launcher = os === 'win32' ? 'MossStudio.exe' : 'mossstudio'
  const tops = new Set(entries.map((entry) => entry.name.split('/')[0]))
  if (tops.size !== 2 || !tops.has(launcher) || !tops.has(`app-${list.version}`)) throw new Error(`${basename(path)}: payload holds ${[...tops].join(', ')}`)
  const mapped = entries.map((entry) => ({ path: entry.name, kind: entry.type, mode: entry.mode, data: entry.data, target: entry.target }))
  compareWithFileList(basename(path), under(mapped, `app-${list.version}/`), list)
}

function checkPortableEntries(label, entries, list) {
  const os = list.platform.split('-')[0]
  const marker = entries.find((entry) => entry.path === 'MossStudio/portable.json')
  if (!marker) throw new Error(`${label}: MossStudio/portable.json missing`)
  const parsed = JSON.parse(marker.data.toString('utf8'))
  if (parsed.schema !== 1 || parsed.version !== list.version) throw new Error(`${label}: portable.json is ${marker.data}`)
  if (!entries.some((entry) => entry.path === 'MossStudio/data' && (entry.kind === 'dir' || entry.kind === 'directory'))) throw new Error(`${label}: MossStudio/data/ missing`)
  if (os === 'darwin') {
    const stray = entries.find((entry) => !['MossStudio', 'MossStudio/data', 'MossStudio/portable.json'].includes(entry.path) && !entry.path.startsWith('MossStudio/MossStudio.app'))
    if (stray) throw new Error(`${label}: unexpected entry ${stray.path}`)
    compareWithFileList(label, under(entries, 'MossStudio/MossStudio.app/'), list)
    return
  }
  const launcher = os === 'win32' ? 'MossStudio/MossStudio.exe' : 'MossStudio/mossstudio'
  const launcherEntry = entries.find((entry) => entry.path === launcher)
  if (!launcherEntry || launcherEntry.kind !== 'file') throw new Error(`${label}: ${launcher} missing`)
  if (os === 'linux' && (launcherEntry.mode & 0o111) === 0) throw new Error(`${label}: ${launcher} is not executable`)
  const app = under(entries, `MossStudio/app-${list.version}/`)
  compareWithFileList(label, app, list)
  const known = new Set(['MossStudio', 'MossStudio/data', 'MossStudio/portable.json', launcher, `MossStudio/app-${list.version}`])
  const stray = entries.find((entry) => !known.has(entry.path) && !entry.path.startsWith(`MossStudio/app-${list.version}/`))
  if (stray) throw new Error(`${label}: unexpected entry ${stray.path}`)
}

/** Portable zip (Windows, macOS) or tar.gz (Linux). */
export async function checkPortable(path, list) {
  const label = basename(path)
  let entries
  if (path.endsWith('.tar.gz')) {
    entries = readTar(gunzipSync(readFileSync(path))).map((entry) => ({ path: entry.name, kind: entry.type, mode: entry.mode, data: entry.data, target: entry.target }))
  } else {
    const zip = await readZip(path)
    entries = [...zip].map(([name, entry]) => ({
      path: name.replace(/\/$/, ''),
      kind: entry.kind,
      mode: entry.mode,
      data: entry.data,
      target: entry.kind === 'symlink' ? entry.data.toString('utf8') : undefined,
    }))
  }
  checkPortableEntries(label, entries, list)
}

/** Delta zip: manifest, hash of the target list, and contents; with `fromList` also the plan. */
export async function checkDelta(path, { toList, toListBytes, fromList, deltaManifestSchema }) {
  const label = basename(path)
  const zip = await readZip(path)
  const manifestEntry = zip.get(DELTA_MANIFEST)
  if (!manifestEntry) throw new Error(`${label}: ${DELTA_MANIFEST} missing`)
  const manifest = deltaManifestSchema.parse(JSON.parse(manifestEntry.data.toString('utf8')))
  if (manifest.to !== toList.version || manifest.platform !== toList.platform) throw new Error(`${label}: manifest is for ${manifest.to} ${manifest.platform}`)
  if (manifest.files.sha256 !== sha256Buffer(toListBytes) || manifest.files.size !== toListBytes.length) throw new Error(`${label}: built against a different file list`)
  const listed = new Map(toList.entries.map((entry) => [entry.path, entry]))
  const entries = []
  for (const [name, entry] of zip) {
    if (name === DELTA_MANIFEST || entry.kind === 'directory') continue
    if (!name.startsWith(DELTA_FILES_PREFIX)) throw new Error(`${label}: stray entry ${name}`)
    entries.push({ path: name.slice(DELTA_FILES_PREFIX.length), kind: entry.kind, mode: entry.mode, data: entry.data, target: entry.kind === 'symlink' ? entry.data.toString('utf8') : undefined })
  }
  const subset = { ...toList, entries: manifest.changed.map((p) => listed.get(p) ?? (() => { throw new Error(`${label}: changed path ${p} is not in the file list`) })()) }
  compareWithFileList(label, entries, subset)
  if (fromList) {
    if (fromList.version !== manifest.from) throw new Error(`${label}: from ${manifest.from}, previous list is ${fromList.version}`)
    const plan = planDelta(fromList, toList)
    if (JSON.stringify(plan.changed) !== JSON.stringify(manifest.changed) || JSON.stringify(plan.removed) !== JSON.stringify(manifest.removed)) {
      throw new Error(`${label}: changed/removed lists do not match the two file lists`)
    }
  }
  return manifest
}

/** Signature (against `trusted`), schema, and every asset against the files in `dir`. */
export function checkFeed(feedPath, { dir, trusted, updateFeedSchema, feedSignatureSchema, expectVersion, urlPrefix }) {
  const label = basename(feedPath)
  const bytes = readFileSync(feedPath)
  const sig = feedSignatureSchema.parse(JSON.parse(readFileSync(`${feedPath}.sig`, 'utf8')))
  if (!verifyFeed(bytes, sig, trusted)) throw new Error(`${label}: signature (keyId ${sig.keyId}) does not verify against the trusted keys`)
  const feed = updateFeedSchema.parse(JSON.parse(bytes.toString('utf8')))
  const channel = /^update-(stable|beta|nightly)\.json$/.exec(label)?.[1]
  if (feed.channel !== channel) throw new Error(`${label}: channel is ${feed.channel}`)
  if (expectVersion && feed.version !== expectVersion) throw new Error(`${label}: version ${feed.version}, expected ${expectVersion}`)
  const assets = []
  for (const [platform, entry] of Object.entries(feed.platforms)) {
    assets.push([platform, 'full', entry.full], [platform, 'files', entry.files])
    if (entry.setup) assets.push([platform, 'setup', entry.setup])
    if (entry.portable) assets.push([platform, 'portable', entry.portable])
    for (const delta of entry.deltas) assets.push([platform, `delta from ${delta.from}`, delta])
  }
  for (const [platform, kind, asset] of assets) {
    if (urlPrefix && !asset.url.startsWith(urlPrefix)) throw new Error(`${label}: ${platform} ${kind} URL ${asset.url} is not under ${urlPrefix}`)
    const file = decodeURIComponent(new URL(asset.url).pathname.split('/').pop())
    const path = `${dir}/${file}`
    let size
    try { size = statSync(path).size } catch { throw new Error(`${label}: ${platform} ${kind} ${file} is not among the artifacts`) }
    if (size !== asset.size || sha256File(path) !== asset.sha256) throw new Error(`${label}: ${platform} ${kind} ${file} does not match its size/sha256`)
  }
  return feed
}

/**
 * A feed currently published on the `updates` release, as fetch-previous.mjs downloads it. It
 * decides which channels a new release may replace, so it is trusted only when its signature
 * verifies against `trusted`, it parses, and it is the channel it claims to be. Throws otherwise.
 */
export function verifiedPublishedFeed(feedBytes, sigBytes, { channel, trusted, updateFeedSchema, feedSignatureSchema }) {
  if (!sigBytes) throw new Error(`published update-${channel}.json has no .sig`)
  const sig = feedSignatureSchema.parse(JSON.parse(Buffer.from(sigBytes).toString('utf8')))
  if (!verifyFeed(feedBytes, sig, trusted)) throw new Error(`published update-${channel}.json does not verify against the trusted keys (keyId ${sig.keyId})`)
  const feed = updateFeedSchema.parse(JSON.parse(Buffer.from(feedBytes).toString('utf8')))
  if (feed.channel !== channel) throw new Error(`published update-${channel}.json says channel ${feed.channel}`)
  return feed
}
