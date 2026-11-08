import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { timeLeftLabel } from '../../lib/preparation'
import { usePreparation } from '../../lib/usePreparation'
import { useApp } from '../../store'
import { cn, useToast } from '../ui'

/**
 * While the first-run download goes on in the background, the title bar
 * carries it everywhere: how far, and how long. A click goes back to 准备.
 * When it all lands, setup completes and a toast says 生成 works now.
 */
export function PreparationChip(): React.JSX.Element | null {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const toast = useToast()
  const onboarding = useApp((s) => s.settings?.onboardingState)
  const saveSettings = useApp((s) => s.saveSettings)
  const { progress, recheck } = usePreparation()
  const wasActive = useRef(false)

  // Finished while the user was elsewhere: complete setup and say so once.
  const active = Boolean(progress?.active)
  useEffect(() => {
    const ended = wasActive.current && !active
    wasActive.current = active
    // On 准备 the page itself finishes up.
    if (!ended || onboarding !== 'active' || progress?.failed || pathname.startsWith('/setup')) return
    void recheck().then((status) => {
      if (!status?.ready) return
      void saveSettings({ onboardingState: 'completed' })
        .then(() => toast.push('模型准备好了，可以生成了', 'success'))
        .catch(() => undefined)
    })
  }, [active, onboarding, progress?.failed, pathname, recheck, saveSettings, toast])

  // The setup screen shows all of it itself.
  if (!progress || pathname.startsWith('/setup') || onboarding !== 'active') return null
  if (!progress.active && !progress.failed) return null
  const percent = Math.round(progress.percent)
  const left = timeLeftLabel(progress.secondsLeft)
  return (
    <button
      type="button"
      data-preparation-chip
      onClick={() => void navigate('/setup')}
      title="查看准备进度"
      className={cn(
        'no-drag flex h-7 shrink-0 items-center gap-2 rounded-full px-3 text-caption transition-colors hover:bg-raised',
        progress.failed && !progress.active ? 'bg-warn-soft font-medium text-warn' : 'bg-well text-ink',
      )}
    >
      {progress.failed && !progress.active ? (
        <>
          <AlertTriangle className="size-3.5" strokeWidth={1.6} aria-hidden="true" />
          准备没有完成
        </>
      ) : (
        <>
          <span className="tabular">准备中 {percent}%</span>
          <span aria-hidden="true" className="h-1 w-14 overflow-hidden rounded-full bg-well-strong">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
          </span>
          {left ? <span className="tabular text-ink-2">{left}</span> : null}
        </>
      )}
    </button>
  )
}
