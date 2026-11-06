/**
 * Setup (/install) and uninstall (/uninstall) handlers of the mock backend, mirroring
 * main/install/app.ts. Data-driven through `state.install`:
 *
 *   backend.state.install.setup              what install:state answers (SetupState)
 *   backend.state.install.checks[path]       install:validate / choose-folder answer for a path
 *   backend.state.install.legacyAt[path]     install:inspect-legacy answer for a path
 *   backend.state.install.folderChoice       next install:choose-folder pick (null = canceled)
 *   backend.state.install.outcome            after install:start: 'success' plays progress + done,
 *                                            'failure' emits installFailed, 'hold' emits nothing
 *   backend.state.install.appRunning         MossStudio is running (start over an install fails)
 *   backend.state.install.uninstall          what uninstall:info answers (running → start fails)
 *   backend.state.install.launched / openedLogs / quit / uninstallStarted   what the page asked for
 */
import { Events, Ipc } from '@shared/channels'
import type {
  SetupFolderChoice,
  SetupLegacyInstall,
  SetupLocationCheck,
  SetupProgress,
  SetupResult,
  SetupStartInput,
  SetupState,
  UninstallInfo,
} from '@shared/setup'

export interface MockInstallState {
  setup: SetupState
  checks: Record<string, SetupLocationCheck>
  legacyAt: Record<string, SetupLegacyInstall>
  folderChoice: { purpose: 'install' | 'data' | 'legacy'; path: string } | null
  outcome: 'success' | 'failure' | 'hold'
  failure: { code: string; message: string }
  /** Delay between played progress events. */
  stepMs: number
  /** MossStudio is running: install:start over an existing install fails with E_APP_RUNNING. */
  appRunning: boolean
  uninstall: UninstallInfo
  launched: { eject: boolean } | null
  /** Logs install:open-log was asked to open. */
  openedLogs: Array<'setup' | 'launcher'>
  quit: boolean
  uninstallStarted: { removeData: boolean } | null
  /** Payloads install:start was called with. */
  starts: SetupStartInput[]
}

export const SETUP_FIXTURE_ROOT = 'C:\\Users\\张 三\\AppData\\Local\\Programs\\MossStudio'
export const SETUP_FIXTURE_REQUIRED = 412 * 1024 * 1024

export function locationCheckFixture(patch: Partial<SetupLocationCheck> = {}): SetupLocationCheck {
  return {
    path: SETUP_FIXTURE_ROOT,
    ok: true,
    kind: 'missing',
    problem: null,
    suggestion: null,
    freeBytes: 120 * 1024 ** 3,
    requiredBytes: SETUP_FIXTURE_REQUIRED,
    ...patch,
  }
}

/** The per-choice notes main's legacyView writes (controller.ts), for a root on a platform. */
export function legacyWarningsFixture(root: string, platform: 'win32' | 'linux' | 'darwin' = 'win32'): SetupLegacyInstall['warnings'] {
  const where = `旧版 MossStudio（${root}）`
  return platform === 'win32'
    ? {
        reuse: `${where}会从“设置 › 应用”的列表里消失，但新版本会继续使用它文件夹里的 data：请不要删除这个文件夹。`,
        fresh: `${where}会从“设置 › 应用”的列表里消失，它的文件和数据仍留在原处，不会被删除；不再需要时可以手动删除这个文件夹。`,
      }
    : {
        reuse: `新版本会继续使用${where}文件夹里的 data：请不要删除这个文件夹。`,
        fresh: `${where}的文件和数据仍留在原处，不会被删除；不再需要时可以手动删除这个文件夹。`,
      }
}

export function legacyInstallFixture(patch: Partial<SetupLegacyInstall> = {}): SetupLegacyInstall {
  const root = patch.root ?? SETUP_FIXTURE_ROOT
  return {
    root,
    dataDir: `${root}\\data`,
    dataBytes: 38 * 1024 ** 3,
    version: '1.0.3',
    source: 'registry',
    warnings: legacyWarningsFixture(root),
    ...patch,
  }
}

/** Data a keep-data uninstall left in `root`\data, with the notes main's legacyView writes for it. */
export function keptDataFixture(patch: Partial<SetupLegacyInstall> = {}): SetupLegacyInstall {
  const root = patch.root ?? SETUP_FIXTURE_ROOT
  const dataDir = patch.dataDir ?? `${root}\\data`
  return {
    root,
    dataDir,
    dataBytes: 12 * 1024 ** 3,
    version: '1.9.0',
    source: 'kept',
    warnings: {
      reuse: `新版本会继续使用 ${dataDir} 里的作品、模型和设置：请不要删除这个文件夹。`,
      fresh: `这些数据仍留在 ${dataDir}，不会被删除；不再需要时可以手动删除这个文件夹。`,
    },
    ...patch,
  }
}

export function setupStateFixture(patch: Partial<SetupState> = {}): SetupState {
  return {
    platform: 'win32',
    version: '2.0.0',
    kind: 'first',
    installed: null,
    defaults: { root: SETUP_FIXTURE_ROOT, dataRoot: null },
    location: locationCheckFixture(),
    dataLocation: null,
    legacy: null,
    requiredBytes: SETUP_FIXTURE_REQUIRED,
    phase: 'idle',
    progress: null,
    result: null,
    error: null,
    canEject: false,
    logPath: 'C:\\Users\\张 三\\AppData\\Local\\Temp\\MossStudio-setup.log',
    launcherLogPath: null,
    ...patch,
  }
}

export function uninstallInfoFixture(patch: Partial<UninstallInfo> = {}): UninstallInfo {
  return {
    platform: 'win32',
    method: 'plan',
    root: SETUP_FIXTURE_ROOT,
    dataRoot: `${SETUP_FIXTURE_ROOT}\\data`,
    dataBytes: 38 * 1024 ** 3,
    version: '2.0.0',
    portable: false,
    running: false,
    ...patch,
  }
}

/** Named starting points for the setup window. */
export type SetupScenarioName = 'first' | 'legacy' | 'legacyInPlace' | 'keptData' | 'keptDataInPlace' | 'update' | 'repair' | 'downgrade' | 'macDmg' | 'noSpace'

export function setupScenario(name: SetupScenarioName): SetupState {
  const installed = { root: SETUP_FIXTURE_ROOT, dataRoot: `${SETUP_FIXTURE_ROOT}\\data`, version: '1.9.0' }
  switch (name) {
    case 'first':
      return setupStateFixture()
    case 'legacy':
      return setupStateFixture({
        location: locationCheckFixture({ path: 'D:\\MossStudio' }),
        legacy: legacyInstallFixture({ root: 'D:\\Apps\\MossStudio', dataDir: 'D:\\Apps\\MossStudio\\data' }),
      })
    case 'legacyInPlace':
      return setupStateFixture({ location: locationCheckFixture({ kind: 'legacy' }), legacy: legacyInstallFixture() })
    case 'keptData':
      // Uninstalled from the default folder with the data kept; this time installing to D:.
      return setupStateFixture({ location: locationCheckFixture({ path: 'D:\\MossStudio' }), legacy: keptDataFixture() })
    case 'keptDataInPlace':
      return setupStateFixture({ location: locationCheckFixture({ kind: 'data' }), legacy: keptDataFixture() })
    case 'update':
      return setupStateFixture({ kind: 'update', installed, location: locationCheckFixture({ kind: 'install' }) })
    case 'repair':
      return setupStateFixture({ kind: 'repair', installed: { ...installed, version: '2.0.0' }, location: locationCheckFixture({ kind: 'install' }) })
    case 'downgrade':
      return setupStateFixture({ kind: 'downgrade', installed: { ...installed, version: '2.1.0' }, location: locationCheckFixture({ kind: 'install' }) })
    case 'macDmg':
      return setupStateFixture({
        platform: 'darwin',
        defaults: { root: '/Applications', dataRoot: '/Users/zhang/Library/Application Support/MossStudio' },
        location: locationCheckFixture({ path: '/Applications', kind: 'empty' }),
        dataLocation: locationCheckFixture({ path: '/Users/zhang/Library/Application Support/MossStudio', requiredBytes: 0 }),
        canEject: true,
      })
    case 'noSpace':
      return setupStateFixture({
        location: locationCheckFixture({ ok: false, freeBytes: 100 * 1024 * 1024, problem: { code: 'E_NO_SPACE', message: '磁盘空间不足。' } }),
      })
  }
}

export function installStateFixture(patch: Partial<MockInstallState> = {}): MockInstallState {
  return {
    setup: setupStateFixture(),
    checks: {},
    legacyAt: {},
    folderChoice: null,
    outcome: 'success',
    failure: { code: 'E_IN_USE', message: 'app-2.0.0 正在使用。请先退出 MossStudio，再继续安装。' },
    stepMs: 0,
    appRunning: false,
    uninstall: uninstallInfoFixture(),
    launched: null,
    openedLogs: [],
    quit: false,
    uninstallStarted: null,
    starts: [],
    ...patch,
  }
}

type Emit = (event: string, data: unknown) => void
type Handler = (payload: unknown, context: { state: { install: MockInstallState }; emit: Emit }) => unknown

class InstallMockError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

function checkFor(install: MockInstallState, path: string): SetupLocationCheck {
  if (install.checks[path]) return install.checks[path]
  const absolute = /^(?:[A-Za-z]:\\|\\\\|\/)/.test(path.trim())
  if (!absolute) {
    return locationCheckFixture({ path: path.trim(), ok: false, problem: { code: 'E_NOT_ABSOLUTE', message: '请选择一个完整的文件夹路径。' }, freeBytes: null })
  }
  return locationCheckFixture({ path: path.trim() })
}

const progressSteps: Array<Pick<SetupProgress, 'phase' | 'percent'>> = [
  { phase: 'prepare', percent: 0 },
  { phase: 'copy', percent: 30 },
  { phase: 'copy', percent: 70 },
  { phase: 'launcher', percent: 91 },
  { phase: 'record', percent: 93 },
  { phase: 'integrate', percent: 96 },
  { phase: 'done', percent: 100 },
]

function play(install: MockInstallState, emit: Emit, root: string): void {
  const total = install.setup.requiredBytes
  const steps = progressSteps.map((step) => ({ ...step, copiedBytes: Math.round((total * step.percent) / 100), totalBytes: total }))
  let index = 0
  const next = (): void => {
    if (install.outcome === 'failure' && index === 2) {
      install.setup = { ...install.setup, phase: 'failed', error: install.failure }
      emit(Events.installFailed, install.failure)
      return
    }
    const step = steps[index]
    if (!step) {
      const result: SetupResult = {
        root,
        dataRoot: install.setup.installed?.dataRoot ?? `${root}${root.includes('\\') ? '\\' : '/'}data`,
        version: install.setup.version,
        appPath: `${root}${root.includes('\\') ? '\\' : '/'}app-${install.setup.version}`,
        warnings: [],
      }
      install.setup = { ...install.setup, phase: 'done', result }
      emit(Events.installDone, result)
      return
    }
    install.setup = { ...install.setup, progress: step }
    emit(Events.installProgress, step)
    index += 1
    setTimeout(next, install.stepMs)
  }
  setTimeout(next, install.stepMs)
}

const handlers: Array<[string, Handler]> = [
  [Ipc.installState, (_, { state }) => state.install.setup],
  [Ipc.installValidate, (payload, { state }) => checkFor(state.install, (payload as { path: string }).path)],
  [Ipc.installInspectLegacy, (payload, { state }) => state.install.legacyAt[(payload as { path: string }).path] ?? null],
  [Ipc.installChooseFolder, (payload, { state }): SetupFolderChoice => {
    const { purpose } = payload as { purpose: 'install' | 'data' | 'legacy' }
    const choice = state.install.folderChoice
    state.install.folderChoice = null
    if (!choice || choice.purpose !== purpose) return { canceled: true, path: null, check: null, legacy: null }
    if (purpose === 'legacy') return { canceled: false, path: choice.path, check: null, legacy: state.install.legacyAt[choice.path] ?? null }
    return { canceled: false, path: choice.path, check: checkFor(state.install, choice.path), legacy: null }
  }],
  [Ipc.installStart, (payload, { state, emit }) => {
    const input = payload as SetupStartInput
    const install = state.install
    install.starts.push(input)
    if (install.setup.phase === 'installing') throw new InstallMockError('E_BUSY', '正在安装。')
    if (install.setup.kind === 'downgrade' && !input.allowDowngrade) {
      throw new InstallMockError('E_DOWNGRADE', `已安装的版本（${install.setup.installed?.version}）比这个安装程序（${install.setup.version}）新。确认后才会降级。`)
    }
    const root = install.setup.installed?.root ?? input.root
    let replacing = Boolean(install.setup.installed)
    if (!install.setup.installed) {
      const check = checkFor(install, input.root)
      if (!check.ok) throw new InstallMockError(check.problem?.code ?? 'E_LOCATION', check.problem?.message ?? '不能安装到这个位置。')
      replacing = check.kind === 'install' || check.kind === 'legacy'
    }
    // As main: replacing an install while MossStudio runs ends in a failed state (重试).
    if (replacing && install.appRunning) {
      const failure = { code: 'E_APP_RUNNING', message: 'MossStudio 正在运行。请在它弹出的对话框里关闭它（或手动退出），然后重试。' }
      install.setup = { ...install.setup, phase: 'failed', error: failure }
      setTimeout(() => emit(Events.installFailed, failure), install.stepMs)
      return install.setup
    }
    install.setup = { ...install.setup, phase: 'installing', progress: null, error: null }
    if (install.outcome !== 'hold') play(install, emit, root)
    return install.setup
  }],
  [Ipc.installLaunch, (payload, { state }) => {
    if (state.install.setup.phase !== 'done') throw new InstallMockError('E_NOT_DONE', '还没有安装完成。')
    state.install.launched = { eject: Boolean((payload as { eject?: boolean } | undefined)?.eject) }
    return true
  }],
  [Ipc.installOpenLog, (payload, { state }) => {
    const which = (payload as { log?: 'setup' | 'launcher' } | undefined)?.log ?? 'setup'
    if (which === 'launcher' && !state.install.setup.launcherLogPath) throw new InstallMockError('E_NO_LOG', '没有这份日志。')
    state.install.openedLogs.push(which)
    return true
  }],
  [Ipc.installQuit, (_, { state }) => {
    state.install.quit = true
    return true
  }],
  [Ipc.uninstallInfo, (_, { state }) => state.install.uninstall],
  [Ipc.uninstallStart, (payload, { state }) => {
    if (state.install.uninstall.running) throw new InstallMockError('E_APP_RUNNING', 'MossStudio 正在运行。请在它弹出的对话框里关闭它（或手动退出），然后再卸载。')
    state.install.uninstallStarted = { removeData: Boolean((payload as { removeData?: boolean }).removeData) }
    return true
  }],
]

/**
 * Register the install handlers into the mock backend's handler map. `toIpcError` turns a
 * coded failure into the backend's MockIpcError so the page sees `{ ok: false, error: { code } }`.
 */
export function addInstallHandlers(
  register: (channel: string, handler: Handler) => void,
  toIpcError: (code: string, message: string) => Error,
): void {
  for (const [channel, handler] of handlers) {
    register(channel, async (payload, context) => {
      try {
        return await handler(payload, context)
      } catch (error) {
        if (error instanceof InstallMockError) throw toIpcError(error.code, error.message)
        throw error
      }
    })
  }
}
