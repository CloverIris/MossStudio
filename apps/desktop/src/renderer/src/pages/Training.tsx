import { Plus } from 'lucide-react'
import { openWindow } from '../lib/windows'
import { useApp } from '../store'
import { Notice } from '../components/common/Notice'
import { Button, PageHeader, PageScroll, Select } from '../components/ui'
import { currentVersion } from './training/trainerSetup'
import { TrainerSection } from './training/TrainerSection'
import { TrainingRuns } from './training/TrainingRuns'
import { useTrainerData } from './training/useTrainerData'

/** 训练: an optional feature, shown in the rail only when it is turned on. */
export function TrainingPage(): React.JSX.Element {
  const remoteHostsEnabled = useApp((state) => state.settings?.remoteHostsEnabled ?? false)
  const env = useApp((state) => state.env)
  const { hosts, sshHosts, versions, loading, hostId, setHostId, refresh } = useTrainerData()
  const host = hosts.find((item) => item.id === hostId)
  const noLocalGpu = hostId === 'local' && env !== null && env.gpu.kind !== 'nvidia'
  const ready = currentVersion(versions, hostId)?.runtimeState === 'ready'
  const runs = <TrainingRuns hostId={hostId} />

  return (
    <PageScroll>
      <PageHeader
        title="训练"
        description="用自己的图片训练 LoRA。训练好的 LoRA 会出现在创作里。"
        actions={
          <>
            {remoteHostsEnabled && sshHosts.length > 0 ? (
              <Select
                aria-label="训练位置"
                className="w-[200px]"
                value={hostId}
                onValueChange={setHostId}
                options={[{ value: 'local', label: '本机' }, ...sshHosts.map((item) => ({ value: item.id, label: item.name }))]}
              />
            ) : null}
            <Button tone="primary" size="md" onClick={() => openWindow('trainer')}>
              <Plus className="size-4" strokeWidth={1.6} aria-hidden="true" />
              新建训练
            </Button>
          </>
        }
      />

      {noLocalGpu ? (
        <Notice tone="warn" role="status">
          这台电脑没有检测到 NVIDIA 显卡，训练需要 NVIDIA 显卡才能运行。
          {remoteHostsEnabled
            ? sshHosts.length
              ? '可以在右上角把训练位置换成一台远程主机。'
              : '可以在 设置 › 设备与引擎 添加一台带 NVIDIA 显卡的远程主机。'
            : ''}
        </Notice>
      ) : null}

      {/* Once the trainer is ready, the work (训练记录) comes first and its setup moves below. */}
      {ready ? runs : null}
      <TrainerSection hostId={hostId} host={host} versions={versions} loading={loading} onChanged={refresh} />
      {ready ? null : runs}
    </PageScroll>
  )
}
