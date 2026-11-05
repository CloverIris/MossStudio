import { useState } from 'react'
import { Ipc } from '@shared/channels'
import type { Settings } from '@shared/types'
import { call } from '../../lib/api'
import { useApp } from '../../store'
import { Advanced, Button, Group, Row, Section, Select, Spinner, Switch, useToast } from '../../components/ui'
import { SectionBody, SwitchRow, errorText, useSaveSettings } from './fields'

export function UpdatesSection(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const updates = useApp((state) => state.updates)
  const env = useApp((state) => state.env)
  const checkForUpdates = useApp((state) => state.checkForUpdates)
  const setUpdateDialogOpen = useApp((state) => state.setUpdateDialogOpen)
  const save = useSaveSettings()
  const toast = useToast()
  const [checking, setChecking] = useState(false)
  const current = updates?.currentVersion ?? env?.appVersion

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
    else if (result.updateAvailable) setUpdateDialogOpen(true)
    else if (result.error) toast.push(`检查更新失败：${result.error}`, 'error')
    else toast.push('已经是最新版本', 'success')
  }

  return (
    <SectionBody>
      <Section title="通知">
        <Group>
          <Row title="桌面通知" description="生成或下载完成、出错、有新版本时，用系统通知提醒你。">
            <Button tone="ghost" disabled={!settings.desktopNotifications} onClick={() => void testNotification()}>发送测试通知</Button>
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
            description={updates?.updateAvailable && updates.latestVersion ? `有新版本 ${updates.latestVersion}` : updates ? '已经是最新版本' : undefined}
          >
            {updates?.updateAvailable ? (
              <Button onClick={() => setUpdateDialogOpen(true)}>查看更新</Button>
            ) : (
              <Button onClick={() => void check()} disabled={checking}>{checking ? <Spinner /> : null}检查更新</Button>
            )}
          </Row>
          <SwitchRow
            title="自动检查更新"
            description="启动时和使用过程中定期检查。关闭后不会弹出更新提示，标题栏仍会显示有新版本。"
            checked={settings.autoCheckUpdates}
            onChange={(autoCheckUpdates) => void save({ autoCheckUpdates })}
          />
        </Group>
      </Section>

      <Group>
        <Advanced summary={`更新渠道：${settings.updateChannel === 'beta' ? '测试版' : '正式版'}`}>
          <Row title="更新渠道" description="测试版能更早用到新功能，但可能不稳定。">
            <Select
              aria-label="更新渠道"
              className="w-32"
              value={settings.updateChannel}
              onValueChange={(value) => void save({ updateChannel: value as Settings['updateChannel'] })}
              options={[
                { value: 'stable', label: '正式版' },
                { value: 'beta', label: '测试版' },
              ]}
            />
          </Row>
        </Advanced>
      </Group>
    </SectionBody>
  )
}
