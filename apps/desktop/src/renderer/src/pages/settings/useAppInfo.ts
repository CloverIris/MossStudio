import { useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { AppInfo } from '@shared/types'
import { call } from '../../lib/api'
import { useApp } from '../../store'

/** Version and resolved folders from the main process; re-read whenever settings change. */
export function useAppInfo(): AppInfo | null {
  const settings = useApp((state) => state.settings)
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    let canceled = false
    void call<AppInfo>(Ipc.appInfo)
      .then((next) => {
        if (!canceled) setInfo(next)
      })
      .catch(() => undefined)
    return () => {
      canceled = true
    }
  }, [settings])
  return info
}
