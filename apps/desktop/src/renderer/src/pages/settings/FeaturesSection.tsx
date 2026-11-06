import { RefreshCw } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { WebAccessInfo } from '@shared/backend'
import { call } from '../../lib/api'
import { FEATURES, featureEnabled } from '../../lib/features'
import { integerInRange } from '../../lib/settingsDraft'
import { useApp } from '../../store'
import { PathValue } from '../../components/common/PathValue'
import { Button, Group, LoadingRow, Row, Section, useToast } from '../../components/ui'
import { SectionBody, SwitchRow, TextSetting, errorText, useSaveSettings } from './fields'

export function FeaturesSection(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()

  return (
    <SectionBody>
      <Section title="可选功能" description="这些功能默认关闭。关闭时，相关的按钮和页面都不会出现。">
        <Group>
          {FEATURES.map((feature) => (
            <SwitchRow
              key={feature.key}
              title={feature.label}
              description={feature.description}
              checked={featureEnabled(settings, feature.key)}
              onChange={(value) => void save({ [feature.key]: value })}
            />
          ))}
        </Group>
      </Section>
      {settings.lanWebEnabled ? <LanAccess /> : null}
    </SectionBody>
  )
}

function LanAccess(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()
  const toast = useToast()
  const [access, setAccess] = useState<WebAccessInfo | null>(null)
  const [qr, setQr] = useState('')
  const [rotating, setRotating] = useState(false)

  useEffect(() => {
    let canceled = false
    void call<WebAccessInfo>(Ipc.webAccessInfo)
      .then((next) => {
        if (!canceled) setAccess(next)
      })
      .catch((error: unknown) => {
        if (!canceled) setAccess({ ready: false, urls: [], token: null, port: null, instanceId: null, error: errorText(error) })
      })
    return () => {
      canceled = true
    }
  }, [settings.lanWebEnabled, settings.lanWebPort])

  // Phones reach the computer through its network address, not 127.0.0.1.
  const primary = useMemo(() => access?.urls?.find((url) => !url.includes('127.0.0.1') && !url.includes('localhost')) ?? '', [access])

  useEffect(() => {
    if (!primary) {
      setQr('')
      return
    }
    let canceled = false
    // Default black-on-white: inverted codes are not read by every phone camera.
    void QRCode.toDataURL(primary, { margin: 1, width: 176 })
      .then((url) => {
        if (!canceled) setQr(url)
      })
      .catch(() => {
        if (!canceled) setQr('')
      })
    return () => {
      canceled = true
    }
  }, [primary])

  async function rotate(): Promise<void> {
    setRotating(true)
    try {
      setAccess(await call<WebAccessInfo>(Ipc.webAccessRestart))
      toast.push('已换用新的访问地址，旧地址失效', 'success')
    } catch (error) {
      toast.push(errorText(error), 'error')
    } finally {
      setRotating(false)
    }
  }

  return (
    <Section title="局域网访问" description="地址里带有访问密钥，只发给你信任的设备。">
      <Group>
        {access?.urls?.length ? (
          <div className="flex gap-4 px-3.5 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {access.urls.map((url) => (
                <PathValue key={url} value={url} copy copyLabel="复制地址" />
              ))}
              <p className="text-caption text-ink-2">在手机上打开地址，或用相机扫右侧二维码。</p>
            </div>
            {qr ? <img src={qr} alt="访问地址二维码" className="size-[132px] shrink-0 rounded-lg" /> : null}
          </div>
        ) : access ? (
          <Row title="还没有可用的地址" description={access.error} />
        ) : (
          <LoadingRow label="正在读取地址…" className="px-3.5" />
        )}
        <TextSetting<number | null>
          inline
          title="端口"
          description="留空时自动选择。更改后服务会重新启动。"
          value={settings.lanWebPort}
          placeholder="自动"
          validate={integerInRange(1024, 65535, { optional: true })}
          parse={(text) => (text ? Number(text) : null)}
          type="number"
          inputClassName="w-28"
          onSave={(lanWebPort) => save({ lanWebPort })}
        />
        <Row title="更换访问密钥" description="之前发出去的地址会失效。">
          <Button onClick={() => void rotate()} disabled={rotating}>
            <RefreshCw className="size-4" strokeWidth={1.6} />
            更换
          </Button>
        </Row>
      </Group>
    </Section>
  )
}
