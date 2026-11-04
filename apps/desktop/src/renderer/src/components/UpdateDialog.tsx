import { AlertTriangle, CheckCircle2, Download, ExternalLink } from 'lucide-react'
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
  return arch === 'arm64' ? 'Apple 芯片' : arch === 'x64' ? '64 位' : arch
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
  const updating = ['downloading', 'verifying', 'extracting', 'installing'].includes(
    activeDownload?.phase ?? '',
  )
  const cancellable = ['downloading', 'verifying', 'extracting'].includes(activeDownload?.phase ?? '')
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
        if (updating) setOpen(false)
        else later()
      }}
      title={`MossStudio ${version} 可以更新了`}
      description={`当前版本 ${updates.currentVersion} · ${updates.channel === 'beta' ? '测试版' : '正式版'}${
        updates.publishedAt ? ` · ${new Date(updates.publishedAt).toLocaleDateString('zh-CN')} 发布` : ''
      }`}
      width="max-w-2xl"
      footer={
        <>
          {cancellable ? (
            <Button tone="ghost" size="md" className="mr-auto" onClick={() => void cancelDownload()}>
              取消下载
            </Button>
          ) : (
            <Button tone="ghost" size="md" className="mr-auto" onClick={later}>
              {finished ? '关闭' : '稍后'}
            </Button>
          )}
          {updates.releaseUrl && installer ? (
            <Button size="md" onClick={openReleasePage}>
              <ExternalLink className="size-4" />发布页
            </Button>
          ) : null}
          {installer && !finished ? (
            <Button tone="primary" size="md" onClick={() => void begin()} disabled={updating}>
              {updating ? <Spinner /> : <Download className="size-4" />}
              {activeDownload?.phase === 'extracting'
                ? '正在解压'
                : activeDownload?.phase === 'installing'
                  ? '正在准备重启'
                  : updating
                    ? '正在下载'
                    : '下载并更新'}
            </Button>
          ) : null}
          {!installer ? (
            <Button tone="primary" size="md" onClick={openReleasePage}>
              <ExternalLink className="size-4" />打开发布页
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {updates.mandatory ? <Pill tone="warn">重要更新</Pill> : null}
          {installer ? (
            <Pill tone="neutral">
              {platformLabel(installer.platform)} · {archLabel(installer.arch)} · {formatBytes(installer.size_bytes)}
            </Pill>
          ) : null}
        </div>

        {!installer ? (
          <div className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-ui text-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
            <span>这次发布没有适合你电脑的安装包，可以打开发布页手动下载。</span>
          </div>
        ) : !activeDownload ? (
          <p className="text-ui text-ink-2">
            下载完成后会先检查安装包是否完整，然后关闭 MossStudio、替换程序并自动重新打开。你的作品、模型和设置都会保留。
          </p>
        ) : null}

        {activeDownload ? (
          <div className="flex flex-col gap-2 rounded-lg bg-panel px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-ui text-ink">
                {updating ? <Spinner /> : null}
                {finished ? <CheckCircle2 className="size-4 text-ok" aria-hidden="true" /> : null}
                {activeDownload.phase === 'downloading'
                  ? '正在下载更新'
                  : activeDownload.phase === 'verifying'
                    ? '正在检查安装包'
                    : activeDownload.phase === 'extracting'
                      ? '正在解压'
                      : activeDownload.phase === 'installing'
                        ? '正在启动更新程序'
                        : activeDownload.phase === 'opened'
                          ? '更新程序已启动，MossStudio 即将重新打开'
                          : activeDownload.phase === 'ready'
                            ? '更新已准备好'
                            : activeDownload.phase === 'canceled'
                              ? '下载已取消'
                              : '下载失败'}
              </span>
              <span className="tabular text-caption text-ink-2">
                {formatBytes(activeDownload.bytes)} / {formatBytes(activeDownload.totalBytes)}
                {activeDownload.phase === 'downloading' ? ` · ${formatSpeed(activeDownload.speedBps)}` : ''}
              </span>
            </div>
            <ProgressBar
              value={activeDownload.percent}
              tone={activeDownload.phase === 'error' ? 'neutral' : 'accent'}
              label="更新下载进度"
            />
            {activeDownload.error ? (
              <p className={cn('text-ui', activeDownload.phase === 'canceled' ? 'text-ink-2' : 'text-danger')}>
                {activeDownload.error}
              </p>
            ) : null}
          </div>
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="text-ui font-semibold text-ink-2">更新内容</h3>
          <div className="max-h-[40vh] overflow-y-auto rounded-lg bg-panel px-3.5 py-3">
            <MarkdownBody>{releaseNotes}</MarkdownBody>
          </div>
        </section>
      </div>
    </Modal>
  )
}
