import { Copy, FolderOpen, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { JobRecord } from '@shared/types'
import { call } from '../lib/api'
import { useApp } from '../store'
import {
  Advanced,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Pill,
  ProgressBar,
  Section,
  Select,
  Spinner,
  Textarea,
  useCopyText,
  useToast,
} from '../components/ui'
import { RUNTIME_LABEL, currentVersion, versionsAt } from './training/trainerSetup'
import {
  ALGOS,
  buildTrainingCommand,
  digitsOnly,
  firstTrainingFormError,
  loadTrainingForm,
  sanitizeRunName,
  saveTrainingForm,
  toTrainerRunInput,
  trainingFormErrors,
  type TrainerAction,
  type TrainingForm,
} from './training/trainingForm'
import { trainingRuns } from './training/trainingRuns'
import { useTrainerData } from './training/useTrainerData'

const ACTION_LABEL: Record<TrainerAction, string> = {
  train: '训练',
  inspect_data: '检查数据',
  cache_text: '缓存文本',
  cache_latents: '缓存潜变量',
  export: '导出',
  sample: '采样',
}

/** A field hint that turns into the field's problem once the user tried to start. */
function hint(error: string | undefined, normal?: string): React.ReactNode {
  return error ? <span className="text-danger">{error}</span> : normal
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The separate trainer window: one form, remembered between sessions. */
export function TrainerWindow(): React.JSX.Element {
  const toast = useToast()
  const copyText = useCopyText()
  const env = useApp((state) => state.env)
  const jobs = useApp((state) => state.jobs)
  const remoteHostsEnabled = useApp((state) => state.settings?.remoteHostsEnabled ?? false)
  const { sshHosts, versions, loading, hostId, setHostId } = useTrainerData()
  const [form, setForm] = useState<TrainingForm>(loadTrainingForm)
  const [showErrors, setShowErrors] = useState(false)
  const [starting, setStarting] = useState<TrainerAction | null>(null)
  const [checking, setChecking] = useState(false)
  const [doctor, setDoctor] = useState<{ ok: boolean; output: string } | null>(null)

  const available = useMemo(() => versionsAt(versions, hostId), [versions, hostId])
  const version = available.find((item) => item.id === form.versionId) ?? currentVersion(versions, hostId)
  const ready = version?.runtimeState === 'ready'
  const remote = hostId !== 'local'
  const hasGpu = remote || env?.gpu.kind === 'nvidia'
  const latestRun = trainingRuns(jobs, hostId)[0]
  const effective: TrainingForm = { ...form, hostId, versionId: version?.id ?? '' }
  const errors = showErrors ? trainingFormErrors(effective) : {}
  const command = buildTrainingCommand(effective)

  const snapshot = JSON.stringify(effective)
  useEffect(() => { saveTrainingForm(JSON.parse(snapshot) as TrainingForm) }, [snapshot])

  function update(patch: Partial<TrainingForm>): void {
    setForm((current) => ({ ...current, ...patch }))
  }

  async function pick(field: 'weights' | 'dataset'): Promise<void> {
    if (remote) return
    const path = await call<string | null>(Ipc.pickDialog, {
      kind: 'folder',
      title: field === 'weights' ? '选择底模权重所在的文件夹' : '选择训练图片所在的文件夹',
    }).catch(() => null)
    if (path) update({ [field]: path })
  }

  async function run(action: TrainerAction): Promise<void> {
    setShowErrors(true)
    const problem = !version ? '先在训练页准备训练器' : !ready ? '训练环境还没装好，先在训练页安装环境' : !hasGpu ? '这台电脑没有 NVIDIA 显卡，不能在本机训练' : firstTrainingFormError(effective, action)
    if (problem) {
      toast.push(problem, 'error')
      return
    }
    setStarting(action)
    try {
      await call<JobRecord>(Ipc.trainerRun, toTrainerRunInput(effective, action))
      toast.push(`${ACTION_LABEL[action]}已开始，进度在主窗口的「训练」里`, 'success')
    } catch (error) {
      toast.push(`${ACTION_LABEL[action]}没有开始：${errorText(error)}`, 'error')
    } finally {
      setStarting(null)
    }
  }

  async function check(): Promise<void> {
    if (!version) return
    setChecking(true)
    try {
      setDoctor(remote
        ? await call<{ ok: boolean; output: string }>(Ipc.trainerRemoteDoctor, { hostId, versionId: version.id })
        : await call<{ ok: boolean; output: string }>(Ipc.trainerDoctor, { id: version.id }))
    } catch (error) {
      toast.push(`体检没有完成：${errorText(error)}`, 'error')
    } finally {
      setChecking(false)
    }
  }

  function openMainWindow(): void {
    void call(Ipc.windowOpen, { kind: 'studio', route: '/training' }).catch(() => undefined)
  }

  const pathHint = remote ? '填写远程主机上的路径' : undefined

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8 px-10 pb-16 pt-8">
      <PageHeader
        title="新建训练"
        description="选好训练图片和底模，其余参数已经有合适的默认值。"
        actions={<Button tone="ghost" onClick={openMainWindow}>在主窗口查看进度</Button>}
      />

      {!loading && !version ? (
        <Card>
          <EmptyState
            title={remote ? '这台主机还没有训练器' : '训练器还没准备好'}
            description="在主窗口的「训练」页点「准备训练器」，准备好后回到这里。"
            action={<Button onClick={openMainWindow}>打开训练页</Button>}
          />
        </Card>
      ) : (
        <>
          {!hasGpu ? (
            <p role="status" className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-ui text-warn">
              这台电脑没有检测到 NVIDIA 显卡，不能在本机训练。{remoteHostsEnabled && sshHosts.length ? '可以把训练位置换成一台远程主机。' : ''}
            </p>
          ) : version && !ready ? (
            <p role="status" className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-ui text-warn">
              {RUNTIME_LABEL[version.runtimeState]}。在主窗口的「训练」页安装环境后才能开始。
            </p>
          ) : null}

          <Card className="flex flex-col gap-4 p-5">
            <div className="grid grid-cols-2 gap-4">
              {remoteHostsEnabled && sshHosts.length ? (
                <Field label="训练位置">
                  <Select
                    value={hostId}
                    onValueChange={(id) => { setHostId(id); update({ versionId: '' }) }}
                    options={[{ value: 'local', label: '本机' }, ...sshHosts.map((host) => ({ value: host.id, label: host.name }))]}
                  />
                </Field>
              ) : null}
              <Field label="名称" hint={hint(errors.runName, '训练出的 LoRA 用这个名字保存')}>
                <Input
                  value={form.runName}
                  aria-invalid={errors.runName ? true : undefined}
                  onChange={(event) => update({ runName: sanitizeRunName(event.target.value) })}
                />
              </Field>
              <Field label="训练图片" hint={hint(errors.dataset, pathHint ?? '一个放着图片和同名 .txt 描述的文件夹')} className="col-span-2">
                <div className="flex gap-1.5">
                  <Input
                    value={form.dataset}
                    aria-invalid={errors.dataset ? true : undefined}
                    placeholder="/path/to/dataset"
                    onChange={(event) => update({ dataset: event.target.value })}
                    className="min-w-0 flex-1"
                  />
                  {!remote ? (
                    <IconButton label="选择训练图片文件夹" onClick={() => void pick('dataset')}><FolderOpen className="size-4" /></IconButton>
                  ) : null}
                </div>
              </Field>
              <Field label="底模权重" hint={hint(errors.weights, pathHint ?? 'MOSS-Image 底模所在的文件夹')} className="col-span-2">
                <div className="flex gap-1.5">
                  <Input
                    value={form.weights}
                    aria-invalid={errors.weights ? true : undefined}
                    placeholder="/path/to/MOSS-Image-Base"
                    onChange={(event) => update({ weights: event.target.value })}
                    className="min-w-0 flex-1"
                  />
                  {!remote ? (
                    <IconButton label="选择底模权重文件夹" onClick={() => void pick('weights')}><FolderOpen className="size-4" /></IconButton>
                  ) : null}
                </div>
              </Field>
              <Field label="步数" hint={hint(errors.steps)}>
                <Input inputMode="numeric" value={form.steps} onChange={(event) => update({ steps: digitsOnly(event.target.value) })} className="tabular" />
              </Field>
              <Field label="算法">
                <Select value={form.algo} onValueChange={(algo) => update({ algo })} options={ALGOS.map((algo) => ({ value: algo, label: algo.toUpperCase() }))} />
              </Field>
            </div>

            <Advanced summary="版本、学习率、维度、批大小、分辨率、额外参数、数据预处理">
              <div className="flex flex-col gap-4 px-3.5 pb-2 pt-2">
                <div className="grid grid-cols-3 gap-4">
                  <Field label="训练器版本" className="col-span-3">
                    <Select
                      value={version?.id ?? ''}
                      onValueChange={(versionId) => update({ versionId })}
                      options={available.length
                        ? available.map((item) => ({ value: item.id, label: `${item.shortCommit} · ${item.subject.slice(0, 48)} · ${RUNTIME_LABEL[item.runtimeState]}` }))
                        : [{ value: '', label: '没有可用的版本' }]}
                    />
                  </Field>
                  <Field label="学习率" hint={hint(errors.lr)}>
                    <Input value={form.lr} onChange={(event) => update({ lr: event.target.value.trim() })} className="font-mono" />
                  </Field>
                  <Field label="维度" hint={hint(errors.dim)}>
                    <Input inputMode="numeric" value={form.dim} onChange={(event) => update({ dim: digitsOnly(event.target.value) })} />
                  </Field>
                  <Field label="Alpha" hint={hint(errors.alpha)}>
                    <Input value={form.alpha} onChange={(event) => update({ alpha: event.target.value.trim() })} />
                  </Field>
                  <Field label="批大小" hint={hint(errors.batch)}>
                    <Input inputMode="numeric" value={form.batch} onChange={(event) => update({ batch: digitsOnly(event.target.value) })} />
                  </Field>
                  <Field label="目标边长" hint={hint(errors.resolution)}>
                    <Input inputMode="numeric" value={form.resolution} onChange={(event) => update({ resolution: digitsOnly(event.target.value) })} />
                  </Field>
                </div>
                <Field label="额外参数（每行一个 KEY=VALUE）">
                  <Textarea
                    value={form.overrides}
                    onChange={(event) => update({ overrides: event.target.value })}
                    placeholder={'MEMORY_PROFILE=balanced\nSAVE_EVERY=250'}
                    className="h-20 resize-none font-mono"
                  />
                </Field>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-caption font-medium text-ink-2">将要运行的命令</span>
                    <Button tone="ghost" onClick={() => void copyText(command, '命令已复制')}><Copy className="size-4" aria-hidden="true" />复制</Button>
                  </div>
                  <pre className="selectable max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-well p-3 font-mono text-caption text-ink-2">{command}</pre>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-caption text-ink-2">数据预处理：</span>
                  {(['inspect_data', 'cache_text', 'cache_latents'] as const).map((action) => (
                    <Button key={action} onClick={() => void run(action)} disabled={starting !== null}>
                      {starting === action ? <Spinner /> : null}
                      {ACTION_LABEL[action]}
                    </Button>
                  ))}
                  <Button tone="ghost" onClick={() => void check()} disabled={!ready || checking}>
                    {checking ? <Spinner /> : null}
                    环境体检
                  </Button>
                </div>
              </div>
            </Advanced>

            <div className="flex items-center justify-end gap-2">
              <Button tone="primary" size="md" onClick={() => void run('train')} disabled={starting !== null || !version}>
                {starting === 'train' ? <Spinner /> : <Play className="size-4" aria-hidden="true" />}
                开始训练
              </Button>
            </div>
          </Card>

          {latestRun ? (
            <Section title="最近一次训练">
              <Card className="flex flex-col gap-2 p-5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-control text-ink">{latestRun.name}</span>
                  <Pill tone={latestRun.tone} className="tabular">{latestRun.stateLabel}</Pill>
                </div>
                <ProgressBar value={latestRun.percent} label="训练进度" />
                <span className="tabular text-caption text-ink-2">{latestRun.algo} · {latestRun.progressLabel} 步</span>
              </Card>
            </Section>
          ) : null}
        </>
      )}

      <Modal
        open={Boolean(doctor)}
        onClose={() => setDoctor(null)}
        title="环境体检"
        description={doctor?.ok ? '没有发现问题。' : '发现了问题，详情见下方输出。'}
        width="max-w-3xl"
        footer={<Button tone="secondary" size="md" onClick={() => setDoctor(null)}>关闭</Button>}
      >
        <pre className="selectable max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg bg-well p-3 font-mono text-caption text-ink-2">
          {doctor?.output || '没有输出'}
        </pre>
      </Modal>
    </div>
  )
}
