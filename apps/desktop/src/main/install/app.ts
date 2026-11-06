/**
 * Electron glue for install modes: the setup and uninstall windows, their IPC, silent
 * installs and uninstalls, launching the installed app, and the Windows taskbar identity.
 * index.ts calls `runInstallMode()` first thing in whenReady (setup/uninstall modes take
 * over the process) and `registerUninstallIpc()` in the normal app.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZodError, type ZodType } from 'zod'
import { Events, Ipc } from '@shared/channels'
import { setupSchemas, type SetupFolderChoice, type UninstallInfo } from '@shared/setup'
import { errorCode, codedError } from '../lib/codedError'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { getSettings } from '../services/settings'
import { SetupController } from './controller'
import { confirmHealthFor } from './health'
import { trashBundleAfterExit } from './macTrash'
import { chromiumHelpers, rememberSpawned, spawnedPids } from './processTree'
import { focusOnSecondInstance, otherInstanceRunning, releaseAppLock } from './singleInstance'
import { recordedDataRoot } from './dataRoot'
import { installModeSwitches } from './switches'
import { readInstallRecord } from './record'
import { ensureMacPortableRecord } from './portable'
import { spawnLinesNoShell, type InstallResult } from './install'
import { applyAppDetails } from './identity'
import { PRODUCT_NAME, READY_FILE, type HostInfo } from './layout'
import { directorySize } from './legacy'
import { execFileNoShell, type Registry } from './registry'
import { getRunContext, type RunContext } from './runContext'
import { buildUninstallPlan, listRoot, noteKeptData, startFinishUninstall, uninstallMac, type UninstallTarget } from './uninstall'

/** Setup and uninstall write here (append): %TEMP%\MossStudio-setup.log, $TMPDIR/MossStudio-setup.log. */
export function setupLogPath(): string {
  return join(tmpdir(), 'MossStudio-setup.log')
}

function log(line: string): void {
  const text = `${new Date().toISOString()} [${process.pid}] ${line}\n`
  try {
    appendFileSync(setupLogPath(), text, 'utf8')
  } catch {
    // logging must never break setup
  }
  console.log(`[install] ${line}`)
}

function host(context: RunContext): HostInfo {
  return { platform: context.platform, home: homedir(), env: process.env }
}

function registryFor(context: RunContext): Registry | null {
  return context.platform === 'win32' ? { exec: execFileNoShell, env: process.env } : null
}

function iconBytes(): Buffer | null {
  const file = app.isPackaged
    ? join(__dirname, '..', 'renderer', 'mossstudio-icon.png')
    : join(app.getAppPath(), 'src', 'renderer', 'public', 'mossstudio-icon.png')
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

type Handler<T> = (input: T) => unknown

function handle<T>(channel: string, schema: ZodType<T> | null, fn: Handler<T>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      const input = (schema ? schema.parse(payload ?? {}) : payload) as T
      return { ok: true as const, data: await fn(input) }
    } catch (error) {
      return {
        ok: false as const,
        error: {
          code: error instanceof ZodError ? 'BAD_REQUEST' : errorCode(error) ?? 'INTERNAL',
          message: error instanceof ZodError ? error.issues[0]?.message ?? '参数不合法' : error instanceof Error ? error.message : String(error),
        },
      }
    }
  })
}

/** For the Updater: mark the running version healthy in install.json. */
export function confirmHealth(): boolean {
  return confirmHealthFor(getRunContext(), app.getVersion())
}

// --- windows ------------------------------------------------------------------

/** The page tone of /install and /uninstall (bg-panel), so the first frame does not flash. */
const chrome = { dark: '#161618', light: '#efefec' } as const

function createInstallWindow(route: '/install' | '/uninstall'): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    title: route === '/install' ? `安装 ${PRODUCT_NAME}` : `卸载 ${PRODUCT_NAME}`,
    backgroundColor: nativeTheme.shouldUseDarkColors ? chrome.dark : chrome.light,
    icon: app.isPackaged
      ? join(__dirname, '..', 'renderer', 'mossstudio-icon.png')
      : join(app.getAppPath(), 'src', 'renderer', 'public', 'mossstudio-icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: ['--clover-opaque', '--clover-window=install', `--clover-channel=${app.isPackaged ? 'release' : 'dev'}`],
    },
  })
  applyAppDetails(win)
  win.once('ready-to-show', () => {
    win.show()
    win.center()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${route}`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
  return win
}

/** Tell the stub its splash can go: <payloadDir>/.ready. */
function writeReady(context: RunContext): void {
  const payload = context.setup?.payloadDir
  if (!payload) return
  try {
    writeFileSync(join(payload, READY_FILE), '')
  } catch (error) {
    log(`could not write ${READY_FILE}: ${(error as Error).message}`)
  }
}

function registerBasics(): void {
  handle(Ipc.appInfo, null, () => ({
    name: PRODUCT_NAME,
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    dataPath: '',
    enginePath: '',
    modelsPath: '',
    acrylic: false,
  }))
  handle(Ipc.settingsGet, null, () => getSettings())
  handle(Ipc.installQuit, null, () => {
    setImmediate(() => app.quit())
    return true
  })
}

// --- leaving setup/uninstall ------------------------------------------------------

/**
 * End the process with `code` and no Chromium child left behind. app.exit() skips Chromium's
 * shutdown, so its GPU/utility processes (and the GPU process's broker child, which
 * app.getAppMetrics() does not list) can outlive it; the uninstall's temp launcher then waits
 * for every process under R and deletes nothing. app.quit() would stop them but always exits 0.
 * So: collect our Chromium helpers first (before a kill re-parents grandchildren) — never a
 * process we spawned on purpose or anything below it, see processTree.ts — add the metrics'
 * pids, SIGKILL them all (TerminateProcess on Windows), then app.exit(code).
 */
export function exitCleanly(code: number): void {
  const pids = new Set(chromiumHelpers())
  for (const metric of app.getAppMetrics()) {
    if (metric.pid !== process.pid && metric.type !== 'Browser' && !spawnedPids().has(metric.pid)) pids.add(metric.pid)
  }
  for (const pid of pids) {
    try {
      process.kill(pid, process.platform === 'win32' ? undefined : 'SIGKILL')
    } catch {
      // already gone
    }
  }
  app.exit(code)
}

/** Before ready: apply installModeSwitches (silent runs without a GPU process; portable profile). */
export function configureInstallModeSwitches(context: RunContext = getRunContext()): void {
  const switches = installModeSwitches(context)
  if (switches.disableHardwareAcceleration) app.disableHardwareAcceleration()
  if (switches.inProcessGpu) app.commandLine.appendSwitch('in-process-gpu')
  if (switches.userData) app.setPath('userData', switches.userData)
}

// --- launching the installed app ---------------------------------------------

/** Waits for the setup process (pid $1) to exit, then ejects the DMG volume $2. Positional args only. */
const EJECT_SCRIPT = 'while kill -0 "$1" 2>/dev/null; do sleep 0.5; done; exec /usr/bin/hdiutil detach "$2" -quiet'

function launchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['MOSSSTUDIO_ROOT']
  delete env['MOSSSTUDIO_LAUNCHER']
  delete env['ELECTRON_RUN_AS_NODE']
  return env
}

/** Start a detached process (no shell) and return its pid; the caller records it with rememberSpawned. */
function detached(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): number | undefined {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false, ...options })
  child.unref()
  return child.pid
}

function launchInstalled(result: InstallResult, context: RunContext, eject: boolean): void {
  if (context.platform === 'darwin') {
    rememberSpawned(detached('/usr/bin/open', ['-n', result.appPath]))
    if (eject && context.setup?.volume) {
      rememberSpawned(detached('/bin/sh', ['-c', EJECT_SCRIPT, 'sh', String(process.pid), context.setup.volume]))
    }
  } else if (result.launcher) {
    rememberSpawned(detached(result.launcher, [], { cwd: result.root, env: launchEnv() }))
  }
  log(`launched ${result.launcher ?? result.appPath}`)
}

// --- setup mode -----------------------------------------------------------------

async function runSetup(context: RunContext): Promise<void> {
  log(`setup ${app.getVersion()} (${context.platformKey ?? process.platform}) origin=${context.setup?.origin} payload=${context.setup?.payloadDir ?? '-'} silent=${context.silent}`)
  const controller = await SetupController.create({
    context,
    host: host(context),
    version: app.getVersion(),
    tempDir: tmpdir(),
    registry: registryFor(context),
    install: {
      exec: execFileNoShell,
      spawnLines: spawnLinesNoShell,
      writeShortcut: process.platform === 'win32' ? (path, operation, options) => shell.writeShortcutLink(path, operation, options) : null,
      desktopDir: app.getPath('desktop'),
      iconBytes,
      now: () => new Date(),
      log,
    },
    logPath: setupLogPath(),
    appRunning: () => otherInstanceRunning(context.silent ? 'silent' : 'setup'),
    emit: (kind, payload) => {
      const channel = { progress: Events.installProgress, done: Events.installDone, failed: Events.installFailed, state: Events.installState }[kind]
      emit(channel, payload)
    },
  })

  if (context.silent) {
    writeReady(context)
    try {
      controller.start(controller.silentStartInput())
      const result = await controller.completion()
      log(`silent install ok: ${result.appPath}`)
      exitCleanly(0)
    } catch (error) {
      log(`silent install failed: ${error instanceof Error ? error.message : String(error)}`)
      exitCleanly(1)
    }
    return
  }

  registerBasics()
  handle(Ipc.installState, null, () => controller.state)
  handle(Ipc.installValidate, setupSchemas.validate, ({ path, purpose }) => controller.validate(path, purpose))
  handle(Ipc.installInspectLegacy, setupSchemas.inspectLegacy, ({ path }) => controller.inspectLegacy(path))
  handle(Ipc.installChooseFolder, setupSchemas.chooseFolder, async ({ purpose, defaultPath }): Promise<SetupFolderChoice> => {
    const owner = BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      title: purpose === 'legacy' ? '选择旧版 MossStudio 的文件夹' : purpose === 'data' ? '选择数据位置' : '选择安装位置',
      defaultPath: defaultPath ?? (purpose === 'data' ? controller.state.defaults.dataRoot ?? undefined : controller.state.location.path),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const path = picked.canceled ? null : picked.filePaths[0] ?? null
    if (!path) return { canceled: true, path: null, check: null, legacy: null }
    if (purpose === 'legacy') return { canceled: false, path, check: null, legacy: await controller.inspectLegacy(path) }
    return { canceled: false, path, check: controller.validate(path, purpose), legacy: null }
  })
  handle(Ipc.installStart, setupSchemas.start, (input) => controller.start(input))
  handle(Ipc.installOpenLog, setupSchemas.openLog, async ({ log: which }) => {
    const file = which === 'launcher' ? controller.state.launcherLogPath : controller.state.logPath
    if (!file) throw codedError('E_NO_LOG', '没有这份日志。')
    const error = await shell.openPath(file)
    if (error) throw codedError('E_OPEN_LOG', `无法打开日志：${error}`)
    return true
  })
  handle(Ipc.installLaunch, setupSchemas.launch, async ({ eject }) => {
    if (controller.state.phase !== 'done') throw codedError('E_NOT_DONE', '还没有安装完成。')
    // Hand the single-instance lock (held if a probe took it) to the app we start.
    releaseAppLock()
    launchInstalled(await controller.completion(), context, Boolean(eject))
    setImmediate(() => app.quit())
    return true
  })

  const win = createInstallWindow('/install')
  win.once('show', () => writeReady(context))
  // Once the running-app probe holds the lock, a normal start lands here: bring setup forward.
  focusOnSecondInstance(() => win)
  app.on('window-all-closed', () => app.quit())
}

// --- uninstall --------------------------------------------------------------------

function uninstallTarget(context: RunContext): UninstallTarget {
  if (!context.root || !context.platformKey) throw codedError('E_NOT_INSTALLED', '这个 MossStudio 不是安装版，没有可卸载的内容。')
  return {
    host: host(context),
    platformKey: context.platformKey,
    root: context.root,
    // install.json's dataRoot (not MOSSSTUDIO_DATA): the launcher refuses a plan whose dataRoot differs from it.
    dataRoot: recordedDataRoot(context, context.recordPath ? readInstallRecord(context.recordPath) : null) ?? paths.root(),
    portable: context.portable,
    desktopDir: app.getPath('desktop'),
    profileDir: app.getPath('userData'),
  }
}

async function uninstallInfo(context: RunContext): Promise<UninstallInfo> {
  const target = uninstallTarget(context)
  const dataBytes = await Promise.race([
    directorySize(target.dataRoot),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
  ])
  return {
    platform: context.platform,
    method: context.platform === 'darwin' ? 'trash' : 'plan',
    root: target.root,
    dataRoot: target.dataRoot,
    dataBytes,
    version: context.record?.current ?? app.getVersion(),
    portable: context.portable,
    running: context.mode === 'uninstall' && otherInstanceRunning('uninstall'),
  }
}

async function startUninstall(context: RunContext, removeData: boolean): Promise<void> {
  const target = uninstallTarget(context)
  // Uninstall mode is a separate process; the app it removes must be closed first. (From
  // Settings the running app is this process, which quits right after.) Silent uninstalls
  // leave it to the launcher, which waits for every process under R.
  if (context.mode === 'uninstall' && !context.silent && otherInstanceRunning('uninstall')) {
    throw codedError('E_APP_RUNNING', 'MossStudio 正在运行。请在它弹出的对话框里关闭它（或手动退出），然后再卸载。')
  }
  log(`uninstall ${target.root} (data ${removeData ? 'removed' : 'kept'}: ${target.dataRoot})`)
  if (context.platform === 'darwin') {
    const trashed = await uninstallMac(target, context.appPath, removeData, {
      trash: (path) => shell.trashItem(path),
      trashBundleAfterExit: async (bundle) => rememberSpawned(await trashBundleAfterExit(bundle)),
    })
    log(`moved to Trash: ${[...trashed, `${context.appPath} (after quitting)`].join(', ')}`)
    return
  }
  if (!context.launcher) throw codedError('E_NO_LAUNCHER', '找不到 MossStudio 启动器，无法完成卸载。')
  const plan = buildUninstallPlan(target, removeData, listRoot(target.root))
  // Silent (QuietUninstallString, CI): the launcher copy must not stop on a dialog either.
  const started = startFinishUninstall(plan, context.launcher, { silent: context.mode === 'uninstall' && context.silent })
  log(`started ${started.launcher} with ${started.plan} (${plan.remove.length} paths)`)
  if (!removeData) {
    try {
      const note = noteKeptData(target, context.record?.current ?? app.getVersion())
      if (note) log(`noted the kept data ${target.dataRoot} in ${note}`)
    } catch (error) {
      // Only an offer for the next Setup: the uninstall goes on without it.
      log(`could not note the kept data: ${(error as Error).message}`)
    }
  }
}

/** uninstall:info / uninstall:start, for the uninstall window and Settings › 关于 › 卸载. */
export function registerUninstallIpc(context: RunContext = getRunContext()): void {
  handle(Ipc.uninstallInfo, null, () => uninstallInfo(context))
  handle(Ipc.uninstallStart, setupSchemas.uninstallStart, async ({ removeData }) => {
    await startUninstall(context, removeData)
    setImmediate(() => app.quit())
    return true
  })
}

async function runUninstall(context: RunContext): Promise<void> {
  log(`uninstall mode ${app.getVersion()} root=${context.root ?? '-'} silent=${context.silent}`)
  if (context.silent) {
    // macOS: Chromium's helpers end with us, and killing one only makes Chromium restart it
    // while the bundle is about to go. The trash helper waits for all of them anyway.
    const exit = context.platform === 'darwin' ? (code: number) => app.exit(code) : exitCleanly
    try {
      await startUninstall(context, false)
      exit(0)
    } catch (error) {
      log(`silent uninstall failed: ${error instanceof Error ? error.message : String(error)}`)
      exit(1)
    }
    return
  }
  registerBasics()
  registerUninstallIpc(context)
  const win = createInstallWindow('/uninstall')
  focusOnSecondInstance(() => win)
  app.on('window-all-closed', () => app.quit())
}

/**
 * Take over the process in setup and uninstall mode (returns true; the caller must not
 * run the normal startup). Returns false in every other mode.
 *
 * Any single-instance lock (app.requestSingleInstanceLock) must be taken AFTER this returns
 * false: setup and uninstall share userData with the installed app, so a lock taken earlier
 * would make Setup quit (or forward its args) whenever MossStudio is already running.
 */
export async function runInstallMode(context: RunContext = getRunContext()): Promise<boolean> {
  if (context.mode === 'setup') {
    try {
      await runSetup(context)
    } catch (error) {
      log(`setup could not start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      if (!context.silent) dialog.showErrorBox(`${PRODUCT_NAME} 安装`, `安装程序无法启动：${error instanceof Error ? error.message : String(error)}`)
      exitCleanly(1)
    }
    return true
  }
  if (context.mode === 'uninstall') {
    await runUninstall(context)
    return true
  }
  if (context.mode === 'portable' && context.platform === 'darwin') {
    try {
      ensureMacPortableRecord(context, app.getVersion())
    } catch (error) {
      console.error('[install] portable install.json', error)
    }
  }
  return false
}
