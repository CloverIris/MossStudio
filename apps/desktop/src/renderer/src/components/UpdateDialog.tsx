import { AlertTriangle, CheckCircle2, Download, ExternalLink, X } from 'lucide-react'
import { useMemo } from 'react'
import { Ipc } from '@shared/channels'
import { call } from '../lib/api'
import { useApp } from '../store'
import { Button, MarkdownBody, Modal, Pill, ProgressBar, Spinner, cn, useToast } from './ui'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

function formatSpeed(bytes: number): string {
  return bytes > 0 ? `${formatBytes(bytes)}/s` : '—'
}

function platformLabel(platform: string): string {
  return platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform
}

function archLabel(arch: string): string {
  return arch === 'arm64' ? 'Apple Silicon' : arch === 'x64' ? 'Intel/AMD64' : arch
}

export function UpdateDialog(): React.JSX.Element | null {
  const toast = useToast()
  const updates = useApp((state) => state.updates)
  const open = useApp((state) => state.updateDialogOpen)
  const settings = useApp((state) => state.settings)
  const download = useApp((state) => state.updateDownload)
  const setOpen = useApp((state) => state.setUpdateDialogOpen)
  const saveSettings = useApp((state) => state.saveSettings)
  const startDownload = useApp((state) => state.startUpdateDownload)
  const cancelDownload = useApp((state) => state.cancelUpdateDownload)

  const version = updates?.latestVersion
  const activeDownload = download && download.version === version ? download : null
  const downloading =
    activeDownload?.phase === 'downloading' || activeDownload?.phase === 'verifying'
  const finished = activeDownload?.phase === 'ready' || activeDownload?.phase === 'opened'
  const installer = updates?.installer ?? null

  const releaseNotes = useMemo(() => {
    const notes = updates?.releaseNotes?.trim()
    return notes || '这次发布没有附加说明。'
  }, [updates?.releaseNotes])

  if (!open || !updates || !version) return null

  function later(): void {
    void saveSettings({ dismissedUpdateVersion: version })
    setOpen(false)
  }

  function openReleasePage(): void {
    if (updates?.releaseUrl) {
      void call(Ipc.openExternal, { url: updates.releaseUrl })
      return
    }
    void call(Ipc.openExternal, {
      url: 'https://github.com/CloverIris/MossStudio/releases',
    })
  }

  async function begin(): Promise<void> {
    try {
      await startDownload()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (downloading) setOpen(false)
        else later()
      }}
      title={`发现新版本 ${version}`}
      description={`当前 ${updates.currentVersion} · ${updates.channel === 'beta' ? 'Beta' : '稳定版'}${
        updates.publishedAt ? ` · ${new Date(updates.publishedAt).toLocaleDateString('zh-CN')}` : ''
      }`}
      width="max-w-3xl"
      footer={
        <>
          {downloading ? (
            <Button tone="ghost" className="mr-auto" onClick={() => void cancelDownload()}>
              取消下载
            </Button>
          ) : (
            <Button tone="ghost" className="mr-auto" onClick={later}>
              {finished ? '关闭' : '稍后'}
            </Button>
          )}
          {updates.releaseUrl ? (
            <Button tone="secondary" onClick={openReleasePage}>
              <span className="inline-flex items-center gap-1.5">
                <ExternalLink className="size-4" /> 发布页
              </span>
            </Button>
          ) : null}
          {installer && !finished ? (
            <Button tone="primary" onClick={() => void begin()} disabled={downloading}>
              <span className="inline-flex items-center gap-1.5">
                {downloading ? <Spinner className="size-4" /> : <Download className="size-4" />}
                {downloading ? '下载中' : '下载并安装'}
              </span>
            </Button>
          ) : null}
          {!installer ? (
            <Button tone="primary" onClick={openReleasePage}>
              打开发布页
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone="accent">v{version}</Pill>
          <Pill tone="neutral">{updates.channel === 'beta' ? 'Beta' : '稳定版'}</Pill>
          {updates.mandatory ? <Pill tone="amber">重要更新</Pill> : null}
          {installer ? (
            <Pill tone="neutral">
              {platformLabel(installer.platform)} · {archLabel(installer.arch)} · {installer.kind} ·{' '}
              {formatBytes(installer.size_bytes)}
            </Pill>
          ) : (
            <Pill tone="amber">当前平台暂无安装包</Pill>
          )}
          {updates.manifestSource === 'cache' ? <Pill tone="neutral">来自缓存</Pill> : null}
        </div>

        {!installer ? (
          <div className="flex items-start gap-2 rounded-[5px] border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2.5 text-ui leading-5 text-amber-200">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              这份发布没有为你的平台提供安装包。可以打开发布页手动下载；下载/安装链路不会在缺少
              sha256 的情况下执行。
            </span>
          </div>
        ) : (
          <div className="rounded-[5px] border border-[var(--color-border-subtle)] bg-white/[0.025] px-3 py-2.5 text-ui leading-5 text-[var(--color-text-tertiary)]">
            下载完成后会校验 sha256 并打开安装程序；你仍需在系统安装界面完成安装。当前构建未签名时，
            系统可能要求手动确认。
          </div>
        )}

        {activeDownload ? (
          <div className="rounded-[5px] border border-[var(--color-border-subtle)] bg-white/[0.03] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-ui text-[var(--color-text-secondary)]">
                {activeDownload.phase === 'downloading' ? <Spinner className="size-4" /> : null}
                <span>
                  {activeDownload.phase === 'downloading'
                    ? '正在下载安装包'
                    : activeDownload.phase === 'verifying'
                      ? '正在校验 sha256'
                      : activeDownload.phase === 'opened'
                        ? '安装程序已打开'
                        : activeDownload.phase === 'ready'
                          ? '安装包已就绪'
                          : activeDownload.phase === 'canceled'
                            ? '下载已取消'
                            : '下载失败'}
                </span>
              </div>
              <span className="text-caption tabular-nums text-[var(--color-text-tertiary)]">
                {formatBytes(activeDownload.bytes)} / {formatBytes(activeDownload.totalBytes)}
                {activeDownload.phase === 'downloading'
                  ? ` · ${formatSpeed(activeDownload.speedBps)}`
                  : ''}
              </span>
            </div>
            <ProgressBar
              value={activeDownload.percent}
              tone={activeDownload.phase === 'error' ? 'neutral' : 'accent'}
              className="mt-2"
            />
            {activeDownload.phase === 'ready' || activeDownload.phase === 'opened' ? (
              <div className="mt-2 flex items-center gap-1.5 text-ui text-[var(--color-text-tertiary)]">
                <CheckCircle2 className="size-4 text-accent-300" />
                <span className="truncate">{activeDownload.path}</span>
              </div>
            ) : null}
            {activeDownload.error ? (
              <p
                className={cn(
                  'mt-2 text-ui leading-5',
                  activeDownload.phase === 'canceled' ? 'text-[var(--color-text-tertiary)]' : 'text-red-300',
                )}
              >
                {activeDownload.error}
              </p>
            ) : null}
          </div>
        ) : null}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-ui font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              发布说明
            </h3>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-caption text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
              onClick={() => setOpen(false)}
            >
              <X className="size-4" /> 收起
            </button>
          </div>
          <div className="max-h-[34vh] overflow-y-auto rounded-[5px] border border-[var(--color-border-subtle)] bg-black/15 px-3 py-2.5">
            <MarkdownBody>{releaseNotes}</MarkdownBody>
          </div>
        </div>
      </div>
    </Modal>
  )
}
