import { describe, expect, it } from 'vitest'
import { Events, Ipc } from '@shared/channels'
import type { SetupProgress, SetupResult, SetupState } from '@shared/setup'
import type { IpcResult } from '@shared/types'
import { createMockBackend, setupScenario, legacyInstallFixture, locationCheckFixture } from './backend'

async function invoke<T>(backend: ReturnType<typeof createMockBackend>, channel: string, payload?: unknown): Promise<IpcResult<T>> {
  return backend.bridge.invoke<IpcResult<T>>(channel, payload)
}

function collect(backend: ReturnType<typeof createMockBackend>) {
  const progress: SetupProgress[] = []
  const done: SetupResult[] = []
  const failed: unknown[] = []
  backend.bridge.on(Events.installProgress, (data) => progress.push(data as SetupProgress))
  backend.bridge.on(Events.installDone, (data) => done.push(data as SetupResult))
  backend.bridge.on(Events.installFailed, (data) => failed.push(data))
  return { progress, done, failed }
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('mock backend: setup window', () => {
  it('answers install:state and plays an install to done', async () => {
    const backend = createMockBackend()
    const events = collect(backend)
    const state = await invoke<SetupState>(backend, Ipc.installState)
    expect(state.ok && state.data.kind).toBe('first')
    const started = await invoke<SetupState>(backend, Ipc.installStart, { root: 'D:\\Moss' })
    expect(started.ok && started.data.phase).toBe('installing')
    await settle()
    expect(events.progress.map((step) => step.phase)).toEqual(['prepare', 'copy', 'copy', 'launcher', 'record', 'integrate', 'done'])
    expect(events.done).toEqual([expect.objectContaining({ root: 'D:\\Moss', version: '2.0.0', appPath: 'D:\\Moss\\app-2.0.0' })])
    expect(backend.state.install.setup.phase).toBe('done')
    expect(await invoke(backend, Ipc.installLaunch, { eject: false })).toEqual({ ok: true, data: true })
    expect(backend.state.install.launched).toEqual({ eject: false })
  })

  it('reports a failed install and holds when asked', async () => {
    const backend = createMockBackend()
    const events = collect(backend)
    backend.state.install.outcome = 'failure'
    await invoke(backend, Ipc.installStart, { root: 'D:\\Moss' })
    await settle()
    expect(events.failed).toEqual([backend.state.install.failure])
    expect(backend.state.install.setup.phase).toBe('failed')

    const held = createMockBackend()
    const heldEvents = collect(held)
    held.state.install.outcome = 'hold'
    await invoke(held, Ipc.installStart, { root: 'D:\\Moss' })
    await settle()
    expect(heldEvents.progress).toEqual([])
  })

  it('refuses a downgrade until confirmed, and invalid locations', async () => {
    const backend = createMockBackend()
    backend.state.install.setup = setupScenario('downgrade')
    expect(await invoke(backend, Ipc.installStart, { root: 'x' })).toMatchObject({ ok: false, error: { code: 'E_DOWNGRADE' } })
    expect((await invoke(backend, Ipc.installStart, { root: 'x', allowDowngrade: true })).ok).toBe(true)

    const first = createMockBackend()
    first.state.install.checks['D:\\'] = locationCheckFixture({ path: 'D:\\', ok: false, problem: { code: 'E_DRIVE_ROOT', message: 'root' }, suggestion: 'D:\\MossStudio' })
    expect(await invoke(first, Ipc.installValidate, { path: 'D:\\', purpose: 'install' })).toMatchObject({ ok: true, data: { ok: false, suggestion: 'D:\\MossStudio' } })
    expect(await invoke(first, Ipc.installValidate, { path: 'relative', purpose: 'install' })).toMatchObject({ ok: true, data: { problem: { code: 'E_NOT_ABSOLUTE' } } })
    expect(await invoke(first, Ipc.installStart, { root: 'D:\\' })).toMatchObject({ ok: false, error: { code: 'E_DRIVE_ROOT' } })
  })

  it('serves folder picks and old installs from state', async () => {
    const backend = createMockBackend()
    backend.state.install.legacyAt['D:\\Old'] = legacyInstallFixture({ root: 'D:\\Old', source: 'picked' })
    expect(await invoke(backend, Ipc.installChooseFolder, { purpose: 'install' })).toEqual({ ok: true, data: { canceled: true, path: null, check: null, legacy: null } })
    backend.state.install.folderChoice = { purpose: 'legacy', path: 'D:\\Old' }
    expect(await invoke(backend, Ipc.installChooseFolder, { purpose: 'legacy' })).toMatchObject({ ok: true, data: { path: 'D:\\Old', legacy: { root: 'D:\\Old' } } })
    expect(await invoke(backend, Ipc.installInspectLegacy, { path: 'D:\\Nope' })).toEqual({ ok: true, data: null })
  })

  it('opens the setup log, and the launcher log only when there is one', async () => {
    const backend = createMockBackend()
    expect(await invoke(backend, Ipc.installOpenLog, { log: 'setup' })).toEqual({ ok: true, data: true })
    expect(await invoke(backend, Ipc.installOpenLog, { log: 'launcher' })).toMatchObject({ ok: false, error: { code: 'E_NO_LOG' } })
    expect(backend.state.install.openedLogs).toEqual(['setup'])
  })

  it('refuses to replace an install or uninstall while MossStudio runs', async () => {
    const backend = createMockBackend()
    const events = collect(backend)
    backend.state.install.setup = setupScenario('update')
    backend.state.install.appRunning = true
    expect(await invoke(backend, Ipc.installStart, { root: 'x' })).toMatchObject({ ok: true, data: { phase: 'failed', error: { code: 'E_APP_RUNNING' } } })
    await settle()
    expect(events.failed).toEqual([expect.objectContaining({ code: 'E_APP_RUNNING' })])
    backend.state.install.uninstall = { ...backend.state.install.uninstall, running: true }
    expect(await invoke(backend, Ipc.uninstallStart, { removeData: false })).toMatchObject({ ok: false, error: { code: 'E_APP_RUNNING' } })
  })

  it('records uninstall and quit requests', async () => {
    const backend = createMockBackend()
    expect(await invoke(backend, Ipc.uninstallInfo)).toMatchObject({ ok: true, data: { method: 'plan', version: '2.0.0' } })
    await invoke(backend, Ipc.uninstallStart, { removeData: true })
    expect(backend.state.install.uninstallStarted).toEqual({ removeData: true })
    await invoke(backend, Ipc.installQuit)
    expect(backend.state.install.quit).toBe(true)
  })
})
