import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { IconButton, cn } from '../../components/ui'

/** These windows run before (or after) settings exist, so they always follow the OS theme. */
export function useSystemTheme(): void {
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset.theme = query.matches ? 'dark' : 'light'
    }
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])
}

/**
 * The frameless setup and uninstall windows: one calm tone edge to edge, a
 * drag strip along the top and our own close button (none on macOS, where the
 * traffic lights are native).
 */
export function WindowChrome({
  title,
  onClose,
  closeDisabled,
  children,
}: {
  title: string
  onClose: () => void
  closeDisabled?: boolean
  children: ReactNode
}): React.JSX.Element {
  useSystemTheme()
  const mac = window.clover.platform === 'darwin'
  return (
    <div data-standalone className="flex h-full flex-col bg-panel text-ink">
      <header
        data-platform={window.clover.platform}
        className={cn('drag flex h-10 shrink-0 items-center gap-2 pr-1.5', mac ? 'pl-20' : 'pl-4')}
      >
        <span className="text-caption text-ink-2">{title}</span>
        <span className="flex-1" />
        {mac ? null : (
          <IconButton label="关闭" className="no-drag" disabled={closeDisabled} onClick={onClose}>
            <X className="size-4" strokeWidth={1.6} />
          </IconButton>
        )}
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  )
}

/** The app icon beside the big title, and one line under it: the top of every setup screen. */
export function ScreenHeading({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-4">
      <img src="./mossstudio-icon.png" alt="" aria-hidden="true" className="mt-0.5 size-12 shrink-0 select-none" draggable={false} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-display font-semibold text-ink [text-wrap:balance]">{title}</h1>
        {subtitle ? <p className="text-ui leading-[22px] text-ink-2 [overflow-wrap:anywhere]">{subtitle}</p> : null}
      </div>
    </div>
  )
}
