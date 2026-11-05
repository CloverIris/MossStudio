import { useCallback, useEffect, useRef, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type {
  SetupFolderChoice,
  SetupLegacyInstall,
  SetupLocationCheck,
  SetupProgress,
  SetupResult,
  SetupStartInput,
  SetupState,
} from '@shared/setup'
import { call, onEvent } from '../../lib/api'
import { runView, type InstallRunView } from './installModel'

/** How long the 安装完成 screen stays before the installed app opens. */
export const LAUNCH_DELAY_MS = 1200

export interface SetupController {
  state: SetupState | null
  loadError: string | null
  /** The chosen install location and its check (starts as the proposed one). */
  location: SetupLocationCheck | null
  /** macOS 高级: the chosen data folder and its check. */
  dataLocation: SetupLocationCheck | null
  checking: boolean
  /** The old 1.0.x install: found by main, or picked by the user. */
  legacy: SetupLegacyInstall | null
  legacyMode: 'reuse' | 'fresh'
  setLegacyMode: (mode: 'reuse' | 'fresh') => void
  chooseLocation: () => void
  selectLocation: (path: string) => void
  chooseDataLocation: () => void
  selectDataLocation: (path: string) => void
  chooseLegacy: () => void
  legacyNotFound: boolean
  downgradeAccepted: boolean
  acceptDowngrade: () => void
  starting: boolean
  run: InstallRunView | null
  error: string | null
  install: () => void
  retry: () => void
  /** Open this setup's log (查看日志). */
  openLog: () => void
  /** macOS from a DMG: 推出安装盘 after opening. */
  eject: boolean
  setEject: (eject: boolean) => void
  launch: () => void
  launching: boolean
  close: () => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The setup window's state and actions over Ipc.install* (main/install/controller.ts). */
export function useInstall(): SetupController {
  const [state, setState] = useState<SetupState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [location, setLocation] = useState<SetupLocationCheck | null>(null)
  const [dataLocation, setDataLocation] = useState<SetupLocationCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [pickedLegacy, setPickedLegacy] = useState<SetupLegacyInstall | null | undefined>(undefined)
  const [legacyNotFound, setLegacyNotFound] = useState(false)
  const [legacyMode, setLegacyMode] = useState<'reuse' | 'fresh'>('reuse')
  const [downgradeAccepted, setDowngradeAccepted] = useState(false)
  const [starting, setStarting] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [eject, setEject] = useState(true)
  const checkSeq = useRef(0)
  const autoStarted = useRef(false)
  const autoLaunched = useRef(false)

  const legacy = pickedLegacy === undefined ? state?.legacy ?? null : pickedLegacy

  // Main pushes the whole state when it changes on its own (e.g. the old data was measured),
  // progress while installing, and the outcome.
  useEffect(() => {
    const offState = onEvent<SetupState>(Events.installState, setState)
    const offProgress = onEvent<SetupProgress>(Events.installProgress, (progress) => {
      setState((previous) => previous ? { ...previous, phase: 'installing', progress, error: null } : previous)
    })
    const offDone = onEvent<SetupResult>(Events.installDone, (result) => {
      setState((previous) => previous ? { ...previous, phase: 'done', result, error: null } : previous)
    })
    const offFailed = onEvent<{ code: string; message: string }>(Events.installFailed, (error) => {
      setState((previous) => previous ? { ...previous, phase: 'failed', error } : previous)
    })
    return () => { offState(); offProgress(); offDone(); offFailed() }
  }, [])

  const start = useCallback(async (input: SetupStartInput): Promise<void> => {
    setStarting(true)
    try {
      setState(await call<SetupState>(Ipc.installStart, input))
    } catch (error) {
      setState((previous) => previous ? { ...previous, phase: 'failed', error: { code: 'E_START', message: message(error) } } : previous)
    } finally {
      setStarting(false)
    }
  }, [])

  useEffect(() => {
    let canceled = false
    void call<SetupState>(Ipc.installState).then((next) => {
      if (canceled) return
      setState(next)
      setLocation(next.location)
      setDataLocation(next.dataLocation)
      // An update or a repair asks nothing: install into the located root right away.
      if ((next.kind === 'update' || next.kind === 'repair') && next.phase === 'idle' && !autoStarted.current) {
        autoStarted.current = true
        void start({ root: next.installed?.root ?? next.location.path })
      }
    }).catch((error: unknown) => {
      if (!canceled) setLoadError(`安装程序没能读取安装信息：${message(error)}`)
    })
    return () => { canceled = true }
  }, [start])

  const launch = useCallback(async (withEject: boolean): Promise<void> => {
    setLaunching(true)
    try {
      await call(Ipc.installLaunch, withEject ? { eject: true } : {})
    } catch (error) {
      setLaunching(false)
      setState((previous) => previous ? { ...previous, phase: 'failed', error: { code: 'E_LAUNCH', message: `MossStudio 已经装好，但没能打开：${message(error)}` } } : previous)
    }
  }, [])

  // Done: open the installed app after a moment (macOS from a DMG waits for 打开, to offer 推出安装盘).
  useEffect(() => {
    if (state?.phase !== 'done' || state.canEject || autoLaunched.current) return
    const timer = window.setTimeout(() => {
      autoLaunched.current = true
      void launch(false)
    }, LAUNCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [state?.phase, state?.canEject, launch])

  const validate = useCallback(async (purpose: 'install' | 'data', path: string): Promise<void> => {
    const seq = ++checkSeq.current
    setChecking(true)
    try {
      const result = await call<SetupLocationCheck>(Ipc.installValidate, { path, purpose })
      if (seq !== checkSeq.current) return
      if (purpose === 'install') setLocation(result)
      else setDataLocation(result)
    } catch (error) {
      if (seq !== checkSeq.current) return
      const failed: SetupLocationCheck = {
        path, ok: false, kind: 'occupied', suggestion: null, freeBytes: null, requiredBytes: state?.requiredBytes ?? 0,
        problem: { code: 'E_NOT_DIRECTORY', message: `没能检查这个位置：${message(error)}` },
      }
      if (purpose === 'install') setLocation(failed)
      else setDataLocation(failed)
    } finally {
      if (seq === checkSeq.current) setChecking(false)
    }
  }, [state?.requiredBytes])

  const choose = useCallback(async (purpose: 'install' | 'data' | 'legacy'): Promise<void> => {
    const defaultPath = purpose === 'install' ? location?.path : purpose === 'data' ? dataLocation?.path : undefined
    let choice: SetupFolderChoice
    try {
      choice = await call<SetupFolderChoice>(Ipc.installChooseFolder, defaultPath ? { purpose, defaultPath } : { purpose })
    } catch {
      return
    }
    if (choice.canceled || !choice.path) return
    if (purpose === 'legacy') {
      setPickedLegacy(choice.legacy)
      setLegacyNotFound(!choice.legacy)
      if (choice.legacy) setLegacyMode('reuse')
      return
    }
    checkSeq.current += 1
    if (choice.check) {
      if (purpose === 'install') setLocation(choice.check)
      else setDataLocation(choice.check)
    } else {
      void validate(purpose, choice.path)
    }
  }, [location?.path, dataLocation?.path, validate])

  const request = (allowDowngrade: boolean): SetupStartInput => ({
    root: location?.path ?? state?.location.path ?? '',
    ...(state?.platform === 'darwin' && dataLocation ? { dataRoot: dataLocation.path } : {}),
    ...(state?.kind === 'first' && legacy ? { legacy: { root: legacy.root, mode: legacyMode } } : {}),
    ...(allowDowngrade ? { allowDowngrade: true } : {}),
  })

  return {
    state,
    loadError,
    location,
    dataLocation,
    checking,
    legacy,
    legacyMode,
    setLegacyMode,
    chooseLocation: () => void choose('install'),
    selectLocation: (path) => { setLocation(null); void validate('install', path) },
    chooseDataLocation: () => void choose('data'),
    selectDataLocation: (path) => { setDataLocation(null); void validate('data', path) },
    chooseLegacy: () => void choose('legacy'),
    legacyNotFound,
    downgradeAccepted,
    acceptDowngrade: () => {
      setDowngradeAccepted(true)
      void start(request(true))
    },
    starting,
    run: state && state.phase !== 'idle' ? runView(state.phase, state.progress) : null,
    error: state?.error?.message ?? null,
    install: () => void start(request(false)),
    retry: () => void start(request(state?.kind === 'downgrade')),
    openLog: () => void call(Ipc.installOpenLog, { log: 'setup' }).catch(() => undefined),
    eject,
    setEject,
    launch: () => void launch(eject),
    launching,
    close: () => void call(Ipc.installQuit).catch(() => window.close()),
  }
}
