#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const root = fileURLToPath(new URL('../', import.meta.url))
const releaseDir = join(root, 'release')
const desktopDir = join(root, 'apps', 'desktop')
const tempDir = await mkdtemp(join(tmpdir(), 'mossstudio-release-'))
const manifestPath = join(releaseDir, 'manifest.json')
const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const artifactsDir = join(releaseDir, 'artifacts')
let finalized = false

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function validVersion(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
}

async function writeManifest(manifest) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function publicReleaseReadme() {
  const readme = await readFile(join(releaseDir, 'README.md'), 'utf8')
  return `${readme.replace(/\r?\n## 发布与更新（维护者）[\s\S]*$/, '').trimEnd()}\n`
}

function generateReleaseMarkdown() {
  const result = spawnSync(process.execPath, [join(root, 'tools', 'release-md.mjs')], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  assert(result.status === 0, 'Release Markdown generation failed.')
}

async function sha256(file) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolvePromise)
      .on('error', rejectPromise)
  })
  return hash.digest('hex')
}

function installProductionDependencies(workspaceDir) {
  const pnpmExecutable = process.env.npm_execpath
  assert(pnpmExecutable, 'Run the Release build through pnpm so the locked package manager can be reused.')
  const result = spawnSync(
    process.execPath,
    [
      pnpmExecutable,
      '--filter',
      '@clover/desktop',
      'install',
      '--prod',
      '--frozen-lockfile',
      '--config.node-linker=hoisted',
    ],
    {
      cwd: workspaceDir,
      stdio: 'inherit',
      windowsHide: true,
    },
  )
  if (result.error) throw result.error
  assert(result.status === 0, 'Installing locked production dependencies for packaging failed.')
}

async function preparePackagerApp(stagingWorkspaceDir, desktopPackage) {
  const stagingDesktopDir = join(stagingWorkspaceDir, 'apps', 'desktop')
  const packagedAppDir = join(tempDir, 'app')
  const runtimeModulesDir = join(stagingWorkspaceDir, 'node_modules')

  await mkdir(stagingDesktopDir, { recursive: true })
  await Promise.all([
    copyFile(join(root, 'package.json'), join(stagingWorkspaceDir, 'package.json')),
    copyFile(join(root, 'pnpm-lock.yaml'), join(stagingWorkspaceDir, 'pnpm-lock.yaml')),
    copyFile(join(root, 'pnpm-workspace.yaml'), join(stagingWorkspaceDir, 'pnpm-workspace.yaml')),
    copyFile(join(desktopDir, 'package.json'), join(stagingDesktopDir, 'package.json')),
  ])
  installProductionDependencies(stagingWorkspaceDir)

  await mkdir(packagedAppDir, { recursive: true })
  const packagedPackage = { ...desktopPackage }
  delete packagedPackage.devDependencies
  delete packagedPackage.scripts
  await writeFile(join(packagedAppDir, 'package.json'), `${JSON.stringify(packagedPackage, null, 2)}\n`, 'utf8')
  await cp(join(desktopDir, 'out'), join(packagedAppDir, 'out'), { recursive: true })
  await cp(runtimeModulesDir, join(packagedAppDir, 'node_modules'), {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const relativePath = relative(runtimeModulesDir, source)
      const firstSegment = relativePath.split(sep)[0]
      return firstSegment !== '.pnpm' && firstSegment !== '.bin'
    },
  })

  const runtimeRequire = createRequire(join(packagedAppDir, 'package.json'))
  for (const dependency of Object.keys(desktopPackage.dependencies ?? {})) {
    runtimeRequire.resolve(dependency)
  }
  createRequire(runtimeRequire.resolve('yauzl')).resolve('pend')
  const dugiteRequire = createRequire(runtimeRequire.resolve('dugite'))
  dugiteRequire.resolve('progress')
  dugiteRequire.resolve('tar-stream')
  return packagedAppDir
}

// Windows PowerShell 5.1 started from PowerShell 7 (the default shell of GitHub's
// Windows runners) inherits 7's PSModulePath and then cannot load its own built-in
// modules (`Get-FileHash` is "not recognized"). Without the variable it uses its defaults.
function windowsPowerShellEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]
  return env
}

function buildSetupInstaller(version, payload) {
  const script = join(root, 'installer', 'build.ps1')
  assert(existsSync(script), 'installer/build.ps1 is missing.')
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Version',
      version,
      '-Payload',
      payload,
      '-OutDir',
      artifactsDir,
    ],
    { cwd: root, env: windowsPowerShellEnv(), encoding: 'utf8', windowsHide: true },
  )
  if (result.error) throw result.error
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (result.status !== 0) throw new Error(`Building the setup installer failed:\n${output}`)
  const read = (key) => output.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()
  const path = read('setup')
  const digest = read('sha256')
  const size = Number(read('size'))
  assert(path && existsSync(path), `Setup installer was not produced:\n${output}`)
  assert(/^[a-f0-9]{64}$/.test(digest ?? ''), `Setup installer sha256 is invalid:\n${output}`)
  assert(Number.isSafeInteger(size) && size > 0, `Setup installer size is invalid:\n${output}`)
  return { path, sha256: digest, size }
}

function createZip(sourceDir, destination) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '[IO.Compression.ZipFile]::CreateFromDirectory($env:MOSS_RELEASE_SOURCE, $env:MOSS_RELEASE_ZIP, [IO.Compression.CompressionLevel]::Optimal, $false)',
  ].join('; ')
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      cwd: root,
      env: windowsPowerShellEnv({
        MOSS_RELEASE_SOURCE: sourceDir,
        MOSS_RELEASE_ZIP: destination,
      }),
      stdio: 'inherit',
      windowsHide: true,
    },
  )
  if (result.error) throw result.error
  assert(result.status === 0, 'Creating the release ZIP failed.')
}

try {
  assert(process.platform === 'win32' && process.arch === 'x64', 'The local release builder currently requires Windows x64.')
  const desktopPackage = JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf8'))
  const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const version = originalManifest.app?.version
  assert(validVersion(version), `Invalid release version: ${version}`)
  assert(desktopPackage.version === version, `Version mismatch: desktop=${desktopPackage.version}, release=${version}`)
  assert(rootPackage.version === version, `Version mismatch: root=${rootPackage.version}, release=${version}`)
  assert(desktopPackage.productName === 'MossStudio', 'desktop package productName must be MossStudio.')
  assert(originalManifest.app?.channel === 'stable', 'This local package must use the stable update channel.')

  // The asset URL must use the tag the release is actually published under. Tags are
  // written by hand, and this repo has shipped both `<version>` and `v<version>`
  // (`v1.0.1` produced a 404 download URL in the 1.0.1 release document), so read the
  // tag from `notes_url` — which must point at the real release page — instead of
  // assuming a `v` prefix.
  const releaseTag = String(originalManifest.app?.notes_url ?? '').match(/\/tag\/([^/?#]+)/)?.[1] ?? version
  assert(releaseTag.length > 0, 'Release tag is empty: set app.notes_url to the real release page.')
  const assetName = `MossStudio-${version}-win32-x64.zip`
  const assetUrl = `https://github.com/CloverIris/MossStudio/releases/download/${releaseTag}/${assetName}`
  const iconPath = join(desktopDir, 'src', 'renderer', 'public', 'mossstudio-icon.ico')
  const electronPackage = JSON.parse(
    await readFile(join(desktopDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
  )
  const stagingWorkspaceDir = join(tempDir, 'workspace')
  const packagedReleaseDir = join(tempDir, 'release')
  const packagedOutputDir = join(tempDir, 'packages')
  const artifactPath = join(artifactsDir, assetName)

  await mkdir(packagedReleaseDir, { recursive: true })
  await mkdir(artifactsDir, { recursive: true })

  const embeddedManifest = {
    ...originalManifest,
    installers: [],
    assets: [],
  }
  await writeManifest(embeddedManifest)
  generateReleaseMarkdown()
  for (const name of ['manifest.json', 'models.json', 'release.md', 'rules.json', 'updater.ps1']) {
    await copyFile(join(releaseDir, name), join(packagedReleaseDir, name))
  }
  await writeFile(join(packagedReleaseDir, 'README.md'), await publicReleaseReadme(), 'utf8')

  const packagedAppSourceDir = await preparePackagerApp(stagingWorkspaceDir, desktopPackage)
  const appDirs = await packager({
    dir: packagedAppSourceDir,
    out: packagedOutputDir,
    name: 'MossStudio',
    platform: 'win32',
    arch: 'x64',
    electronVersion: electronPackage.version,
    icon: iconPath,
    asar: {
      unpack: '**/{.**,**}/**/*.node',
      unpackDir: 'node_modules/dugite/git',
    },
    prune: false,
    derefSymlinks: true,
    overwrite: true,
    extraResource: packagedReleaseDir,
  })
  const packagedAppDir = appDirs[0]
  assert(packagedAppDir, 'Electron Packager did not return an application directory.')
  const executable = join(packagedAppDir, 'MossStudio.exe')
  assert((await stat(executable)).isFile(), 'Packaged executable is missing.')
  assert((await stat(join(packagedAppDir, 'resources', 'app.asar'))).isFile(), 'Packaged resources/app.asar is missing.')
  assert((await stat(join(packagedAppDir, 'resources', 'release', 'updater.ps1'))).isFile(), 'Packaged updater is missing.')

  await rm(artifactPath, { force: true })
  createZip(packagedAppDir, artifactPath)
  const artifactStat = await stat(artifactPath)
  assert(artifactStat.size > 0, 'Release ZIP is empty.')

  const installer = {
    platform: 'win32',
    arch: 'x64',
    kind: 'zip',
    url: assetUrl,
    sha256: await sha256(artifactPath),
    size_bytes: artifactStat.size,
  }

  // Self-extracting setup: the installer exe carries the portable ZIP as its
  // payload, so it is built after the ZIP and recorded as a second asset.
  const setup = buildSetupInstaller(version, artifactPath)
  const setupInstaller = {
    platform: 'win32',
    arch: 'x64',
    kind: 'exe',
    url: `${assetUrl.slice(0, assetUrl.lastIndexOf('/') + 1)}MossStudio-Setup-${version}-x64.exe`,
    sha256: setup.sha256,
    size_bytes: setup.size,
  }
  const installers = (originalManifest.installers ?? []).filter(
    (item) =>
      item.platform !== installer.platform ||
      item.arch !== installer.arch ||
      (item.kind !== 'zip' && item.kind !== 'exe'),
  )
  const finalManifest = {
    ...originalManifest,
    installers: [...installers, installer, setupInstaller],
  }
  await writeManifest(finalManifest)
  generateReleaseMarkdown()
  await copyFile(join(releaseDir, 'release.md'), join(artifactsDir, 'release.md'))
  await writeFile(join(artifactsDir, 'README.md'), await publicReleaseReadme(), 'utf8')
  finalized = true

  console.log(`Release package: ${artifactPath}`)
  console.log(`Setup installer: ${setup.path}`)
  console.log(`Release metadata: ${join(artifactsDir, 'release.md')}`)
  console.log(`ZIP SHA-256: ${installer.sha256}`)
  console.log(`Setup SHA-256: ${setupInstaller.sha256}`)
  console.log(`Size: ${installer.size_bytes} + ${setupInstaller.size_bytes} bytes`)
} finally {
  if (!finalized) {
    await writeManifest(originalManifest)
    generateReleaseMarkdown()
  }
  const resolvedTemp = resolve(tempDir)
  const resolvedRoot = resolve(tmpdir())
  assert(resolvedTemp.startsWith(`${resolvedRoot}${sep}`), `Refusing to remove unexpected temporary path: ${resolvedTemp}`)
  await rm(resolvedTemp, { recursive: true, force: true })
}
