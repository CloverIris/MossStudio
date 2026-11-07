import { useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { UninstallInfo } from '@shared/setup'
import { call } from '../../lib/api'
import { Button, Spinner } from '../../components/ui'
import { Checkbox } from '../../components/common/Checkbox'
import { Notice } from '../../components/common/Notice'
import { FailureBlock, ProgressBlock, Screen } from './parts'
import { dataChoiceText, uninstallSummary } from './uninstallModel'
import { ScreenHeading, WindowChrome } from './WindowChrome'

interface UninstallRun {
  status: 'running' | 'failed'
  error: string | null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The uninstall window (`#/uninstall`): one question, then progress until the app quits. */
export function UninstallPage(): React.JSX.Element {
  const [state, setState] = useState<UninstallInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [removeData, setRemoveData] = useState(false)
  const [run, setRun] = useState<UninstallRun | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let canceled = false
    void call<UninstallInfo>(Ipc.uninstallInfo)
      .then((next) => {
        if (!canceled) setState(next)
      })
      .catch((error: unknown) => {
        if (!canceled) setLoadError(`没能读取安装信息：${message(error)}`)
      })
    return () => {
      canceled = true
    }
  }, [])

  async function start(): Promise<void> {
    setStarting(true)
    setRun({ status: 'running', error: null })
    try {
      // Main writes the plan and quits; this screen stays until the window goes away.
      await call(Ipc.uninstallStart, { removeData })
    } catch (error) {
      setRun({ status: 'failed', error: message(error) })
      // E.g. MossStudio was still open: re-read, so 重试 works once it has been closed.
      void call<UninstallInfo>(Ipc.uninstallInfo)
        .then(setState)
        .catch(() => undefined)
    } finally {
      setStarting(false)
    }
  }

  const close = (): void => void call(Ipc.installQuit).catch(() => window.close())
  const running = run?.status === 'running'
  const screen = !state ? 'loading' : !run ? 'confirm' : run.status === 'failed' ? 'failed' : 'progress'

  return (
    <WindowChrome title="卸载 MossStudio" onClose={close} closeDisabled={running}>
      <div data-uninstall-screen={screen} className="h-full">
        {screen === 'loading' ? (
          <Screen
            actions={
              loadError ? (
                <Button size="lg" onClick={close}>
                  关闭
                </Button>
              ) : undefined
            }
          >
            <ScreenHeading title="卸载 MossStudio" subtitle={loadError ?? undefined} />
            {loadError ? null : (
              <div className="flex items-center gap-2 text-ui text-ink-2" role="status">
                <Spinner />
                正在读取…
              </div>
            )}
          </Screen>
        ) : null}

        {screen === 'confirm' && state ? (
          <Screen
            actions={
              <>
                <Button tone="ghost" size="lg" onClick={close}>
                  取消
                </Button>
                <Button tone="danger" size="lg" disabled={starting} onClick={() => void start()}>
                  {starting ? <Spinner /> : null}卸载
                </Button>
              </>
            }
          >
            <ScreenHeading title="卸载 MossStudio" subtitle={`版本 ${state.version}。${uninstallSummary(removeData, state.method)}`} />
            <div className="rounded-xl bg-surface p-1.5">
              <Checkbox
                checked={removeData}
                onCheckedChange={setRemoveData}
                label="同时删除我的数据（作品、模型、设置）"
                description={dataChoiceText({ dataBytes: state.dataBytes, dataRoot: state.dataRoot })}
              />
            </div>
            {removeData ? <Notice tone="danger">作品、模型和设置会被永久删除，无法恢复。需要的话请先备份。</Notice> : null}
            {state.running ? (
              <Notice tone="warn" data-app-running>
                MossStudio 还开着。点“卸载”后，请在它弹出的对话框里关闭它，然后回到这里重试。
              </Notice>
            ) : null}
          </Screen>
        ) : null}

        {screen === 'progress' ? (
          <Screen>
            <ScreenHeading
              title="正在卸载 MossStudio"
              subtitle={
                state?.method === 'trash' ? 'MossStudio 会移到废纸篓，然后自动关闭。' : 'MossStudio 会自动关闭，剩下的文件随后删除。'
              }
            />
            <ProgressBlock label="正在卸载…" percent={null} />
          </Screen>
        ) : null}

        {screen === 'failed' ? (
          <Screen
            actions={
              <>
                <Button tone="ghost" size="lg" onClick={close}>
                  关闭
                </Button>
                <Button tone="primary" size="lg" disabled={starting} onClick={() => void start()}>
                  {starting ? <Spinner /> : null}重试
                </Button>
              </>
            }
          >
            <ScreenHeading title="卸载没有完成" subtitle="MossStudio 还在电脑上，可以重试。" />
            <FailureBlock>
              <p className="text-control text-ink">{run?.error ?? '卸载时出了问题。'}</p>
            </FailureBlock>
          </Screen>
        ) : null}
      </div>
    </WindowChrome>
  )
}
