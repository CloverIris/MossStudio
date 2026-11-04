import { Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { Ipc } from '@shared/channels'
import { call } from '../../lib/api'
import { useGpuInventory } from '../../lib/useGpuInventory'
import { useApp } from '../../store'
import { Advanced, Button, Group, IconButton, Row, Section, Spinner, StatusDot, useCopyText } from '../../components/ui'
import { SectionBody } from './fields'
import { diagnosticsReport } from './diagnosticsReport'
import { useAppInfo } from './useAppInfo'

const REPOSITORY = 'https://github.com/CloverIris/MossStudio'
const QQ_GROUP = '1044887698'

export function AboutSection(): React.JSX.Element {
  const info = useAppInfo()
  const settings = useApp((state) => state.settings)
  const env = useApp((state) => state.env)
  const scanning = useApp((state) => state.scanning)
  const refreshEnv = useApp((state) => state.refreshEnv)
  const engine = useApp((state) => state.engineReadiness)
  const diagnostics = useApp((state) => state.diagnostics)
  const { inventory } = useGpuInventory()
  const copyText = useCopyText()
  const checks = env?.checks ?? []
  const problems = checks.filter((check) => check.status === 'error' || check.status === 'warn').length

  return (
    <SectionBody>
      <Section title="MossStudio">
        <Group>
          <Row title="版本" description={info ? `Electron ${info.electron} · Node ${info.node}` : undefined}>
            <span className="tabular text-control text-ink">{info?.version ?? env?.appVersion ?? '—'}</span>
          </Row>
          <Row title="开源" description="MossStudio 以 MIT 许可证开源，欢迎在 GitHub 上提问题和参与开发。">
            <Button onClick={() => void call(Ipc.openExternal, { url: REPOSITORY })}>
              GitHub<ExternalLink className="size-4" />
            </Button>
          </Row>
          <Row title="QQ 交流群" description={QQ_GROUP}>
            <IconButton label="复制群号" onClick={() => void copyText(QQ_GROUP, '群号已复制')}><Copy className="size-4" /></IconButton>
          </Row>
        </Group>
      </Section>

      <Section title="遇到问题">
        <Group>
          <Row title="复制诊断信息" description="包含版本、显卡、引擎状态和最近的问题，不包含令牌、密码或主机地址。提问时一起发出来。">
            <Button onClick={() => void copyText(diagnosticsReport({ info, env, gpu: inventory, engine, settings, diagnostics }), '诊断信息已复制')}>
              <Copy className="size-4" />复制
            </Button>
          </Row>
        </Group>
      </Section>

      <Group>
        <Advanced summary={env ? problems ? `环境检查：${problems} 项需要注意` : '环境检查：全部正常' : '环境检查'}>
          <div className="flex flex-col gap-0.5">
            {checks.map((check) => (
              <Row
                key={check.id}
                leading={<StatusDot status={check.status} />}
                title={check.label}
                description={[check.value, check.detail].filter(Boolean).join(' · ')}
              />
            ))}
            {!env ? <Row title="正在检测…" /> : null}
            <div className="flex justify-end px-3.5 py-2">
              <Button tone="ghost" onClick={() => void refreshEnv()} disabled={scanning}>
                {scanning ? <Spinner /> : <RefreshCw className="size-4" />}重新检测
              </Button>
            </div>
          </div>
        </Advanced>
      </Group>
    </SectionBody>
  )
}
