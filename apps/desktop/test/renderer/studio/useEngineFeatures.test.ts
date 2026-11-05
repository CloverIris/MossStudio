import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Events, Ipc } from '@shared/channels'
import type { ControlAdapterEntry, EngineFeatures } from '@shared/types'
import { controlAdapterFixture, engineFeaturesFixture } from '@test/mocks/backend'
import { flush, loadStore } from '../../helpers/renderer'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

async function mount<T>(useHook: () => T): Promise<{ current: () => T }> {
  let value: T
  function Probe(): null {
    value = useHook()
    return null
  }
  const element = document.createElement('div')
  root = createRoot(element)
  await act(async () => root!.render(createElement(Probe)))
  return { current: () => value }
}

describe('studio/useEngineFeatures', () => {
  it('is undefined while reading, then the features of the target engine; re-read when settings change', async () => {
    const { backend } = await loadStore('ready')
    const { useEngineFeatures, clearEngineFeaturesCache } = await import('@renderer/pages/studio/useEngineFeatures')
    clearEngineFeaturesCache()
    const held = backend.hold(Ipc.engineFeatures)
    const hook = await mount(() => useEngineFeatures({ deviceUuid: 'GPU-1' }))
    await held.called
    expect(hook.current()).toBeUndefined()
    await act(async () => { await held.release() })
    expect(hook.current()).toMatchObject({ imageInput: true, control: true })
    expect(backend.callsTo(Ipc.engineFeatures)).toEqual([{ deviceUuid: 'GPU-1' }])

    backend.state.engineFeatures = engineFeaturesFixture({ control: false })
    await act(async () => { backend.emit(Events.settingsChanged, null); await flush() })
    expect((hook.current() as EngineFeatures).control).toBe(false)
  })

  it('is null when no engine is usable, or when asking fails', async () => {
    const { backend } = await loadStore('ready')
    const { useEngineFeatures, clearEngineFeaturesCache } = await import('@renderer/pages/studio/useEngineFeatures')
    clearEngineFeaturesCache()
    backend.state.engineFeatures = null
    const none = await mount(() => useEngineFeatures({}))
    await act(async () => { await flush() })
    expect(none.current()).toBeNull()
    act(() => root?.unmount())

    clearEngineFeaturesCache()
    backend.fail(Ipc.engineFeatures, { code: 'E_ENGINE', message: 'no' })
    const failed = await mount(() => useEngineFeatures({ hostId: 'h1' }))
    await act(async () => { await flush() })
    expect(failed.current()).toBeNull()
  })
})

describe('lib/useControlAdapters', () => {
  it('lists registered adapters and re-reads them when models change', async () => {
    const { backend } = await loadStore('ready')
    const { useControlAdapters } = await import('@renderer/lib/useControlAdapters')
    backend.state.controlAdapters = [controlAdapterFixture()]
    const hook = await mount(() => useControlAdapters())
    await act(async () => { await flush() })
    expect(hook.current().loaded).toBe(true)
    expect(hook.current().adapters.map((item: ControlAdapterEntry) => item.id)).toEqual(['control-union'])

    backend.state.controlAdapters = []
    await act(async () => { backend.emit(Events.modelsChanged, null); await flush() })
    expect(hook.current().adapters).toEqual([])
  })
})
