/**
 * What the main process pushes on its own, without being asked: GPU telemetry
 * every few seconds. (Every IPC channel is answered by test/mocks/backend.)
 */
import { Events } from '@shared/channels'
import { gpuTelemetryFixture } from '../../test/mocks/backend/fixtures'
import type { MockBackend } from '../../test/mocks/backend'

/**
 * Main samples the GPUs and pushes Events.gpuTelemetry; do the same once the
 * store is listening, from the scenario's GPU inventory.
 */
export function startTelemetry(backend: MockBackend): void {
  const push = (): void => {
    const inventory = backend.state.gpuInventory
    const snapshot = gpuTelemetryFixture(inventory.devices)
    backend.emit(
      Events.gpuTelemetry,
      inventory.status === 'ok'
        ? { ...snapshot, devices: snapshot.devices.map((device) => ({ ...device, utilizationPercent: 12 })) }
        : { ...snapshot, status: 'unavailable', devices: [], error: undefined },
    )
  }
  const waitForListener = (): void => {
    if (backend.listenerCount(Events.gpuTelemetry) > 0) push()
    else setTimeout(waitForListener, 20)
  }
  waitForListener()
}
