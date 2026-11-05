import { RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { engineDisplayVersion, engineUpdateStatus, parseEngineStamp, type EngineUpdateStatus } from '@shared/engineUpdate'
import { engineDownloadActive, engineDownloadLabel, engineDownloadPercent, engineInstallError } from '../../lib/engineInstall'
import { featureVisibility } from '../../lib/features'
import { useGpuInventory } from '../../lib/useGpuInventory'
import { useApp } from '../../store'
import { Advanced, Button, Group, IconButton, ProgressBar, Row, Section, Spinner, StatusDot, useToast } from '../../components/ui'
import { gpuEmptyMessage, gpuRows, savedGpuMissing } from './devicesModel'
import { EngineAdvanced } from './EngineAdvanced'
import { SectionBody, SwitchRow, useSaveSettings } from './fields'
import { RemoteHosts } from './RemoteHosts'
import { sectionPath } from './sections'
import { useEngine, type EngineState, type InstallOutcome } from './useEngine'

export function DevicesSection(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const navigate = useNavigate()
  const gpu = useGpuInventory()
  const engine = useEngine(gpu.inventory)
  const { remoteHosts } = featureVisibility(settings)

  return (
    <SectionBody>
      <GpuGroup gpu={gpu} engine={engine} />
      <EngineGroup engine={engine} />
      <Group>
        <Advanced summary="显存模式、性能档位、渠道、CUDA、包类型、自定义引擎、引擎目录">
          <EngineAdvanced engine={engine} inventory={gpu.inventory} />
        </Advanced>
      </Group>
      {remoteHosts ? <RemoteHosts /> : (
        <Section title="远程主机">
          <Group>
            <Row title="未开启" description="开启后可以把生成和训练放到 SSH 主机上运行。">
              <Button onClick={() => navigate(sectionPath('features'))}>在功能中开启</Button>
            </Row>
          </Group>
        </Section>
      )}
    </SectionBody>
  )
}

function GpuGroup({ gpu, engine }: { gpu: ReturnType<typeof useGpuInventory>; engine: EngineState }): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const telemetry = useApp((state) => state.gpuTelemetry)
  const save = useSaveSettings()
  const rows = gpuRows(gpu.inventory, engine.probe, telemetry, settings.gpuSelection)
  const automatic = settings.gpuSelection === 'auto'
  const missing = savedGpuMissing(gpu.inventory, settings.gpuSelection)

  return (
    <Section
      title="GPU"
      description={rows.length > 1 ? (automatic ? '自动把任务交给空闲且更快的 GPU。也可以固定一块作为默认。' : '新的任务默认交给这块 GPU。') : undefined}
      actions={(
        <IconButton label="重新检测显卡" onClick={() => void gpu.refresh()} disabled={gpu.refreshing}>
          <RefreshCw className={gpu.refreshing ? 'size-4 animate-spin' : 'size-4'} />
        </IconButton>
      )}
    >
      <Group>
        {rows.map((row) => (
          <Row key={row.uuid} title={row.name} description={row.reason ? `${row.detail} · ${row.reason}` : row.detail}>
            {row.isDefault || rows.length === 1 ? null : (
              <Button onClick={() => void save({ gpuSelection: { uuid: row.uuid } })}>设为默认</Button>
            )}
            <span className="flex items-center gap-1.5 text-caption text-ink-2"><StatusDot status={row.status} />{row.statusLabel}</span>
          </Row>
        ))}
        {rows.length === 0 ? <Row title={gpu.inventory ? '没有可用的显卡' : '正在检测显卡…'} description={gpu.inventory ? gpuEmptyMessage(gpu.inventory) : undefined} /> : null}
        {missing ? (
          <Row title="之前选的默认 GPU 没有连接" description="连接后会继续使用它；现在可以改为自动选择。">
            <Button onClick={() => void save({ gpuSelection: 'auto' })}>改为自动</Button>
          </Row>
        ) : !automatic && rows.length > 1 ? (
          <Row title="自动选择" description="不固定默认 GPU，由 MossStudio 按空闲程度分配。">
            <Button onClick={() => void save({ gpuSelection: 'auto' })}>改为自动</Button>
          </Row>
        ) : null}
        {engine.probeError && rows.length > 0 ? (
          <Row title="没能检测显卡兼容性" description={engine.probeError}>
            <Button onClick={() => void engine.runProbe()} disabled={engine.probing}>{engine.probing ? <Spinner /> : null}重试</Button>
          </Row>
        ) : null}
      </Group>
    </Section>
  )
}

function engineDescription(engine: EngineState, status: EngineUpdateStatus | null): string {
  const { readiness, download, current } = engine
  if (engineDownloadActive(download)) return engineDownloadLabel(download!)
  const error = engineInstallError(readiness, download)
  if (readiness?.state !== 'ready') return error ?? '生成图片需要推理引擎。安装时会按你的显卡自动选择版本。'
  const stamp = current?.source === 'managed' ? parseEngineStamp(current.name) : null
  const parts: string[] = []
  if (current?.source === 'external') parts.push('自定义引擎')
  else if (stamp) parts.push(stamp.channel === 'stable' ? '正式版' : '开发版')
  if (download?.phase === 'error') parts.push('上次更新失败，当前版本仍可用')
  else if (status?.kind === 'current') parts.push('已是最新')
  else if (status?.kind === 'available') parts.push(`有新版本 ${status.latest.tag.replace(/^v/i, '')}`)
  else if (engine.releasesError) parts.push(`检查更新失败：${engine.releasesError}`)
  return parts.join(' · ') || '已安装'
}

function EngineGroup({ engine }: { engine: EngineState }): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()
  const toast = useToast()
  const [starting, setStarting] = useState(false)
  const { readiness, download, current } = engine
  const ready = readiness?.state === 'ready'
  const installing = engineDownloadActive(download)
  const status = engine.releases ? engineUpdateStatus(current, engine.releases) : null
  const percent = installing ? engineDownloadPercent(download!) : null
  const version = engineDisplayVersion(current)

  function report(outcome: InstallOutcome): void {
    if (outcome.kind === 'failed') toast.push(outcome.message, 'error')
    if (outcome.kind === 'needs-cuda') toast.push('这台电脑缺少需要的 CUDA 运行库，请在高级里选择安装方式', 'error')
  }

  async function installNow(): Promise<void> {
    setStarting(true)
    report(await engine.installRecommended())
    setStarting(false)
  }

  async function check(): Promise<void> {
    const releases = await engine.loadReleases()
    if (!releases) return
    const next = engineUpdateStatus(current, releases)
    if (next.kind === 'current') toast.push('引擎已是最新版本', 'success')
    if (next.kind === 'unmanaged') toast.push('当前使用的不是正式版引擎，不会自动检查更新', 'info')
  }

  async function update(): Promise<void> {
    if (status?.kind !== 'available' || !current) return
    const stamp = parseEngineStamp(current.name)
    if (!stamp) return
    setStarting(true)
    report(await engine.install({
      channel: 'stable',
      variant: stamp.variant,
      flavour: stamp.flavour,
      architecture: settings.mossInferArchitecture,
      releaseTag: status.latest.tag,
      preflighted: true,
    }))
    setStarting(false)
  }

  let action: React.ReactNode
  if (installing) {
    action = <IconButton label="取消安装" onClick={() => void engine.cancelInstall()}><X className="size-4" /></IconButton>
  } else if (!ready) {
    action = <Button onClick={() => void installNow()} disabled={starting}>{starting ? <Spinner /> : null}安装引擎</Button>
  } else if (status?.kind === 'available') {
    action = <Button onClick={() => void update()} disabled={starting}>{starting ? <Spinner /> : null}更新</Button>
  } else {
    action = <Button onClick={() => void check()} disabled={engine.loadingReleases}>{engine.loadingReleases ? <Spinner /> : null}检查更新</Button>
  }

  return (
    <Section title="引擎">
      <Group>
        <div className="flex flex-col">
          <Row title={ready ? `MossInfer${version ? ` ${version}` : ''}` : 'MossInfer 未安装'} description={engineDescription(engine, status)}>
            {action}
          </Row>
          {installing ? (
            <div className="px-3.5 pb-3">
              {percent === null ? <ProgressBar value={100} tone="neutral" className="animate-pulse" label="正在安装引擎" /> : <ProgressBar value={percent} label="引擎下载进度" />}
            </div>
          ) : null}
        </div>
        <SwitchRow
          title="自动更新"
          description="有新的正式版时在后台自动安装。没有任务在运行时才会切换。"
          checked={settings.engineAutoUpdate}
          onChange={(engineAutoUpdate) => void save({ engineAutoUpdate })}
        />
      </Group>
    </Section>
  )
}
