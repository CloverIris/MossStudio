import { useEffect, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { EngineFeatures } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { useApp } from '../../store'

export interface EngineTarget {
  deviceUuid?: string
  hostId?: string
}

/** Last answer per target, so switching canvases does not flash "loading". */
const cache = new Map<string, EngineFeatures | null>()

function keyOf(target: EngineTarget): string {
  return `${target.hostId ?? ''}|${target.deviceUuid ?? ''}`
}

/**
 * What the engine a canvas would run on can do. `undefined` while it is first
 * being read, `null` when no engine is usable there. Re-read when the engine,
 * the device or the remote machine changes.
 */
export function useEngineFeatures(target: EngineTarget | null): EngineFeatures | null | undefined {
  const key = target ? keyOf(target) : null
  const engineKey = useApp((state) => `${state.engineReadiness?.state ?? ''}|${state.engineReadiness?.path ?? ''}`)
  const [stamp, setStamp] = useState(0)
  const [answer, setAnswer] = useState<{ key: string; features: EngineFeatures | null } | null>(null)

  useEffect(() => {
    const bump = (): void => setStamp((value) => value + 1)
    const stops = [onEvent(Events.settingsChanged, bump), onEvent(Events.hostsChanged, bump)]
    return () => { for (const stop of stops) stop() }
  }, [])

  useEffect(() => {
    if (key === null || !target) return
    let alive = true
    void call<EngineFeatures | null>(Ipc.engineFeatures, { deviceUuid: target.deviceUuid, hostId: target.hostId })
      .then((features) => features ?? null)
      .catch(() => null)
      .then((features) => {
        cache.set(key, features)
        if (alive) setAnswer({ key, features })
      })
    return () => { alive = false }
    // `target` is read through `key`.
  }, [key, engineKey, stamp])

  if (key === null) return null
  if (answer?.key === key) return answer.features
  return cache.has(key) ? cache.get(key) : undefined
}

/** Test hook: forget remembered answers. */
export function clearEngineFeaturesCache(): void {
  cache.clear()
}
