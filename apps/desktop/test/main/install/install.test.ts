/**
 * The whole setup flow on real folders: a fake stub payload, the controller as silent mode
 * drives it (--moss-silent --moss-install-to), and fake OS executors for reg.exe, shortcuts
 * and ditto. Runs the Windows integration on Windows and the Linux one elsewhere.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installRecordSchema } from '@shared/install'
import { SetupController, keptDataInstall, legacyView, type SetupEnvironment } from '@main/install/controller'
import { performInstall, reintegrateMovedInstall, type InstallDeps } from '@main/install/install'
import { keptDataPath, linuxDesktopFile, locatorPath, type HostInfo, type OsPlatform } from '@main/install/layout'
import { readInstallRecord, readJsonObject, readKeptData, readLocator } from '@main/install/record'
import type { ExecFile } from '@main/install/registry'
import { detectRunContext } from '@main/install/runContext'
import type { ShortcutOptions } from '@main/install/integration'
import { buildUninstallPlan, listRoot, noteKeptData } from '@main/install/uninstall'
import { useWorkDir } from './helpers'

const work = useWorkDir()
const platform: OsPlatform = process.platform === 'win32' ? 'win32' : 'linux'
const exe = platform === 'win32' ? 'MossStudio.exe' : 'MossStudio'
const launcherFile = platform === 'win32' ? 'MossStudio.exe' : 'mossstudio'
const posix = process.platform !== 'win32'

function host(): HostInfo {
  const w = work()
  return {
    platform,
    home: join(w, 'home'),
    env: {
      LOCALAPPDATA: join(w, 'local'),
      APPDATA: join(w, 'roaming'),
      XDG_CONFIG_HOME: join(w, 'config'),
      XDG_DATA_HOME: join(w, 'share'),
      SystemRoot: 'C:\\Windows',
    },
  }
}

/** What the stub extracts: app-<v>/ (with a nested tree, and a symlink on POSIX) and the launcher. */
function makePayload(version: string): string {
  const payload = join(work(), `payload-${version}`)
  if (existsSync(payload)) return payload
  const app = join(payload, `app-${version}`)
  mkdirSync(join(app, 'resources'), { recursive: true })
  mkdirSync(join(app, 'locales'))
  writeFileSync(join(app, exe), `electron ${version}`, { mode: 0o755 })
  writeFileSync(join(app, 'resources', 'app.asar'), Buffer.alloc(2048, 1))
  writeFileSync(join(app, 'resources', 'models.json'), '{"models":[]}')
  writeFileSync(join(app, 'locales', 'zh-CN.pak'), 'pak')
  if (posix) symlinkSync('libffmpeg.so', join(app, 'libffmpeg.so.link'))
  writeFileSync(join(app, 'libffmpeg.so'), 'so', { mode: 0o644 })
  writeFileSync(join(payload, launcherFile), `launcher ${version}`, { mode: 0o755 })
  return payload
}

interface Harness {
  env: SetupEnvironment
  regCalls: string[][]
  shortcuts: Array<{ path: string; options: ShortcutOptions }>
  logs: string[]
  events: Array<{ kind: string; payload: unknown }>
}

function harness(version: string, root: string, extraArgs: string[] = []): Harness {
  const payload = makePayload(version)
  const h = host()
  const regCalls: string[][] = []
  const shortcuts: Array<{ path: string; options: ShortcutOptions }> = []
  const logs: string[] = []
  const events: Array<{ kind: string; payload: unknown }> = []
  const exec: ExecFile = async (_file, args) => {
    regCalls.push(args)
    return { code: args[0] === 'export' ? 1 : 0, stdout: '', stderr: '' }
  }
  const context = detectRunContext({
    argv: ['MossStudio', `--moss-setup=${payload}`, '--moss-silent', `--moss-install-to=${root}`, ...extraArgs],
    env: h.env,
    execPath: join(payload, `app-${version}`, exe),
    packaged: true,
    platform,
    arch: 'x64',
    home: h.home,
    exists: existsSync,
    readText: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
  })
  const env: SetupEnvironment = {
    context,
    host: h,
    version,
    tempDir: tmpdir(),
    registry: platform === 'win32' ? { exec, env: h.env } : null,
    install: {
      exec,
      spawnLines: async () => 1,
      writeShortcut: (path, _operation, options) => {
        shortcuts.push({ path, options })
        writeFileSync(path, 'lnk')
        return true
      },
      desktopDir: join(work(), 'Desktop'),
      iconBytes: () => Buffer.from('png'),
      now: () => new Date('2026-11-05T08:00:00.000Z'),
      log: (line) => logs.push(line),
    },
    emit: (kind, payload) => events.push({ kind, payload }),
    logPath: join(work(), 'MossStudio-setup.log'),
  }
  return { env, regCalls, shortcuts, logs, events }
}

async function silentInstall(h: Harness) {
  const controller = await SetupController.create(h.env)
  controller.start(controller.silentStartInput())
  const result = await controller.completion()
  return { controller, result }
}

describe('silent install (first install)', () => {
  it('copies app-<v>, places the launcher, writes install.json and the locator, integrates', async () => {
    const root = join(work(), '程序 文件', 'MossStudio')
    const h = harness('2.0.0', root)
    const { controller, result } = await silentInstall(h)
    expect(controller.state.kind).toBe('first')
    expect(controller.state.phase).toBe('done')
    expect(controller.state.logPath).toBe(join(work(), 'MossStudio-setup.log'))
    expect(result.warnings).toEqual([])

    // Files
    const app = join(root, 'app-2.0.0')
    expect(readFileSync(join(app, exe), 'utf8')).toBe('electron 2.0.0')
    expect(readFileSync(join(app, 'resources', 'app.asar')).length).toBe(2048)
    expect(readFileSync(join(app, 'locales', 'zh-CN.pak'), 'utf8')).toBe('pak')
    if (posix) {
      expect(readlinkSync(join(app, 'libffmpeg.so.link'))).toBe('libffmpeg.so')
      expect(lstatSync(join(app, exe)).mode & 0o777).toBe(0o755)
      expect(lstatSync(join(root, launcherFile)).mode & 0o777).toBe(0o755)
    }
    expect(readFileSync(join(root, launcherFile), 'utf8')).toBe('launcher 2.0.0')
    expect(readdirSync(root).sort()).toEqual(['app-2.0.0', 'data', 'install.json', launcherFile].sort())

    // Record and locator
    const record = installRecordSchema.parse(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8')))
    expect(record).toMatchObject({
      schema: 1,
      platform: platform === 'win32' ? 'win32-x64' : 'linux-x64',
      root,
      dataRoot: join(root, 'data'),
      portable: false,
      channel: 'stable',
      current: '2.0.0',
      failed: [],
      confirmed: false,
      installedAt: '2026-11-05T08:00:00.000Z',
    })
    expect(record.previous).toBeUndefined()
    expect(readLocator(locatorPath(h.env.host))).toEqual({ schema: 1, root, dataRoot: join(root, 'data'), version: '2.0.0' })

    // Integration
    if (platform === 'win32') {
      const adds = h.regCalls.filter((args) => args[0] === 'add')
      expect(adds.map((args) => args[3])).toEqual([
        'DisplayName',
        'DisplayVersion',
        'Publisher',
        'InstallLocation',
        'DisplayIcon',
        'UninstallString',
        'QuietUninstallString',
        'EstimatedSize',
        'NoModify',
        'NoRepair',
      ])
      expect(adds.find((args) => args[3] === 'UninstallString')?.[7]).toBe(`"${join(root, launcherFile)}" --uninstall`)
      expect(h.shortcuts.map((item) => item.options.appUserModelId)).toEqual(['com.cloveriris.mossstudio', 'com.cloveriris.mossstudio'])
      expect(h.shortcuts.every((item) => item.options.target === join(root, launcherFile))).toBe(true)
    } else {
      expect(h.regCalls).toEqual([])
      const desktop = readFileSync(linuxDesktopFile(h.env.host), 'utf8')
      expect(desktop).toContain(`Exec="${join(root, launcherFile)}" %U`)
    }

    // Progress went from prepare to done, and done was announced.
    const phases = h.events.filter((event) => event.kind === 'progress').map((event) => (event.payload as { phase: string }).phase)
    expect(phases[0]).toBe('prepare')
    expect(phases).toContain('copy')
    expect(phases.at(-1)).toBe('done')
    expect(h.events.at(-1)).toMatchObject({ kind: 'done', payload: { root, version: '2.0.0' } })
  })

  it('refuses a location the rules reject and changes nothing', async () => {
    const occupied = join(work(), 'occupied')
    mkdirSync(occupied)
    writeFileSync(join(occupied, 'mine.txt'), 'mine')
    const h = harness('2.0.0', occupied)
    const controller = await SetupController.create(h.env)
    expect(() => controller.start(controller.silentStartInput())).toThrow(expect.objectContaining({ code: 'E_NOT_EMPTY' }))
    expect(readdirSync(occupied)).toEqual(['mine.txt'])
  })

  it('fails cleanly when the payload is incomplete', async () => {
    const root = join(work(), 'R')
    const h = harness('2.0.0', root)
    const payload = h.env.context.setup!.payloadDir!
    rmSync(join(payload, launcherFile))
    const controller = await SetupController.create(h.env)
    controller.start(controller.silentStartInput())
    await expect(controller.completion()).rejects.toMatchObject({ code: 'E_NO_PAYLOAD' })
    expect(controller.state).toMatchObject({ phase: 'failed', error: { code: 'E_NO_PAYLOAD' } })
    expect(existsSync(join(root, 'app-2.0.0.partial'))).toBe(false)
    expect(existsSync(join(root, 'install.json'))).toBe(false)
  })
})

describe('later installs (locator found)', () => {
  it('installs a newer version side by side: current moves to previous, unknown keys survive', async () => {
    const root = join(work(), 'R 安装')
    await silentInstall(harness('2.0.0', root))
    const recordFile = join(root, 'install.json')
    writeFileSync(
      recordFile,
      JSON.stringify({ ...readJsonObject(recordFile), confirmed: true, failed: ['2.1.0'], launcherState: { tries: 1 } }),
    )

    const h = harness('2.1.0', root)
    const { controller } = await silentInstall(h)
    expect(controller.state.kind).toBe('update')
    expect(controller.state.launcherLogPath).toBeNull()
    expect(controller.state.installed).toEqual({ root, dataRoot: join(root, 'data'), version: '2.0.0' })
    const record = readInstallRecord(recordFile)!
    expect(record).toMatchObject({
      current: '2.1.0',
      previous: '2.0.0',
      confirmed: false,
      failed: [],
      installedAt: '2026-11-05T08:00:00.000Z',
    })
    expect(readJsonObject(recordFile)?.['launcherState']).toEqual({ tries: 1 })
    expect(existsSync(join(root, 'app-2.0.0'))).toBe(true)
    expect(existsSync(join(root, 'app-2.1.0'))).toBe(true)
    expect(readFileSync(join(root, launcherFile), 'utf8')).toBe('launcher 2.1.0')
    expect(readLocator(locatorPath(h.env.host))?.version).toBe('2.1.0')
  })

  it('repairs the same version in place', async () => {
    const root = join(work(), 'R')
    await silentInstall(harness('2.0.0', root))
    writeFileSync(join(root, 'app-2.0.0', exe), 'damaged')
    const { controller } = await silentInstall(harness('2.0.0', root))
    expect(controller.state.kind).toBe('repair')
    expect(readFileSync(join(root, 'app-2.0.0', exe), 'utf8')).toBe('electron 2.0.0')
    expect(readdirSync(root).filter((name) => name.includes('replaced') || name.includes('partial'))).toEqual([])
  })

  it('asks before a downgrade (interactive), silent mode allows it', async () => {
    const root = join(work(), 'R')
    await silentInstall(harness('2.1.0', root))
    const h = harness('2.0.0', root)
    const controller = await SetupController.create(h.env)
    expect(controller.state.kind).toBe('downgrade')
    expect(() => controller.start({ root })).toThrow(expect.objectContaining({ code: 'E_DOWNGRADE' }))
    controller.start({ root, allowDowngrade: true })
    await controller.completion()
    expect(readInstallRecord(join(root, 'install.json'))).toMatchObject({ current: '2.0.0', previous: '2.1.0' })
  })
})

describe('MossStudio still running', () => {
  it('refuses to replace an existing install while the app runs (failed state, 重试 works once it is closed)', async () => {
    const root = join(work(), 'R')
    await silentInstall(harness('2.0.0', root))
    const h = harness('2.1.0', root)
    let running = true
    h.env.appRunning = () => running
    const controller = await SetupController.create(h.env)
    expect(controller.start(controller.silentStartInput())).toMatchObject({ phase: 'failed', error: { code: 'E_APP_RUNNING' } })
    expect(h.events.at(-1)).toMatchObject({ kind: 'failed', payload: { code: 'E_APP_RUNNING' } })
    expect(existsSync(join(root, 'app-2.1.0'))).toBe(false)
    running = false
    controller.start(controller.silentStartInput())
    await controller.completion()
    expect(existsSync(join(root, 'app-2.1.0'))).toBe(true)
  })

  it('does not ask on a first install into a fresh folder', async () => {
    const h = harness('2.0.0', join(work(), 'fresh'))
    h.env.appRunning = () => true
    const { controller } = await silentInstall(h)
    expect(controller.state.phase).toBe('done')
  })
})

describe('roots that are not ours', () => {
  it('refuses a portable folder and a folder whose install.json is not an install record', async () => {
    const portable = join(work(), 'portable')
    mkdirSync(portable)
    writeFileSync(join(portable, 'portable.json'), JSON.stringify({ schema: 1, version: '2.0.0' }))
    const p = await SetupController.create(harness('2.0.0', portable).env)
    expect(() => p.start(p.silentStartInput())).toThrow(expect.objectContaining({ code: 'E_PORTABLE_ROOT' }))

    const foreign = join(work(), 'foreign')
    mkdirSync(foreign)
    writeFileSync(join(foreign, 'install.json'), JSON.stringify({ name: 'some other app' }))
    const f = await SetupController.create(harness('2.0.0', foreign).env)
    expect(f.state.location).toMatchObject({
      ok: false,
      kind: 'occupied',
      problem: { code: 'E_NOT_EMPTY' },
      suggestion: join(foreign, 'MossStudio'),
    })
    expect(() => f.start(f.silentStartInput())).toThrow(expect.objectContaining({ code: 'E_NOT_EMPTY' }))
    expect(JSON.parse(readFileSync(join(foreign, 'install.json'), 'utf8'))).toEqual({ name: 'some other app' })
  })

  it('performInstall itself refuses them too (no location check in between)', async () => {
    const h = harness('2.0.0', join(work(), 'x'))
    const deps = { ...h.env.install, progress: () => undefined }
    const request = {
      host: h.env.host,
      platformKey: h.env.context.platformKey!,
      version: '2.0.0',
      payloadDir: h.env.context.setup!.payloadDir,
      sourceBundle: null,
      dataRoot: null,
      legacy: null,
    }
    const portable = join(work(), 'p')
    mkdirSync(portable)
    writeFileSync(join(portable, 'portable.json'), JSON.stringify({ schema: 1, version: '2.0.0' }))
    await expect(performInstall({ ...request, root: portable }, deps)).rejects.toMatchObject({ code: 'E_PORTABLE_ROOT' })
    const foreign = join(work(), 'f')
    mkdirSync(foreign)
    writeFileSync(join(foreign, 'install.json'), '{"x":1}')
    await expect(performInstall({ ...request, root: foreign }, deps)).rejects.toMatchObject({ code: 'E_NOT_EMPTY' })
    expect(readFileSync(join(foreign, 'install.json'), 'utf8')).toBe('{"x":1}')
    expect(existsSync(join(foreign, 'app-2.0.0'))).toBe(false)
  })
})

describe('old 1.0.x install', () => {
  function makeLegacy(root: string): void {
    mkdirSync(join(root, 'resources'), { recursive: true })
    mkdirSync(join(root, 'locales'))
    writeFileSync(join(root, 'MossStudio.exe'), 'old exe')
    writeFileSync(join(root, 'MossStudio'), 'old exe')
    writeFileSync(join(root, 'ffmpeg.dll'), 'dll')
    writeFileSync(join(root, 'resources.pak'), 'pak')
    writeFileSync(join(root, 'resources', 'app.asar'), 'asar')
    writeFileSync(join(root, 'locales', 'en-US.pak'), 'pak')
    mkdirSync(join(root, 'data', 'outputs'), { recursive: true })
    writeFileSync(join(root, 'data', 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(root, 'data', 'outputs', '作品 1.png'), 'png')
    writeFileSync(join(root, 'data', 'evil.dll'), 'user')
  }

  it('installing INTO the old folder converts it in place and keeps data', async () => {
    const root = join(work(), 'Programs', 'MossStudio')
    makeLegacy(root)
    const h = harness('2.0.0', root)
    const { controller, result } = await silentInstall(h)
    expect(controller.state.location.kind).toBe('legacy')
    expect(result.dataRoot).toBe(join(root, 'data'))
    expect(readdirSync(root).sort()).toEqual(['app-2.0.0', 'data', 'install.json', launcherFile].sort())
    expect(readFileSync(join(root, 'data', 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readFileSync(join(root, 'data', 'outputs', '作品 1.png'), 'utf8')).toBe('png')
    expect(readFileSync(join(root, 'data', 'evil.dll'), 'utf8')).toBe('user')
    expect(readFileSync(join(root, launcherFile), 'utf8')).toBe('launcher 2.0.0')
  })

  it('reuse: installs elsewhere with dataRoot = <old>\\data, leaving the old folder alone; fresh: new data', async () => {
    const old = join(work(), '旧 版')
    makeLegacy(old)
    const before = readdirSync(old).sort()
    const reuseRoot = join(work(), 'new')
    const h = harness('2.0.0', reuseRoot)
    const controller = await SetupController.create(h.env)
    controller.start({ root: reuseRoot, legacy: { root: old, mode: 'reuse' } })
    const result = await controller.completion()
    expect(result.dataRoot).toBe(join(old, 'data'))
    expect(readInstallRecord(join(reuseRoot, 'install.json'))?.dataRoot).toBe(join(old, 'data'))
    expect(existsSync(join(reuseRoot, 'data'))).toBe(false)
    expect(readdirSync(old).sort()).toEqual(before)

    const freshRoot = join(work(), 'fresh')
    const fresh = await SetupController.create(harness('2.0.0', freshRoot).env)
    fresh.start({ root: freshRoot, legacy: { root: old, mode: 'fresh' } })
    expect((await fresh.completion()).dataRoot).toBe(join(freshRoot, 'data'))
    expect(readdirSync(old).sort()).toEqual(before)
  })

  it('gives a note per choice: reuse says NOT to delete the old folder, fresh says it may go', () => {
    const legacy = { root: 'D:\\旧 版', dataDir: 'D:\\旧 版\\data', dataBytes: 1, version: '1.0.3', source: 'registry' as const }
    for (const platform of ['win32', 'linux'] as const) {
      const { reuse, fresh } = legacyView(legacy, platform)!.warnings
      expect(reuse).toContain('D:\\旧 版')
      expect(reuse).toContain('请不要删除这个文件夹')
      expect(reuse).not.toMatch(/可以.*删除/)
      expect(fresh).toContain('不再需要时可以手动删除这个文件夹')
      expect(fresh).not.toContain('请不要删除')
    }
    expect(legacyView(legacy, 'win32')!.warnings.reuse).toContain('会从“设置 › 应用”的列表里消失')
    expect(legacyView(legacy, 'win32')!.warnings.fresh).toContain('会从“设置 › 应用”的列表里消失')
    expect(legacyView(legacy, 'linux')!.warnings.fresh).not.toContain('设置 › 应用')
    expect(legacyView(null, 'win32')).toBeNull()
  })

  it('refuses a legacy choice that is not an old install', async () => {
    const root = join(work(), 'R')
    const controller = await SetupController.create(harness('2.0.0', root).env)
    expect(() => controller.start({ root, legacy: { root: join(work(), 'nothing'), mode: 'reuse' } })).toThrow(
      expect.objectContaining({ code: 'E_NOT_LEGACY' }),
    )
  })
})

describe('reinstall after an uninstall that kept the data', () => {
  /** Install into `root`, put work into the data, then uninstall the way the launcher runs the plan. */
  async function installThenUninstallKeepingData(root: string): Promise<{ host: HostInfo; dataRoot: string }> {
    const h = harness('2.0.0', root)
    const { result } = await silentInstall(h)
    mkdirSync(join(result.dataRoot, 'outputs'), { recursive: true })
    // What a used install has: the launcher logs every start into <data>/logs.
    mkdirSync(join(result.dataRoot, 'logs'), { recursive: true })
    writeFileSync(join(result.dataRoot, 'logs', 'launcher.log'), 'started')
    writeFileSync(join(result.dataRoot, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(result.dataRoot, 'outputs', '作品 1.png'), 'png')
    const target = {
      host: h.env.host,
      platformKey: h.env.context.platformKey!,
      root,
      dataRoot: result.dataRoot,
      portable: false,
      desktopDir: join(work(), 'Desktop'),
      profileDir: null,
    }
    const plan = buildUninstallPlan(target, false, listRoot(root))
    for (const path of plan.remove) rmSync(path, { recursive: true, force: true })
    noteKeptData(target, '2.0.0', new Date('2026-11-05T09:00:00.000Z'))
    return { host: h.env.host, dataRoot: result.dataRoot }
  }

  it('the same folder is accepted again and its data/ is used as it is', async () => {
    const root = join(work(), 'R')
    const { host, dataRoot } = await installThenUninstallKeepingData(root)
    expect(readdirSync(root)).toEqual(['data'])
    expect(existsSync(locatorPath(host))).toBe(false)
    expect(readKeptData(keptDataPath(host))).toEqual({ schema: 1, root, dataRoot, version: '2.0.0', keptAt: '2026-11-05T09:00:00.000Z' })

    const { controller, result } = await silentInstall(harness('2.1.0', root))
    expect(controller.state).toMatchObject({ kind: 'first', location: { ok: true, kind: 'data' } })
    expect(result.dataRoot).toBe(dataRoot)
    expect(readFileSync(join(dataRoot, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readFileSync(join(dataRoot, 'outputs', '作品 1.png'), 'utf8')).toBe('png')
    expect(readLocator(locatorPath(host))?.dataRoot).toBe(dataRoot)
    expect(existsSync(keptDataPath(host))).toBe(false)
  })

  it('another folder: Setup offers the kept data (reuse records it, fresh starts anew), never touching it', async () => {
    const old = join(work(), 'R')
    const { host, dataRoot } = await installThenUninstallKeepingData(old)
    const elsewhere = join(work(), '新 位置')
    const controller = await SetupController.create(harness('2.1.0', elsewhere).env)
    expect(controller.state.legacy).toMatchObject({ source: 'kept', root: old, dataDir: dataRoot, version: '2.0.0' })
    expect(controller.state.legacy!.warnings.reuse).toBe(`新版本会继续使用 ${dataRoot} 里的作品、模型和设置：请不要删除这个文件夹。`)
    expect(controller.state.legacy!.warnings.fresh).toBe(`这些数据仍留在 ${dataRoot}，不会被删除；不再需要时可以手动删除这个文件夹。`)
    controller.start({ root: elsewhere, legacy: { root: old, mode: 'reuse' } })
    const result = await controller.completion()
    expect(result.dataRoot).toBe(dataRoot)
    expect(readInstallRecord(join(elsewhere, 'install.json'))?.dataRoot).toBe(dataRoot)
    expect(existsSync(join(elsewhere, 'data'))).toBe(false)
    expect(readFileSync(join(dataRoot, 'outputs', '作品 1.png'), 'utf8')).toBe('png')
    expect(existsSync(keptDataPath(host))).toBe(false)

    // The same, but 重新开始: a new data folder, the kept one left exactly as it was.
    const again = join(work(), 'again')
    const second = await installThenUninstallKeepingData(again)
    const freshRoot = join(work(), 'fresh')
    const fresh = await SetupController.create(harness('2.1.0', freshRoot).env)
    expect(fresh.state.legacy).toMatchObject({ source: 'kept', dataDir: second.dataRoot })
    fresh.start({ root: freshRoot, legacy: { root: again, mode: 'fresh' } })
    expect((await fresh.completion()).dataRoot).toBe(join(freshRoot, 'data'))
    expect(readFileSync(join(second.dataRoot, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  it('offers nothing once the kept data is gone or is not MossStudio data', () => {
    const h = host()
    expect(keptDataInstall(h)).toBeNull()
    const data = join(work(), 'gone', 'data')
    noteKeptData(
      { host: h, platformKey: 'linux-x64', root: join(work(), 'gone'), dataRoot: data, portable: false, desktopDir: '', profileDir: null },
      '2.0.0',
    )
    expect(keptDataInstall(h)).toBeNull()
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'photo.jpg'), '')
    expect(keptDataInstall(h)).toBeNull()
    writeFileSync(join(data, 'settings.json'), '{}')
    expect(keptDataInstall(h)).toMatchObject({ source: 'kept', dataDir: data })
    expect(keptDataInstall({ ...h, platform: 'darwin' })).toBeNull()
  })
})

describe('install folder moved by hand', () => {
  /** The installed app as the launcher starts it from `root` (after it rebased install.json there). */
  function startedFrom(root: string, h: HostInfo) {
    const recordFile = join(root, 'install.json')
    const record = readInstallRecord(recordFile)!
    if (record.root !== root) {
      // What launch.go Load does for a moved folder: root follows, and dataRoot when it was inside.
      const dataRoot = record.dataRoot.startsWith(record.root) ? join(root, record.dataRoot.slice(record.root.length)) : record.dataRoot
      writeFileSync(recordFile, JSON.stringify({ ...readJsonObject(recordFile), root, dataRoot }))
    }
    return detectRunContext({
      argv: ['MossStudio', '--moss-launched'],
      env: { ...h.env, MOSSSTUDIO_ROOT: root, MOSSSTUDIO_LAUNCHER: join(root, launcherFile) },
      execPath: join(root, 'app-2.0.0', exe),
      packaged: true,
      platform,
      arch: 'x64',
      home: h.home,
      exists: existsSync,
      readText: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
    })
  }

  it('moved: the locator, shortcuts or .desktop entry and the Apps & Features entry follow the new folder', async () => {
    const before = join(work(), 'before')
    const h = harness('2.0.0', before)
    await silentInstall(h)
    const after = join(work(), '新 文件夹', 'MossStudio')
    mkdirSync(join(after, '..'), { recursive: true })
    renameSync(before, after)
    h.regCalls.length = 0
    h.shortcuts.length = 0

    const context = startedFrom(after, h.env.host)
    expect(context).toMatchObject({ mode: 'installed', root: after, locator: { root: before } })
    expect(await reintegrateMovedInstall(context, h.env.host, h.env.install)).toEqual([])
    expect(readLocator(locatorPath(h.env.host))).toEqual({ schema: 1, root: after, dataRoot: join(after, 'data'), version: '2.0.0' })
    const launcher = join(after, launcherFile)
    if (platform === 'win32') {
      const adds = h.regCalls.filter((args) => args[0] === 'add')
      expect(adds.find((args) => args[3] === 'InstallLocation')?.[7]).toBe(after)
      expect(adds.find((args) => args[3] === 'UninstallString')?.[7]).toBe(`"${launcher}" --uninstall`)
      expect(h.shortcuts.map((item) => item.options.target)).toEqual([launcher, launcher])
    } else {
      expect(readFileSync(linuxDesktopFile(h.env.host), 'utf8')).toContain(`Exec="${launcher}" %U`)
    }
    // Done once: the next start has nothing to do.
    expect(await reintegrateMovedInstall(startedFrom(after, h.env.host), h.env.host, h.env.install)).toBeNull()

    // A later Setup finds it where it is now.
    const next = await SetupController.create(harness('2.1.0', after).env)
    expect(next.state).toMatchObject({ kind: 'update', installed: { root: after } })
  })

  it('copied: the original still holds an install, so nothing changes', async () => {
    const original = join(work(), 'original')
    const h = harness('2.0.0', original)
    await silentInstall(h)
    const desktopBefore = platform === 'win32' ? null : readFileSync(linuxDesktopFile(h.env.host), 'utf8')
    const copy = join(work(), 'copy')
    cpSync(original, copy, { recursive: true, verbatimSymlinks: true })
    h.regCalls.length = 0
    h.shortcuts.length = 0

    expect(await reintegrateMovedInstall(startedFrom(copy, h.env.host), h.env.host, h.env.install)).toBeNull()
    expect(readLocator(locatorPath(h.env.host))?.root).toBe(original)
    expect(h.regCalls).toEqual([])
    expect(h.shortcuts).toEqual([])
    if (desktopBefore !== null) expect(readFileSync(linuxDesktopFile(h.env.host), 'utf8')).toBe(desktopBefore)
    // Started from where it was installed: nothing to do either.
    expect(await reintegrateMovedInstall(startedFrom(original, h.env.host), h.env.host, h.env.install)).toBeNull()
  })
})

describe('macOS install', () => {
  it('copies the bundle with ditto (argument array), swaps it in, writes install.json in the data root', async () => {
    const w = work()
    const source = join(w, 'Volumes', 'MossStudio 2.0.0', 'MossStudio.app')
    mkdirSync(join(source, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(source, 'Contents', 'MacOS', 'MossStudio'), 'bundle 2.0.0')
    const folder = join(w, 'Applications')
    mkdirSync(join(folder, 'MossStudio.app'), { recursive: true })
    writeFileSync(join(folder, 'MossStudio.app', 'old'), 'old bundle')
    const dataRoot = join(w, 'home', 'Library', 'Application Support', 'MossStudio')
    const calls: Array<{ file: string; args: string[] }> = []
    const deps: InstallDeps = {
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      spawnLines: async (file, args, onLine) => {
        calls.push({ file, args })
        cpSync(args[2]!, args[3]!, { recursive: true })
        onLine('copying')
        return 0
      },
      writeShortcut: null,
      desktopDir: '',
      iconBytes: () => null,
      now: () => new Date('2026-11-05T08:00:00.000Z'),
      log: () => undefined,
      progress: () => undefined,
    }
    const macHost: HostInfo = { platform: 'darwin', home: join(w, 'home'), env: {} }
    const result = await performInstall(
      {
        host: macHost,
        platformKey: 'darwin-arm64',
        version: '2.0.0',
        payloadDir: null,
        sourceBundle: source,
        root: folder,
        dataRoot: null,
        legacy: null,
      },
      deps,
    )
    expect(calls).toEqual([{ file: '/usr/bin/ditto', args: ['-V', '--noqtn', source, join(folder, '.MossStudio-2.0.0.app.partial')] }])
    expect(readFileSync(join(folder, 'MossStudio.app', 'Contents', 'MacOS', 'MossStudio'), 'utf8')).toBe('bundle 2.0.0')
    expect(readdirSync(folder).sort()).toEqual(['.MossStudio-old.app.previous', 'MossStudio.app'])
    expect(result.recordPath.replace(/\\/g, '/')).toBe(join(dataRoot, 'install.json').replace(/\\/g, '/'))
    expect(readInstallRecord(result.recordPath)).toMatchObject({
      platform: 'darwin-arm64',
      root: folder,
      appPath: join(folder, 'MossStudio.app'),
      dataRoot,
      current: '2.0.0',
    })
    expect(readLocator(locatorPath(macHost))).toMatchObject({
      root: folder,
      appPath: join(folder, 'MossStudio.app'),
      dataRoot,
      version: '2.0.0',
    })
  })
})
