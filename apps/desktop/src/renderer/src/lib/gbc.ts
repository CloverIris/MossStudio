import { useCallback, useEffect, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { AiProviderInfo } from '@shared/ai'
import { gbcBlocker, gbcCanUse, type GbcSetupProgress, type GbcStatus } from '@shared/gbc'
import { call, onEvent } from './api'

export interface GbcState {
  /** undefined while checking; null when the check itself failed. */
  status: GbcStatus | null | undefined
  /** The 助手 models GBC can read pictures with. */
  providers: AiProviderInfo[]
  /** Why 拆成区域 cannot run, or null when it can. */
  blocker: string | null
  /** Check again; `fresh` re-runs the checks instead of taking the last answer. */
  refresh: (fresh?: boolean) => Promise<void>
}

/**
 * Whether 拆成区域 can run, for the version and model 设置 › 功能 chose.
 * Nothing is asked while the feature is off. An install finishing elsewhere,
 * or the window coming back (a model added in 助手), checks again.
 */
export function useGbcState(enabled: boolean, versionId: string | null): GbcState {
  const [status, setStatus] = useState<GbcStatus | null | undefined>(undefined)
  const [providers, setProviders] = useState<AiProviderInfo[]>([])

  const refresh = useCallback(
    async (fresh = false) => {
      if (!enabled) return
      const [nextStatus, nextProviders] = await Promise.all([
        call<GbcStatus>(Ipc.gbcStatus, { fresh }).catch(() => null),
        call<AiProviderInfo[]>(Ipc.aiProvidersList).catch(() => []),
      ])
      setStatus(nextStatus)
      setProviders(nextProviders.filter(gbcCanUse))
    },
    [enabled],
  )

  useEffect(() => {
    setStatus(undefined)
    void refresh()
  }, [refresh, versionId])

  useEffect(() => {
    if (!enabled) return
    const offSetup = onEvent<GbcSetupProgress>(Events.gbcSetup, (progress) => {
      if (progress.phase === 'done' || progress.phase === 'failed') void refresh()
    })
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      offSetup()
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, refresh])

  return { status, providers, blocker: gbcBlocker(status, providers), refresh }
}
