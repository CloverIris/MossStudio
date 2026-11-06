import { ExternalLink, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { Ipc } from '@shared/channels'
import type { UpdateChannel } from '@shared/install'
import { failedUpdateText } from '@shared/update'
import { call } from '../../lib/api'
import { useApp } from '../../store'
import { Button, ConfirmDialog, Group, Row, Section, Segmented, Spinner, Switch, useToast } from '../../components/ui'
import { checkedLabel, checkedTitle, notesLink, restartFeedback, settingsStatus } from '../../components/update/updateModel'
import { SectionBody, SwitchRow, errorText, useSaveSettings } from './fields'

const CHANNELS: Array<{ value: UpdateChannel; label: string }> = [
  { value: 'stable', label: '正式版' },
  { value: 'beta', label: '测试版' },
]

export function UpdatesSection(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const update = useApp((state) => state.update)
  const env = useApp((state) => state.env)
  const checkForUpdates = useApp((state) => state.checkForUpdates)
  const restart = useApp((state) => state.restartToUpdate)
  const rollback = useApp((state) => state.rollbackUpdate)
  const download = useApp((state) => state.downloadUpdate)
  const unskip = useApp((state) => state.unskipUpdate)
  const retryFailed = useApp((state) => state.retryFailedUpdate)
  const setChannel = useApp((state) => state.setUpdateChannel)
  const setAutoDownload = useApp((state) => state.setAutoDownloadUpdates)
  const save = useSaveSettings()
  const toast = useToast()
  const [checking, setChecking] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const current = update?.current ?? env?.appVersion

  async function testNotification(): Promise<void> {
    try {
      const shown = await call<boolean>(Ipc.notificationTest)
      toast.push(shown ? '已发送一条测试通知' : '系统没有显示通知，请在系统设置里允许 MossStudio 发送通知', shown ? 'success' : 'info')
    } catch (error) {
      toast.push(errorText(error), 'error')
    }
  }

  async function check(): Promise<void> {
    setChecking(true)
    const result = await checkForUpdates()
    setChecking(false)
    if (!result) toast.push('检查更新失败，请检查网络后重试', 'error')
    else if (result.phase === 'error') toast.push(`检查更新失败：${result.error ?? '请稍后重试'}`, 'error')
    else if (result.phase === 'idle') toast.push('已经是最新版本', 'success')
  }

  async function attempt(action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error) {
      toast.push(errorText(error), 'error')
    }
  }

  async function goBack(): Promise<void> {
    setConfirmRollback(false)
    await attempt(async () => {
      const result = await rollback()
      const feedback = restartFeedback(result, 'rollback')
      if (feedback) toast.push(feedback.text, feedback.tone)
    })
  }

  const supported = update?.supported ?? false
  const ready = update?.phase === 'ready'

  return (
    <SectionBody>
      <Section title="通知">
        <Group>
          <Row title="桌面通知" description="生成或下载完成、出错、有新版本时，用系统通知提醒你。">
            <Button tone="ghost" disabled={!settings.desktopNotifications} onClick={() => void testNotification()}>
              发送测试通知
            </Button>
            <Switch
              aria-label="桌面通知"
              checked={settings.desktopNotifications}
              onCheckedChange={(desktopNotifications) => void save({ desktopNotifications })}
            />
          </Row>
        </Group>
      </Section>

      <Section title="MossStudio 更新">
        <Group>
          <Row
            title={`MossStudio ${current ?? ''}`.trim()}
            description={
              update ? (
                <span data-update-status>
                  {settingsStatus(update)}
                  {supported ? <span title={checkedTitle(update.checkedAt)}> · {checkedLabel(update.checkedAt)}</span> : null}
                </span>
              ) : (
                '正在读取更新状态…'
              )
            }
          >
            {supported && update?.phase === 'available' ? (
              <Button tone="primary" onClick={() => void attempt(download)}>
                下载更新
              </Button>
            ) : supported && ready ? (
              <Button
                tone="primary"
                onClick={() =>
                  void attempt(async () => {
                    const feedback = restartFeedback(await restart(), 'restart')
                    if (feedback) toast.push(feedback.text, feedback.tone)
                  })
                }
              >
                <RotateCw className="size-4" />
                重启以更新
              </Button>
            ) : supported ? (
              <Button onClick={() => void check()} disabled={checking || update?.phase === 'checking'}>
                {checking || update?.phase === 'checking' ? <Spinner /> : null}检查更新
              </Button>
            ) : null}
          </Row>
          {supported && update ? (
            <>
              <SwitchRow
                title="自动下载更新"
                description="有新版本时在后台下载，重启后生效。关闭后，标题栏会提示你手动下载。"
                checked={update.autoDownload}
                onChange={(enabled) => void attempt(() => setAutoDownload(enabled))}
              />
              <Row title="更新渠道" description="测试版能更早用到新功能，但可能不够稳定。">
                <Segmented
                  label="更新渠道"
                  value={update.channel}
                  options={CHANNELS}
                  onChange={(channel) => void attempt(() => setChannel(channel))}
                />
              </Row>
              {update.failedVersion ? (
                <Row
                  title={failedUpdateText(update.failedVersion, update.current).title}
                  description={failedUpdateText(update.failedVersion, update.current).detail}
                >
                  <Button onClick={() => void attempt(retryFailed)}>再试一次</Button>
                </Row>
              ) : null}
              {update.skippedVersion ? (
                <Row
                  title={`已跳过 ${update.skippedVersion}`}
                  description="你回到了上一个版本，所以不再提示这个版本和更早的版本。想再试时可以重新安装。"
                >
                  <Button onClick={() => void attempt(unskip)}>安装 {update.skippedVersion}</Button>
                </Row>
              ) : null}
              {update.canRollback && update.previous ? (
                <Row title="回到上一个版本" description={`换回 ${update.previous}。新版本有问题时用它，作品、模型和设置都会保留。`}>
                  <Button onClick={() => setConfirmRollback(true)}>回到 {update.previous}</Button>
                </Row>
              ) : null}
            </>
          ) : null}
          <Row title="更新说明" description="每个版本改了什么。">
            <Button tone="ghost" onClick={() => void call(Ipc.openExternal, { url: notesLink(update) })}>
              查看
              <ExternalLink className="size-4" />
            </Button>
          </Row>
        </Group>
      </Section>

      <ConfirmDialog
        open={confirmRollback}
        title={`回到 ${update?.previous ?? '上一个版本'}？`}
        description={`MossStudio 会关闭并以 ${update?.previous ?? '上一个版本'} 重新打开。作品、模型和设置都会保留；之后仍可以再次更新。`}
        confirmLabel="回到上一个版本"
        destructive={false}
        onClose={() => setConfirmRollback(false)}
        onConfirm={() => void goBack()}
      />
    </SectionBody>
  )
}
