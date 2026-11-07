import { useState } from 'react'
import { Ipc } from '@shared/channels'
import type { TrainerVersion, TrainingHost } from '@shared/types'
import { call } from '../../lib/api'
import { dateTime } from '../../lib/format'
import { Advanced, Button, Group, Pill, Row, Section, Spinner, useToast } from '../../components/ui'
import { DoctorDialog, type DoctorResult } from './DoctorDialog'
import { TrainerAdvanced } from './TrainerAdvanced'
import { PREPARE_STEP_LABEL, currentVersion, prepareTrainer, trainerApi, type PrepareStep } from './trainerSetup'

/** The environment's state in a word or two; the row title already says 环境. */
const RUNTIME_STATE: Record<NonNullable<TrainerVersion['runtimeState']>, string> = {
  missing: '未安装',
  created: '未装完',
  installing: '正在安装',
  ready: '就绪',
  error: '安装失败',
}

function runtimeTone(state: TrainerVersion['runtimeState'] | undefined): 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' {
  if (state === 'ready') return 'ok'
  if (state === 'installing') return 'accent'
  if (state === 'error') return 'danger'
  if (state === 'created') return 'warn'
  return 'neutral'
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
      ? `版本 ${version.shortCommit} · ${version.branch} · ${dateTime(version.commitDate)}${version.dirty ? ' · 有本地修改' : ''}`
      : loading
        ? '正在读取…'
        : `${where}还没有训练器。准备时会下载训练器并安装所需环境，需要几分钟。`

  return (
    <Section title="训练器">
      <Group>
        {/* Both rows show their state the same way: a Pill on the right, like the version rows. */}
        <Row title="训练器" description={versionDescription}>
          {busy ? <Pill tone="accent">正在准备</Pill> : <Pill tone={version ? 'ok' : 'neutral'}>{version ? '已准备' : '未准备'}</Pill>}
          <Button onClick={() => void prepare()} disabled={busy || loading}>
            {version ? '检查更新' : '准备训练器'}
          </Button>
        </Row>
        <Row title="环境" description={version ? where : '准备训练器后自动安装'}>
          <Pill tone={runtimeTone(version?.runtimeState)}>{version ? RUNTIME_STATE[version.runtimeState] : '未安装'}</Pill>
          {version && !ready ? (
            <Button onClick={() => void installEnvironment(version)} disabled={busy}>
              {version.runtimeState === 'error' ? '重新安装' : '安装环境'}
            </Button>
          ) : null}
          <Button tone="ghost" onClick={() => version && void runDoctor(version)} disabled={!ready || checking || busy}>
            {checking ? <Spinner /> : null}
            环境体检
          </Button>
        </Row>
        <Advanced summary="Python 路径、PyTorch、pip 源、训练器目录、版本管理">
          <TrainerAdvanced hostId={hostId} versions={versions} busy={busy} onChanged={onChanged} />
        </Advanced>
      </Group>

      <DoctorDialog result={doctor} onClose={() => setDoctor(null)} />
    </Section>
  )
}
