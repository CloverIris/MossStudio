import { AlertTriangle, CheckCircle2, Info, Megaphone, X } from 'lucide-react'
import { useEffect } from 'react'
import { Ipc } from '@shared/channels'
import { call } from '../lib/api'
import { relative } from '../lib/format'
import { useApp } from '../store'
import { cn, IconButton } from './ui'
import { Presence } from './motion'

const toneIcon = {
  info: <Info className="size-4 text-accent-300" />,
  success: <CheckCircle2 className="size-4 text-accent-300" />,
  warning: <AlertTriangle className="size-4 text-amber-300" />,
  error: <AlertTriangle className="size-4 text-red-300" />,
}

function preview(text: string): string {
  return text
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function NotificationPanel(): React.JSX.Element | null {
  const open = useApp((state) => state.notificationsOpen)
  const notifications = useApp((state) => state.notifications)
  const updates = useApp((state) => state.updates)
  const toggle = useApp((state) => state.setNotificationsOpen)
  const markAllRead = useApp((state) => state.markAllNotificationsRead)
  const dismissAnnouncement = useApp((state) => state.dismissAnnouncement)
  const checkForUpdates = useApp((state) => state.checkForUpdates)
  const unread = notifications.filter((item) => !item.read).length

  const announcements = (updates?.announcements ?? []).slice(0, 4)

  const close = (): void => {
    toggle(false)
    document.querySelector<HTMLElement>('[aria-controls="notification-panel"]')?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || document.querySelector('dialog:modal')) return
      if (event.target.closest('#notification-panel, [aria-controls="notification-panel"]')) return
      toggle(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      if (document.querySelector('dialog:modal, select:open, [popover]:popover-open')) return
      event.preventDefault()
      toggle(false)
      document.querySelector<HTMLElement>('[aria-controls="notification-panel"]')?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open, toggle])

  return (
    <Presence id="notification-panel" role="region" aria-label="通知" open={open} preset="flyout" className="app-popover glass-strong fixed right-3 top-[52px] z-40 flex max-h-[calc(100vh-64px)] w-[340px] max-w-[calc(100vw-24px)] flex-col overflow-hidden border border-[var(--color-border-subtle)] shadow-[0_20px_60px_rgba(0,0,0,0.45)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-section font-semibold">通知</span>
          {unread > 0 ? <span className="text-caption text-accent-300">{unread} 未读</span> : null}
        </div>
        <div className="flex items-center gap-0.5">
          {unread > 0 ? (
            <button
              type="button"
              onClick={markAllRead}
              className="rounded-[4px] px-1.5 py-1 text-caption text-[var(--color-text-tertiary)] hover:bg-white/[0.06] hover:text-[var(--color-text-secondary)]"
            >
              全部已读
            </button>
          ) : null}
          <IconButton label="关闭通知" className="size-8" onClick={close}>
            <X className="size-4" />
          </IconButton>
        </div>
      </header>

      <div className="min-h-0 overflow-y-auto">
        <section className="px-4 pb-3 pt-3">
          <div className="mb-2 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            <Megaphone className="size-4" />
            公告
          </div>
          {announcements.length === 0 ? (
            <p className="py-2 text-ui leading-5 text-[var(--color-text-tertiary)]">
              暂无公告。启动时会从仓库的 release 清单拉取。
            </p>
          ) : (
            <div>
              {announcements.map((announcement) => (
                <article
                  key={announcement.id}
                  className="border-b border-[var(--color-border-subtle)] py-2.5 last:border-0 last:pb-0 first:pt-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-ui font-medium leading-5 text-[var(--color-text)]">
                      {announcement.title}
                    </h3>
                    <span className="shrink-0 text-caption text-[var(--color-text-tertiary)]">
                      {announcement.startsAt ? relative(announcement.startsAt) : ''}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-3 text-ui leading-[17px] text-[var(--color-text-secondary)]">
                    {preview(announcement.body)}
                  </p>
                  <div className="mt-1.5 flex items-center gap-3">
                    {announcement.action ? (
                      <button
                        type="button"
                        className="text-caption text-accent-300 hover:underline"
                        onClick={() => {
                          if (announcement.action?.kind === 'open_url' && announcement.action.url) {
                            void call(Ipc.openExternal, { url: announcement.action.url })
                          } else if (announcement.action?.kind === 'check_update') {
                            void checkForUpdates()
                          }
                        }}
                      >
                        {announcement.action.label}
                      </button>
                    ) : null}
                    {announcement.dismissible ? (
                      <button
                        type="button"
                        className="text-caption text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
                        onClick={() => void dismissAnnouncement(announcement.id)}
                      >
                        不再显示
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="border-t border-[var(--color-border-subtle)] px-4 pb-4 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-caption font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              应用内通知
            </span>
            <span className="text-caption tabular-nums text-[var(--color-text-tertiary)]">
              {notifications.length}
            </span>
          </div>
          {notifications.length === 0 ? (
            <p className="py-2 text-ui leading-5 text-[var(--color-text-tertiary)]">
              实例、依赖安装、下载与任务的结果会出现在这里。
            </p>
          ) : (
            <div>
              {notifications.slice(0, 8).map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2.5 border-b border-[var(--color-border-subtle)] py-2 last:border-0 last:pb-0 first:pt-0"
                >
                  <div className="mt-0.5 shrink-0">{toneIcon[item.tone]}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={cn(
                          'truncate text-ui leading-5',
                          item.read ? 'text-[var(--color-text-secondary)]' : 'font-medium text-[var(--color-text)]',
                        )}
                      >
                        {item.title}
                      </span>
                      <span className="shrink-0 text-caption text-[var(--color-text-tertiary)]">
                        {relative(item.createdAt)}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-caption leading-[16px] text-[var(--color-text-tertiary)]">
                      {item.message}
                    </p>
                  </div>
                  {!item.read ? <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent-400" /> : null}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Presence>
  )
}
