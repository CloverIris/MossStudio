import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { OnboardingStatus } from '@shared/types'
import { modelDownloads } from '../pages/setup/setupState'
import { useApp } from '../store'
import { call } from './api'
import { preparationProgress, type Preparation } from './preparation'

/**
 * The first-run preparation (engine and recommended model) while it is under
 * way, as one progress. Null when setup is not running: before 开始下载, after
 * it finished, or once it was dismissed.
 */
export function usePreparation(): { progress: Preparation | null; recheck: () => Promise<OnboardingStatus | null> } {
  const state = useApp((s) => s.settings?.onboardingState)
  const engineDownload = useApp((s) => s.mossInferDownload)
  const downloads = useApp((s) => s.downloads)
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null)
  const watching = state === 'active' || state === 'pending'

  const recheck = useCallback(async (): Promise<OnboardingStatus | null> => {
    try {
      const next = await call<OnboardingStatus>(Ipc.onboardingStatus, { hostId: 'local' })
      setOnboarding(next)
      return next
    } catch {
      return null
    }
  }, [])

  // Which downloads are the recommended model's; read again as downloads finish.
  const finished = downloads.filter((task) => task.state === 'done').length
  useEffect(() => {
    if (watching) void recheck()
  }, [watching, finished, recheck])

  const progress = useMemo(() => {
    if (!watching) return null
    return preparationProgress(engineDownload, modelDownloads(onboarding, downloads))
  }, [watching, engineDownload, onboarding, downloads])
  return { progress, recheck }
}
