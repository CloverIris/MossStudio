import { useCallback, useEffect, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { ControlAdapterEntry } from '@shared/types'
import { call, onEvent } from './api'

/** Control adapters registered on the 模型 page; re-read whenever models change. */
export function useControlAdapters(): { adapters: ControlAdapterEntry[]; loaded: boolean; refresh: () => void } {
  const [adapters, setAdapters] = useState<ControlAdapterEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [stamp, setStamp] = useState(0)
  const refresh = useCallback(() => setStamp((value) => value + 1), [])

  useEffect(() => onEvent(Events.modelsChanged, refresh), [refresh])

  useEffect(() => {
    let alive = true
    call<ControlAdapterEntry[]>(Ipc.controlAdaptersList)
      .then((list) => { if (alive) { setAdapters(Array.isArray(list) ? list : []); setLoaded(true) } })
      .catch(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [stamp])

  return { adapters, loaded, refresh }
}
