#!/usr/bin/env node
// Real install → update → rollback → uninstall test on this OS, against the fixtures that
// prepare.mjs built (versions X, X+1, X+2 of one test build).
//
//   node tools/release/integration/run.mjs [--platform linux-x64] [--dir dist/it] [--report <dir>]
//        [--work <parent of the test folder; default <dir>/<platform>/run, never os.tmpdir()>]
//
//  1. silent-install X into a fresh folder whose path has spaces and Chinese characters
//     (Windows/Linux: the setup file; macOS: the app on the mounted DMG)
//  2. write the test control file and start the installed app (launcher; macOS: open -n)
//  3. the app confirms health, finds X+1 in the local signed feed, downloads it (a delta),
//     restarts; assert X+1 runs and install.json has current=X+1, previous=X, confirmed
//  4. the feed moves to X+2, which the control file makes exit non-zero at start; assert the
//     rollback: current=X+1 running again and X+2 in `failed`
//  5. silent uninstall; assert the temp launcher really ran the plan: the program files, record,
//     locator and integration are gone while data/ and a file the user put in R survive, and
//     (Windows/Linux) kept-data.json notes the kept data
//  6. Linux: silent-install X again into that folder; assert it is accepted and its data/ reused
// The user-profile locations the installer writes (locator, .desktop, shortcuts) are pointed
// at a sandbox through HOME/XDG_*/LOCALAPPDATA/APPDATA, except on macOS: there the swap helper
// relaunches with `open` (LaunchServices drops the environment), so the real home is used and
// the test refuses to run when a MossStudio install already exists.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, cpSync, mkdtempSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { hostPlatform, main, REPO_ROOT } from '../lib/cli.mjs'
import { artifactNames, splitPlatform } from '../lib/version.mjs'
import { startUpdateServer } from './server.mjs'

/** Read by test builds only (see the updater's test hook): drives the update without UI. */
const CONTROL_FILE = 'moss-test.json'
const POLL_MS = 500

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function log(message) {
  console.log(`[it ${new Date().toISOString().slice(11, 19)}] ${message}`)
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

async function waitFor(label, timeoutMs, check) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await check()
    if (last?.ok) {
      log(`${label}: ok after ${Math.round((Date.now() - started) / 1000)} s`)
      return last
    }
    await sleep(POLL_MS)
  }
  throw new Error(`${label}: timed out after ${timeoutMs / 1000} s (last: ${JSON.stringify(last?.state ?? last)})`)
}

/** Executables of running processes, as absolute paths. */
function processes(os) {
  if (os === 'linux') {
    const out = []
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      try {
        out.push({ pid: Number(pid), exe: readlinkSync(`/proc/${pid}/exe`) })
      } catch {
        // gone, or not ours
      }
    }
    return out
  }
  if (os === 'darwin') {
    const ps = spawnSync('ps', ['-axww', '-o', 'pid=,comm='], { encoding: 'utf8' })
    return ps.stdout.split('\n').map((line) => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(Boolean).map((m) => ({ pid: Number(m[1]), exe: m[2] }))
  }
  const env = { ...process.env }
  delete env.PSModulePath // Windows PowerShell 5.1 started from pwsh 7 cannot load its modules otherwise
  const ps = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)" }'],
  { encoding: 'utf8', env, windowsHide: true })
  return ps.stdout.split(/\r?\n/).map((line) => /^(\d+)\t(.+)$/.exec(line)).filter(Boolean).map((m) => ({ pid: Number(m[1]), exe: m[2] }))
}

function under(path, root) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  return norm(path).startsWith(norm(root.endsWith(sep) ? root : root + sep))
}

function processesUnder(os, root) {
  return processes(os).filter((p) => under(p.exe, root))
}

async function killUnder(os, root) {
  for (let round = 0; round < 20; round++) {
    const running = processesUnder(os, root)
    if (running.length === 0) return
    for (const { pid } of running) {
      if (os === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      else try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await sleep(500)
  }
  throw new Error(`processes under ${root} survive kill: ${JSON.stringify(processesUnder(os, root))}`)
}

function listTree(dir, depth = 2, prefix = '') {
  if (!existsSync(dir)) return [`${prefix}(missing ${dir})`]
  const lines = []
  for (const name of readdirSync(dir).sort()) {
    lines.push(`${prefix}${name}`)
    const full = join(dir, name)
    try {
      if (depth > 0 && !name.startsWith('app-') && readdirSync(full)) lines.push(...listTree(full, depth - 1, `${prefix}  `))
    } catch {
      // a file
    }
  }
  return lines
}

function plistVersion(bundle) {
  const r = spawnSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

function runChecked(label, file, args, options) {
  log(`${label}: ${file} ${args.join(' ')}`)
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 10 * 60_000, windowsHide: true, ...options })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${label} exited with ${r.status ?? r.signal}`)
}

main(async () => {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string', default: hostPlatform() },
      dir: { type: 'string', default: join(REPO_ROOT, 'dist', 'it') },
      report: { type: 'string' },
      work: { type: 'string' },
    },
  })
  const { platform } = values
  const { os } = splitPlatform(platform)
  const base = join(resolve(values.dir), platform)
  const fixtures = readJsonOrNull(join(base, 'versions.json'))
  if (!fixtures) throw new Error(`run prepare.mjs first (${join(base, 'versions.json')} is missing)`)
  const [x, x1, x2] = fixtures.versions
  const artifacts = join(base, 'artifacts')

  // Not under os.tmpdir(): the installer (rightly) refuses folders the system cleans up.
  const workParent = resolve(values.work ?? join(base, 'run'))
  mkdirSync(workParent, { recursive: true })
  const work = realpathSync.native(mkdtempSync(join(workParent, 'moss-it-')))
  const R = join(work, 'Moss Studio 测试', '安装 目录')
  const sandbox = join(work, 'home 用户')
  mkdirSync(sandbox, { recursive: true })
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  if (os === 'linux') {
    // The X server (xvfb) is the display under test, also when run from a Wayland desktop.
    delete env.WAYLAND_DISPLAY
    delete env.XDG_SESSION_TYPE
  }
  if (os === 'linux') Object.assign(env, { HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, '.config'), XDG_DATA_HOME: join(sandbox, '.local', 'share') })
  if (os === 'win32') Object.assign(env, { LOCALAPPDATA: join(sandbox, 'Local'), APPDATA: join(sandbox, 'Roaming') })
  const home = os === 'linux' ? sandbox : homedir()
  const macSupport = join(homedir(), 'Library', 'Application Support', 'MossStudio')
  const dataRoot = os === 'darwin' ? macSupport : join(R, 'data')
  const recordPath = os === 'darwin' ? join(macSupport, 'install.json') : join(R, 'install.json')
  const locator = os === 'win32' ? join(env.LOCALAPPDATA, 'MossStudio', 'locator.json') : os === 'linux' ? join(env.XDG_CONFIG_HOME, 'MossStudio', 'locator.json') : join(macSupport, 'locator.json')
  const launcher = os === 'win32' ? join(R, 'MossStudio.exe') : join(R, 'mossstudio')
  const bundle = join(R, 'MossStudio.app')
  if (os === 'darwin' && (existsSync(macSupport) || existsSync('/Applications/MossStudio.app'))) {
    throw new Error(`${macSupport} or /Applications/MossStudio.app exists: run this test on a clean (CI) Mac only`)
  }

  const server = await startUpdateServer({ filesDir: artifacts, feedDir: join(base, 'feeds', x1), log: (line) => log(`http ${line}`) })
  const record = () => readJsonOrNull(recordPath)
  const running = (version) => processesUnder(os, os === 'darwin' ? bundle : join(R, `app-${version}`)).length > 0
  const diagnostics = () => {
    console.log('---- install folder ----')
    console.log(listTree(R).join('\n'))
    console.log('---- install.json ----')
    console.log(JSON.stringify(record(), null, 2))
    console.log('---- processes under the install folder ----')
    console.log(JSON.stringify(processesUnder(os, R), null, 2))
    console.log('---- uninstall helpers still running (temp launcher copies, dialogs) ----')
    console.log(JSON.stringify(processes(os).filter((p) => /MossStudio-uninstall-|[\\/]zenity$|[\\/]kdialog$/.test(p.exe)), null, 2))
    for (const name of ['moss-test-status.json']) {
      const status = readJsonOrNull(join(dataRoot, name))
      if (status) console.log(`---- ${name} ----\n${JSON.stringify(status, null, 2)}`)
    }
    if (values.report) {
      mkdirSync(values.report, { recursive: true })
      for (const dir of [join(dataRoot, 'logs'), join(sandbox, '.config', 'MossStudio')]) {
        if (existsSync(dir)) cpSync(dir, join(values.report, dir.split(sep).slice(-2).join('-')), { recursive: true })
      }
      writeFileSync(join(values.report, 'requests.json'), JSON.stringify(server.requests, null, 2))
      writeFileSync(join(values.report, 'tree.txt'), listTree(R, 4).join('\n'))
    }
  }

  let child
  try {
    // 1. Silent install of X.
    const names = artifactNames(x, platform)
    if (os === 'darwin') {
      const mount = join(work, 'dmg mount')
      mkdirSync(mount)
      runChecked('attach', 'hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, join(artifacts, names.setup)])
      try {
        runChecked('silent install', join(mount, 'MossStudio.app', 'Contents', 'MacOS', 'MossStudio'), ['--moss-silent', `--moss-install-to=${R}`], { env })
      } finally {
        spawnSync('hdiutil', ['detach', mount, '-force'], { stdio: 'inherit' })
      }
    } else {
      runChecked('silent install', join(artifacts, names.setup), ['--moss-silent', `--moss-install-to=${R}`], { env })
    }
    const installed = record()
    if (!installed || installed.current !== x || installed.portable !== false) throw new Error(`install.json after install: ${JSON.stringify(installed)}`)
    if (!existsSync(locator)) throw new Error(`locator missing: ${locator}`)
    if (os !== 'darwin' && (!existsSync(launcher) || !existsSync(join(R, `app-${x}`)))) throw new Error('launcher or app folder missing after install')
    if (os === 'darwin' && plistVersion(bundle) !== x) throw new Error(`installed bundle is ${plistVersion(bundle)}`)
    if (os === 'linux' && !existsSync(join(env.XDG_DATA_HOME, 'applications', 'mossstudio.desktop'))) throw new Error('mossstudio.desktop missing')
    log(`installed ${x} into ${R}`)

    // 2. Control file + first start.
    mkdirSync(dataRoot, { recursive: true })
    writeFileSync(join(dataRoot, CONTROL_FILE), JSON.stringify({ pollMs: 2000, crashVersions: [x2] }))
    const userFile = join(R, 'notes of the user 用户.txt')
    writeFileSync(userFile, 'not ours: uninstall must keep this')
    writeFileSync(join(dataRoot, 'user-work.txt'), 'data must survive an uninstall that keeps data')
    if (os === 'darwin') {
      runChecked('launch', '/usr/bin/open', ['-n', bundle])
    } else {
      child = spawn(launcher, [], { env, cwd: R, stdio: 'inherit', windowsHide: false })
      child.on('exit', (code) => log(`launcher exited with ${code}`))
    }

    // The installed app really starts from the launcher and confirms its health.
    await waitFor(`first start of ${x}`, 2 * 60_000, () => {
      const r = record()
      return { ok: r?.confirmed === true && (r.current === x || r.previous === x), state: r && { current: r.current, confirmed: r.confirmed } }
    })

    // 3. Update to X+1.
    await waitFor(`update ${x} → ${x1}`, 5 * 60_000, () => {
      const r = record()
      const ok = r?.current === x1 && r.previous === x && r.confirmed === true && !r.pending && running(x1) && (os !== 'darwin' || plistVersion(bundle) === x1)
      return { ok, state: r && { current: r.current, previous: r.previous, pending: r.pending, confirmed: r.confirmed, failed: r.failed } }
    })
    const fetched = server.requests.map((request) => request.path)
    const viaDelta = fetched.some((path) => path.includes(encodeURIComponent(`MossStudio-${x}-to-${x1}-${platform}.delta.zip`)))
    const viaFull = fetched.some((path) => path.includes(encodeURIComponent(artifactNames(x1, platform).full)))
    if (!viaDelta && !viaFull) throw new Error('X+1 was installed without downloading a package from the test server')
    log(`X+1 came as ${viaDelta ? 'delta' : 'full package'}`)
    if (os === 'darwin' && !existsSync(join(R, `.MossStudio-${x}.app.previous`))) throw new Error('previous bundle not kept')

    // 4. X+2 crashes at start → rollback to X+1.
    server.setFeedDir(join(base, 'feeds', x2))
    await waitFor(`rollback ${x2} → ${x1}`, 6 * 60_000, () => {
      const r = record()
      const ok = r?.current === x1 && (r.failed ?? []).includes(x2) && r.confirmed === true && !r.pending && running(x1) && (os !== 'darwin' || plistVersion(bundle) === x1)
      return { ok, state: r && { current: r.current, previous: r.previous, pending: r.pending, confirmed: r.confirmed, failed: r.failed } }
    })
    if (!server.requests.some((request) => request.path.includes(encodeURIComponent(x2)))) throw new Error('X+2 was never downloaded')

    // 5. Silent uninstall (data kept).
    await killUnder(os, R)
    if (child && child.exitCode === null) child.kill()
    if (os === 'darwin') {
      runChecked('silent uninstall', join(bundle, 'Contents', 'MacOS', 'MossStudio'), ['--moss-uninstall', '--moss-silent'], { env })
      await waitFor('bundle removed', 2 * 60_000, () => ({ ok: !existsSync(bundle) }))
    } else {
      runChecked('silent uninstall', launcher, ['--uninstall', '--moss-silent'], { env })
      await waitFor('uninstall finished', 3 * 60_000, () => {
        const left = existsSync(R) ? readdirSync(R) : []
        return { ok: !left.some((name) => name.startsWith('app-') || name === 'install.json' || name === 'MossStudio.exe' || name === 'mossstudio'), state: left }
      })
    }
    const left = readdirSync(R).sort()
    const expected = os === 'darwin' ? [userFile.split(sep).pop()].sort() : ['data', userFile.split(sep).pop()].sort()
    if (JSON.stringify(left) !== JSON.stringify(expected)) throw new Error(`after uninstall the install folder holds ${JSON.stringify(left)}, expected ${JSON.stringify(expected)}`)
    if (!existsSync(join(dataRoot, 'user-work.txt'))) throw new Error('user data was removed although it was to be kept')
    if (existsSync(locator)) throw new Error(`locator survives: ${locator}`)
    if (os === 'linux' && existsSync(join(env.XDG_DATA_HOME, 'applications', 'mossstudio.desktop'))) throw new Error('mossstudio.desktop survives')
    if (os === 'win32') {
      const reg = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MossStudio'], { stdio: 'ignore', windowsHide: true })
      if (reg.status === 0) throw new Error('the Uninstall registry key survives')
      if (existsSync(join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'MossStudio.lnk'))) throw new Error('Start menu shortcut survives')
    }
    if (os !== 'darwin') {
      // The kept data is noted beside the (removed) locator, for a later Setup to offer.
      const kept = readJsonOrNull(join(locator, '..', 'kept-data.json'))
      if (kept?.dataRoot !== dataRoot || kept?.root !== R) throw new Error(`kept-data.json after uninstall: ${JSON.stringify(kept)}`)
    }
    if (os === 'linux') {
      // 6. Reinstall into the folder the uninstall left: accepted, and its data/ is used as it is.
      // (Linux only: on Windows it would leave a real HKCU Uninstall entry behind.)
      runChecked('silent reinstall', join(artifacts, names.setup), ['--moss-silent', `--moss-install-to=${R}`], { env })
      const again = record()
      if (again?.current !== x || again.dataRoot !== dataRoot) throw new Error(`install.json after reinstall: ${JSON.stringify(again)}`)
      if (!existsSync(join(dataRoot, 'user-work.txt'))) throw new Error('the kept data was not reused by the reinstall')
      if (existsSync(join(locator, '..', 'kept-data.json'))) throw new Error('kept-data.json survives the reinstall')
      log(`reinstalled ${x} into ${R}, keeping its data`)
    }
    log(`PASS: installed ${x}, updated to ${x1}, rolled back from ${x2}, uninstalled (home: ${home})`)
  } catch (error) {
    diagnostics()
    throw error
  } finally {
    await killUnder(os, R).catch(() => undefined)
    await server.close()
    if (os === 'darwin') rmSync(macSupport, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})
