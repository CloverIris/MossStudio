import { vi } from 'vitest'
import { createMockBackend, type MockBackend, type MockBackendOptions, type MockBackendState, type ScenarioName } from '../mocks/backend'

type StoreModule = typeof import('@renderer/store')

/**
 * Install a fresh mock backend and import a fresh copy of the renderer store.
 *
 * The store keeps module-level state (the `subscribed` flag and the set of
 * already-announced versions), so every test needs its own module instance.
 */
export async function loadStore(
  initial: ScenarioName | MockBackendState = 'ready',
  options: MockBackendOptions = {},
): Promise<{ backend: MockBackend; useApp: StoreModule['useApp']; store: () => ReturnType<StoreModule['useApp']['getState']> }> {
  vi.resetModules()
  const backend = createMockBackend(initial, options)
  backend.install()
  const { useApp } = await import('@renderer/store')
  return { backend, useApp, store: () => useApp.getState() }
}

/** Let queued promise continuations (fire-and-forget `void call(...)`) run. */
export async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}
