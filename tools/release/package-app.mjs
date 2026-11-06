#!/usr/bin/env node
// Package the built app (apps/desktop/out, from `pnpm build`) with @electron/packager.
//
//   node tools/release/package-app.mjs [--platform linux-x64] [--version 1.2.3 ...] [--out dist/release/app]
//
// Output: <out>/<version>/<platform>/ holding the app folder's contents (Windows/Linux: what
// becomes R/app-<version>/) or MossStudio.app (macOS). Several --version values stamp the
// same build under each version (the integration test needs X, X+1 and X+2 of one build).
//
// Run it on the target OS: dugite downloads the host's git during the production install
// (npm_config_arch is honoured, so darwin-x64 can be packaged on an arm64 Mac), and macOS
// bundles can only be signed and turned into a DMG on macOS.
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, posix, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { packager } from '@electron/packager'
import { DESKTOP_DIR, DIST_DIR, hostPlatform, main, readJson, REPO_ROOT, run } from './lib/cli.mjs'
import { signApp } from './lib/signing.mjs'
import { walkTree } from './lib/tree.mjs'
import { isVersion, splitPlatform } from './lib/version.mjs'

const BUNDLE_ID = 'com.cloveriris.mossstudio'
const ICON_PNG = join(DESKTOP_DIR, 'src', 'renderer', 'public', 'mossstudio-icon.png')
const ICON_ICO = join(DESKTOP_DIR, 'src', 'renderer', 'public', 'mossstudio-icon.ico')
const ICON_ICNS = join(DESKTOP_DIR, 'build', 'mossstudio-icon.icns')
/** Shipped next to app.asar (process.resourcesPath); read by main/lib/content.ts. */
const RESOURCES = [join(DESKTOP_DIR, 'resources', 'models.json'), join(DESKTOP_DIR, 'resources', 'rules.json')]

/** pnpm, as the release script was started with (`pnpm release:package`), else pnpm on PATH. */
function pnpmCommand(args) {
  const execPath = process.env.npm_execpath
  if (execPath && /pnpm/i.test(execPath)) {
    return /\.(c?js|mjs)$/i.test(execPath) ? [process.execPath, [execPath, ...args]] : [execPath, args]
  }
  if (process.platform === 'win32') throw new Error('run this through pnpm (pnpm release:package) so pnpm can be located')
  return ['pnpm', args]
}

/**
 * pnpm materializes dugite's git with its ~150 `git-*` commands as hard links to one binary
 * (upstream they are symlinks). Copying turns each into a full 4 MB copy, and zips, setup
 * payloads and FileLists have no hard links. So the groups of hard-linked files under the
 * unpacked dugite folder are recorded here (paths relative to node_modules) and, after
 * packaging, every extra name becomes a relative symlink to the first one (relinkUnpacked).
 * Only on disk (app.asar.unpacked): packager's copy would turn symlinks in the app source into
 * absolute links, which asar rejects.
 */
function hardlinkGroups(modules) {
  const groups = new Map()
  for (const item of walkTree(join(modules, 'dugite', 'git'), 'dugite/git/')) {
    if (item.type !== 'file') continue
    const st = lstatSync(item.abs)
    if (st.nlink < 2) continue
    const key = `${st.dev}:${st.ino}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item.path)
  }
  return [...groups.values()].filter((paths) => paths.length > 1).map((paths) => paths.sort())
}

function relinkUnpacked(resourcesDir, groups) {
  const base = join(resourcesDir, 'app.asar.unpacked', 'node_modules')
  let replaced = 0
  for (const [first, ...rest] of groups) {
    for (const path of rest) {
      const link = join(base, ...path.split('/'))
      if (!existsSync(link)) throw new Error(`expected unpacked file ${link}`)
      rmSync(link)
      symlinkSync(posix.relative(posix.dirname(path), first), link)
      replaced++
    }
  }
  if (replaced > 0) console.log(`replaced ${replaced} hard-linked copies with symlinks`)
}

/** A staging copy of the app with production node_modules installed flat (hoisted, not pnpm's symlink farm). */
function stageApp(tempDir, { os, arch }) {
  const workspace = join(tempDir, 'workspace')
  const workspaceDesktop = join(workspace, 'apps', 'desktop')
  mkdirSync(workspaceDesktop, { recursive: true })
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) copyFileSync(join(REPO_ROOT, name), join(workspace, name))
  copyFileSync(join(DESKTOP_DIR, 'package.json'), join(workspaceDesktop, 'package.json'))
  const [command, args] = pnpmCommand(['--filter', '@clover/desktop', 'install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted'])
  // npm_config_arch makes dugite fetch git for the target arch (darwin-x64 built on arm64).
  run(command, args, { cwd: workspace, env: { ...process.env, npm_config_arch: arch } })

  const source = join(tempDir, 'app')
  mkdirSync(source, { recursive: true })
  cpSync(join(DESKTOP_DIR, 'out'), join(source, 'out'), { recursive: true })
  const modules = join(workspace, 'node_modules')
  cpSync(modules, join(source, 'node_modules'), {
    recursive: true,
    dereference: true,
    filter: (path) => {
      const first = relative(modules, path).split(sep)[0]
      return first !== '.pnpm' && first !== '.bin'
    },
  })
  const links = os === 'win32' ? [] : hardlinkGroups(modules)
  const desktop = readJson(join(DESKTOP_DIR, 'package.json'))
  const appRequire = createRequire(join(source, 'package.json'))
  for (const dependency of Object.keys(desktop.dependencies ?? {})) appRequire.resolve(dependency)
  return { source, desktop, links }
}

function writeAppPackage(source, desktop, version) {
  const pkg = { ...desktop, version }
  delete pkg.devDependencies
  delete pkg.scripts
  writeFileSync(join(source, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

/** macOS icon: the checked-in .icns if there is one, else generated from the PNG with sips + iconutil. */
function macIcon(tempDir) {
  if (existsSync(ICON_ICNS)) return ICON_ICNS
  const iconset = join(tempDir, 'mossstudio.iconset')
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    run('sips', ['-z', String(size), String(size), ICON_PNG, '--out', join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' })
    if (size <= 256) run('sips', ['-z', String(size * 2), String(size * 2), ICON_PNG, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' })
  }
  const icns = join(tempDir, 'mossstudio.icns')
  run('iconutil', ['-c', 'icns', iconset, '-o', icns])
  return icns
}

async function packageApp({ platform, versions, out }) {
  const { os, arch } = splitPlatform(platform)
  if (!existsSync(join(DESKTOP_DIR, 'out', 'main', 'index.js'))) throw new Error('apps/desktop/out is missing: run `pnpm build` first')
  for (const file of RESOURCES) if (!existsSync(file)) throw new Error(`resource missing: ${file}`)
  if (os === 'darwin' && process.platform !== 'darwin') throw new Error('macOS packages must be built on macOS (codesign, hdiutil)')
  if (platform !== hostPlatform()) console.warn(`note: packaging ${platform} on ${hostPlatform()}; dugite's git is the host's, so this package is for pipeline checks only`)

  const tempDir = mkdtempSync(join(tmpdir(), 'moss-package-'))
  try {
    const { source, desktop, links } = stageApp(tempDir, { os, arch })
    const electronVersion = readJson(join(DESKTOP_DIR, 'node_modules', 'electron', 'package.json')).version
    const icon = os === 'win32' ? ICON_ICO : os === 'darwin' ? macIcon(tempDir) : undefined
    const results = []
    for (const version of versions) {
      writeAppPackage(source, desktop, version)
      // Packager output goes next to the final folder so the rename stays on one filesystem.
      const packagerOut = join(out, `.packager-${version}-${platform}`)
      rmSync(packagerOut, { recursive: true, force: true })
      const [appDir] = await packager({
        dir: source,
        out: packagerOut,
        name: 'MossStudio',
        executableName: 'MossStudio',
        platform: os,
        arch,
        electronVersion,
        appVersion: version,
        buildVersion: version,
        appBundleId: BUNDLE_ID,
        appCategoryType: 'public.app-category.graphics-design',
        appCopyright: `Copyright © ${new Date().getFullYear()} CloverIris`,
        win32metadata: { CompanyName: 'CloverIris', ProductName: 'MossStudio', FileDescription: 'MossStudio', InternalName: 'MossStudio', OriginalFilename: 'MossStudio.exe' },
        icon,
        asar: { unpack: '**/{.**,**}/**/*.node', unpackDir: 'node_modules/dugite/git' },
        prune: false,
        derefSymlinks: true,
        overwrite: true,
        quiet: true,
        extraResource: RESOURCES,
      })
      if (!appDir) throw new Error('electron packager returned no app folder')
      const target = join(out, version, platform)
      rmSync(target, { recursive: true, force: true })
      mkdirSync(join(out, version), { recursive: true })
      relinkUnpacked(os === 'darwin' ? join(appDir, 'MossStudio.app', 'Contents', 'Resources') : join(appDir, 'resources'), links)
      if (os === 'darwin') {
        mkdirSync(target)
        renameSync(join(appDir, 'MossStudio.app'), join(target, 'MossStudio.app'))
        signApp({ os, appPath: join(target, 'MossStudio.app') })
      } else {
        renameSync(appDir, target)
        if (os !== 'win32') chmodSync(target, 0o755) // packager's temp folder is 0700
        signApp({ os, appPath: target })
      }
      rmSync(packagerOut, { recursive: true, force: true })
      checkPackage(target, os, version)
      results.push(target)
      console.log(`packaged ${platform} ${version}: ${target}`)
    }
    return results
  } finally {
    const resolved = resolve(tempDir)
    if (resolved.startsWith(resolve(tmpdir()) + sep)) rmSync(resolved, { recursive: true, force: true })
  }
}

/** The packaged folder holds what the launcher, installer and updater rely on. */
function checkPackage(target, os, version) {
  const resources = os === 'darwin' ? join(target, 'MossStudio.app', 'Contents', 'Resources') : join(target, 'resources')
  const exe = os === 'win32' ? join(target, 'MossStudio.exe') : os === 'linux' ? join(target, 'MossStudio') : join(target, 'MossStudio.app', 'Contents', 'MacOS', 'MossStudio')
  for (const path of [exe, join(resources, 'app.asar'), join(resources, 'models.json'), join(resources, 'rules.json')]) {
    if (!existsSync(path)) throw new Error(`packaged app lacks ${path}`)
  }
  if (os === 'darwin') {
    const plist = readFileSync(join(target, 'MossStudio.app', 'Contents', 'Info.plist'), 'utf8')
    if (!plist.includes(`<string>${BUNDLE_ID}</string>`)) throw new Error('Info.plist lacks the bundle id')
    if (!plist.includes(`<string>${version}</string>`)) throw new Error('Info.plist lacks the version')
  }
  if (readdirSync(target).length === 0) throw new Error(`empty package ${target}`)
}

main(async () => {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string', default: hostPlatform() },
      version: { type: 'string', multiple: true },
      out: { type: 'string', default: join(DIST_DIR, 'app') },
    },
  })
  const versions = values.version?.length ? values.version : [readJson(join(DESKTOP_DIR, 'package.json')).version]
  for (const version of versions) if (!isVersion(version)) throw new Error(`not a version: ${version}`)
  await packageApp({ platform: values.platform, versions, out: resolve(values.out) })
})
