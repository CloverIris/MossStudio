import { useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { UninstallInfo } from '@shared/setup'
import { call } from '../../lib/api'
import { Button, Modal, Row, Spinner, useToast } from '../../components/ui'
import { Checkbox } from '../../components/common/Checkbox'
import { dataChoiceText, uninstallEntry, uninstallSummary } from '../install/uninstallModel'
import { errorText } from './fields'

/** main/install supports uninstall:start from the main window on Windows too (confirmed by Installer). */
const IN_APP_ON_WINDOWS = true

/** 设置 › 关于 › 卸载: the same question as the uninstall window, asked in a dialog. */
export function UninstallRow(): React.JSX.Element | null {
  const toast = useToast()
  const [info, setInfo] = useState<UninstallInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [removeData, setRemoveData] = useState(false)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let canceled = false
    // Dev and loose builds have nothing installed: main refuses, and the row stays away.
    void call<UninstallInfo>(Ipc.uninstallInfo)
      .then((next) => {
        if (!canceled) setInfo(next)
      })
      .catch(() => undefined)
    return () => {
      canceled = true
    }
  }, [])

  const entry = uninstallEntry({ platform: info?.platform ?? window.clover.platform, info, inAppOnWindows: IN_APP_ON_WINDOWS })
  if (entry.kind === 'none' || !info) return null
  if (entry.kind !== 'button') return <Row title="卸载 MossStudio" description={entry.text} />

  async function start(): Promise<void> {
    setStarting(true)
    try {
      await call(Ipc.uninstallStart, { removeData })
    } catch (error) {
      setStarting(false)
      toast.push(`没能卸载：${errorText(error)}`, 'error')
    }
  }

  return (
    <>
      <Row
        title="卸载 MossStudio"
        description={
          info.method === 'trash'
            ? '把 MossStudio 移到废纸篓，可以选择是否保留你的数据。'
            : '删除 MossStudio 的程序文件和快捷方式，可以选择是否保留你的数据。'
        }
      >
        <Button
          tone="danger"
          onClick={() => {
            setRemoveData(false)
            setOpen(true)
          }}
        >
          卸载…
        </Button>
      </Row>
      <Modal
        open={open}
        onClose={() => {
          if (!starting) setOpen(false)
        }}
        title="卸载 MossStudio"
        description={uninstallSummary(removeData, info.method)}
        width="max-w-lg"
        footer={
          <>
            <Button tone="ghost" size="md" data-dialog-initial-focus disabled={starting} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button tone="danger" size="md" disabled={starting} onClick={() => void start()}>
              {starting ? <Spinner /> : null}卸载
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <div className="-mx-1 rounded-xl bg-panel p-1.5">
            <Checkbox
              checked={removeData}
              onCheckedChange={setRemoveData}
              disabled={starting}
              label="同时删除我的数据（作品、模型、设置）"
              description={dataChoiceText({ dataBytes: info.dataBytes, dataRoot: info.dataRoot })}
            />
          </div>
          {removeData ? (
            <p className="text-ui text-danger" role="status">
              作品、模型和设置会被永久删除，无法恢复。需要的话请先备份。
            </p>
          ) : null}
          {starting ? (
            <p className="text-ui text-ink-2" role="status">
              正在卸载，MossStudio 马上会关闭…
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  )
}
