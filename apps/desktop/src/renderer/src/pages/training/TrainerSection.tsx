import { useState } from 'react'
import { Ipc } from '@shared/channels'
import type { TrainerVersion, TrainingHost } from '@shared/types'
import { call } from '../../lib/api'
import { dateTime } from '../../lib/format'
import { Advanced, Button, Group, Modal, Pill, Row, Section, Spinner, StatusDot, useToast } from '../../components/ui'
import { TrainerAdvanced } from './TrainerAdvanced'
import { PREPARE_STEP_LABEL, RUNTIME_LABEL, currentVersion, prepareTrainer, trainerApi, type PrepareStep } from './trainerSetup'

interface DoctorResult {
  ok: boolean
  output: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Trainer version, environment and its advanced settings for one location. */
export function TrainerSection({
  hostId,
  host,
  versions,
  loading,
  onChanged,
}: {
  hostId: string
  host: TrainingHost | undefined
  versions: TrainerVersion[]
  loading: boolean
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const toast = useToast()
  const [step, setStep] = useState<PrepareStep | null>(null)
  const [checking, setChecking] = useState(false)
  const [doctor, setDoctor] = useState<DoctorResult | null>(null)
  const version = currentVersion(versions, hostId)
  const ready = version?.runtimeState === 'ready'
  const busy = step !== null
  const where = hostId === 'local' ? '本机' : (host?.name ?? '远程主机')

  async function prepare(): Promise<void> {
    if (busy) return
    try {
      const result = await prepareTrainer(trainerApi(call, hostId), version, setStep)
      toast.push(
        !version ? `训练器已在${where}准备好` : result.updated ? `训练器已更新到 ${result.version.shortCommit}` : '训练器已是最新',
        'success',
      )
    } catch (error) {
      toast.push(`准备训练器失败：${errorText(error)}`, 'error')
    } finally {
      setStep(null)
      await onChanged().catch(() => undefined)
    }
  }

  async function installEnvironment(target: TrainerVersion): Promise<void> {
    if (busy) return
    setStep('install')
    try {
      await trainerApi(call, hostId).install(target)
      toast.push('训练环境已就绪', 'success')
    } catch (error) {
      toast.push(`安装训练环境失败：${errorText(error)}`, 'error')
    } finally {
      setStep(null)
      await onChanged().catch(() => undefined)
    }
  }

  async function runDoctor(target: TrainerVersion): Promise<void> {
    setChecking(true)
    try {
      setDoctor(
        hostId === 'local'
          ? await call<DoctorResult>(Ipc.trainerDoctor, { id: target.id })
          : await call<DoctorResult>(Ipc.trainerRemoteDoctor, { hostId, versionId: target.id }),
      )
    } catch (error) {
      toast.push(`体检没有完成：${errorText(error)}`, 'error')
    } finally {
      setChecking(false)
    }
  }

  const versionDescription = step
    ? PREPARE_STEP_LABEL[step]
    : version
      ? `${version.branch} · ${dateTime(version.commitDate)}${version.dirty ? ' · 有本地修改' : ''}`
      : loading
        ? '正在读取…'
        : `${where}还没有训练器。准备时会下载训练器并安装所需环境，需要几分钟。`

  return (
    <Section title="训练器">
      <Group>
        <Row
          title={version ? `KohakuMossTrainer ${version.shortCommit}` : '训练器未准备'}
          description={versionDescription}
          leading={busy ? <Spinner className="text-ink-2" /> : undefined}
        >
          <Button onClick={() => void prepare()} disabled={busy || loading}>
            {version ? '检查更新' : '准备训练器'}
          </Button>
        </Row>
        <Row
          title="环境"
          description={version ? `${RUNTIME_LABEL[version.runtimeState]} · ${where}` : '准备训练器后自动安装'}
          leading={<StatusDot status={ready ? 'ok' : version?.runtimeState === 'error' ? 'error' : 'unknown'} />}
        >
          {version && !ready ? (
            <Button onClick={() => void installEnvironment(version)} disabled={busy}>
              {version.runtimeState === 'error' ? '重新安装' : '安装环境'}
            </Button>
          ) : null}
          <Button tone="ghost" onClick={() => version && void runDoctor(version)} disabled={!ready || checking || busy}>
            {checking ? <Spinner /> : null}
            体检
          </Button>
        </Row>
        <Advanced summary="Python 路径、PyTorch、pip 源、训练器目录、版本管理">
          <TrainerAdvanced hostId={hostId} versions={versions} busy={busy} onChanged={onChanged} />
        </Advanced>
      </Group>

      <Modal
        open={Boolean(doctor)}
        onClose={() => setDoctor(null)}
        title="环境体检"
        description={doctor?.ok ? '没有发现问题。' : '发现了问题，详情见下方输出。'}
        width="max-w-3xl"
        footer={
          <Button tone="secondary" size="md" onClick={() => setDoctor(null)}>
            关闭
          </Button>
        }
      >
        <div className="flex flex-col gap-2">
          <div>
            <Pill tone={doctor?.ok ? 'ok' : 'warn'}>{doctor?.ok ? '通过' : '需要处理'}</Pill>
          </div>
          <pre className="selectable max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg bg-well p-3 font-mono text-caption text-ink-2">
            {doctor?.output || '没有输出'}
          </pre>
        </div>
      </Modal>
    </Section>
  )
}
