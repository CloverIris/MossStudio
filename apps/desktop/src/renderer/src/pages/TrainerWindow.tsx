import { AlertTriangle, CheckCircle2, FolderOpen, GraduationCap, Play, Server, Stethoscope, Terminal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { JobRecord, ManagedHost, TrainerVersion } from '@shared/types'
import { call } from '../lib/api'
import { openWindow } from '../lib/windows'
import { announceTrainingHost, getSelectedTrainingHost, TRAINING_HOST_EVENT } from '../lib/trainingHost'
import { useApp } from '../store'
import { Button, Card, EmptyState, Field, IconButton, Input, Modal, Pill, ProgressBar, Select, Spinner, Textarea, useToast } from '../components/ui'

const ALGOS = ['lora', 'locon', 'loha', 'lokr', 'dora', 'oft', 'boft', 'ia3', 'full']

export function TrainerWindow(): React.JSX.Element {
  const toast = useToast()
  const env = useApp((state) => state.env)
  const jobs = useApp((state) => state.jobs)
  const [versions, setVersions] = useState<TrainerVersion[]>([])
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [selectedHostId, setSelectedHostId] = useState(getSelectedTrainingHost)
  const [versionId, setVersionId] = useState('')
  const [weights, setWeights] = useState('')
  const [dataset, setDataset] = useState('')
  const [runName, setRunName] = useState('moss-lora')
  const [algo, setAlgo] = useState('lora')
  const [steps, setSteps] = useState('4000')
  const [lr, setLr] = useState('1e-4')
  const [dim, setDim] = useState('32')
  const [alpha, setAlpha] = useState('32')
  const [batch, setBatch] = useState('1')
  const [resolution, setResolution] = useState('1024')
  const [overrides, setOverrides] = useState('')
  const [doctor, setDoctor] = useState<{ ok: boolean; output: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState<string | null>(null)
  const [auxOpen, setAuxOpen] = useState<'export' | 'sample' | null>(null)

  useEffect(() => {
    void Promise.all([call<TrainerVersion[]>(Ipc.trainerAllVersions), call<ManagedHost[]>(Ipc.trainerHosts)])
      .then(([rows, hostList]) => {
        setVersions(rows)
        setHosts(hostList)
        const selected = getSelectedTrainingHost()
        setSelectedHostId(selected)
        setVersionId((current) => current || rows.find((item) => (item.hostId ?? 'local') === selected)?.id || rows[0]?.id || '')
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    const sync = (): void => setSelectedHostId(getSelectedTrainingHost())
    window.addEventListener(TRAINING_HOST_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(TRAINING_HOST_EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])

  const availableVersions = useMemo(() => versions.filter((item) => (item.hostId ?? 'local') === selectedHostId), [versions, selectedHostId])
  const version = availableVersions.find((item) => item.id === versionId) ?? availableVersions[0]
  const hasCuda = env?.gpu.kind === 'nvidia'
  const remote = selectedHostId !== 'local'
  const ready = version?.runtimeState === 'ready'
  const canStart = Boolean(version && ready && (remote || hasCuda))
  const trainingJob = jobs.find((job) => job.kind === 'training' && (job.hostId ?? 'local') === selectedHostId) ?? null

  useEffect(() => {
    if (availableVersions.length && !availableVersions.some((item) => item.id === versionId)) setVersionId(availableVersions[0]!.id)
  }, [availableVersions, versionId])

  const configPath = `configs/user/${runName || 'moss-lora'}.py`
  const overrideArgs = overrides
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => `--set ${line}`)
    .join(' ')

  const command = useMemo(
    () =>
      [
        `kohakumoss-config new train --weights ${weights || '<weights>'} --data ${dataset || '<dataset>'} --source kohya --algo ${algo} --name ${runName || 'moss-lora'} --steps ${steps || '4000'}`,
        `kogine run scripts/train/moss.py --config ${configPath} --set LR=${lr || '1e-4'} --set DIM=${dim || '32'} --set ALPHA=${alpha || '32'} --set MICROBATCHES=${batch || '1'} --set TARGET_AREA=${Number(resolution || '1024') ** 2}${overrideArgs ? ` ${overrideArgs}` : ''}`,
      ].join('\n'),
    [weights, dataset, algo, runName, steps, lr, dim, alpha, batch, resolution, configPath, overrideArgs],
  )

  async function pick(kind: 'weights' | 'dataset'): Promise<void> {
    const path = await call<string | null>(Ipc.pickDialog, { kind: 'folder', title: kind === 'weights' ? '选择 MOSS 权重目录' : '选择数据集目录' })
    if (!path) return
    if (kind === 'weights') setWeights(path)
    else setDataset(path)
  }

  async function check(): Promise<void> {
    if (!version) {
      toast.push('先创建一个训练版本', 'error')
      return
    }
    setBusy(true)
    try {
      const result = remote
        ? await call<{ ok: boolean; output: string }>(Ipc.trainerRemoteDoctor, { hostId: version.hostId, versionId: version.id })
        : await call<{ ok: boolean; output: string }>(Ipc.trainerDoctor, { id: version.id })
      setDoctor(result)
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  function buildExport(): string {
    const step = trainingJob?.metrics?.step ?? (Number(steps) || 1000)
    return `kogine run scripts/export/export.py --set WEIGHTS=${weights || '<weights>'} --set ADAPTER=runs/moss/${runName || 'moss-lora'}/checkpoints/step_${String(step).padStart(8, '0')}/trainable.safetensors --set OUT=${runName || 'moss-lora'}.safetensors`
  }

  function buildSample(): string {
    return `kohakumoss-config new sample --weights ${weights || '<weights>'} --adapter runs/moss/${runName || 'moss-lora'}/export/${runName || 'moss-lora'}-comfy.safetensors --name ${runName || 'moss-lora'}-sample\nkogine run scripts/sample/sample.py --config configs/user/${runName || 'moss-lora'}-sample.py --set PROMPT="a lighthouse on a rocky coast at sunset"`
  }

  async function runAction(action: 'train' | 'inspect_data' | 'cache_text' | 'cache_latents' | 'export' | 'sample'): Promise<void> {
    if (!version) {
      toast.push('先选择一个训练版本', 'error')
      return
    }
    if (!ready) {
      toast.push('先在训练页安装环境', 'error')
      return
    }
    if (!remote && !hasCuda) {
      toast.push('本机没有 CUDA；请切换到 SSH 训练版本，或在 NVIDIA 机器运行', 'info')
      return
    }
    if (!weights || (!dataset && (action === 'train' || action === 'inspect_data' || action === 'cache_text' || action === 'cache_latents'))) {
      toast.push(action === 'train' || action === 'inspect_data' || action === 'cache_text' || action === 'cache_latents'
        ? '先选择 MOSS 权重目录和数据集目录'
        : '先选择 MOSS 权重目录', 'error')
      return
    }
    setStarting(action)
    try {
      const job = await call<JobRecord>(Ipc.trainerRun, {
        versionId: version.id,
        action,
        runName: runName || 'moss-lora',
        weights,
        dataset,
        algo,
        steps: Number(steps) || 4000,
        lr,
        dim,
        alpha,
        batch,
        resolution: Number(resolution) || 1024,
        overrides,
      })
      toast.push(`${action === 'train' ? '训练' : action} 已启动`, 'success')
      void job
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setStarting(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] space-y-4 px-6 py-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-caption font-semibold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
            <GraduationCap className="size-4" />
            Kohaku Trainer · External
          </div>
          <h1 className="mt-1.5 text-[23px] font-semibold tracking-[-0.02em]">训练窗口</h1>
          <p className="mt-1 text-ui text-[var(--color-text-secondary)]">
            表单生成 trainer 配置；高级项直接透传 <code className="rounded bg-white/[0.05] px-1">--set KEY=VALUE</code>。
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button tone="ghost" onClick={() => openWindow('launcher', '/training')}>
            训练页
          </Button>
          <Button tone="secondary" onClick={() => void check()} disabled={busy || !ready}>
            {busy ? <Spinner className="size-4" /> : <Stethoscope className="size-4" />}
            环境体检
          </Button>
        </div>
      </header>

      {!hasCuda && !remote ? (
        <div className="flex items-start gap-2 rounded-[6px] border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
          <p className="text-caption leading-4 text-[var(--color-text-secondary)]">
            当前设备没有 CUDA，不能在本机启动训练。可以编辑配置、预览命令，或在训练页选择 SSH 训练版本。
          </p>
        </div>
      ) : remote ? (
        <div className="flex items-center gap-2 rounded-[6px] border border-accent-500/25 bg-accent-500/[0.06] px-3 py-2 text-caption text-[var(--color-text-secondary)]">
          <Server className="size-4 text-accent-300" />
          远端训练：{version?.hostName ?? version?.hostId} · 数据/权重使用远端路径
        </div>
      ) : null}

      {availableVersions.length === 0 ? (
        <EmptyState
          icon={<GraduationCap className="size-8" />}
          title="还没有训练版本"
          description={remote ? '这个 SSH host 还没有训练版本；先去训练页拉取远端仓库并安装环境。' : '先去训练页拉取 KohakuMossTrainer 并创建一个 commit 版本。'}
          action={
            <Button tone="primary" onClick={() => openWindow('launcher', '/training')}>
              去训练页
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-section font-medium">训练配置</h2>
              <Pill tone={ready ? 'accent' : 'amber'}>{ready ? '环境就绪' : '环境未就绪'}</Pill>
              {remote ? <Pill tone="neutral">{version?.hostName ?? 'SSH'}</Pill> : null}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <Field label="训练主机">
                <Select value={selectedHostId} onChange={(event) => { announceTrainingHost(event.target.value); setSelectedHostId(event.target.value) }}>
                  {(hosts.length ? hosts : [{ id: 'local', name: '本机', kind: 'local', status: 'ok' } as ManagedHost]).map((host) => <option key={host.id} value={host.id}>{host.name}{host.kind === 'local' ? ' · 本机' : ' · SSH'}</option>)}
                </Select>
              </Field>
              <Field label="训练版本">
                <Select value={versionId} onChange={(event) => setVersionId(event.target.value)}>
                  {availableVersions.map((item) => (
                    <option key={item.id} value={item.id}>{item.name} · {item.shortCommit}{item.hostId !== 'local' ? ' · SSH' : ''}</option>
                  ))}
                </Select>
              </Field>
              <Field label="算法">
                <Select value={algo} onChange={(event) => setAlgo(event.target.value)}>
                  {ALGOS.map((item) => <option key={item} value={item}>{item}</option>)}
                </Select>
              </Field>
              <div className="col-span-2 grid grid-cols-[1fr_auto] gap-1">
                <Field label="MOSS 权重目录">
                  <Input value={weights} onChange={(event) => setWeights(event.target.value)} placeholder="/path/to/MOSS-Image-Base" />
                </Field>
                <IconButton label="选择权重目录" onClick={() => void pick('weights')} className="mt-4">
                  <FolderOpen className="size-4" />
                </IconButton>
              </div>
              <div className="col-span-2 grid grid-cols-[1fr_auto] gap-1">
                <Field label="数据集目录">
                  <Input value={dataset} onChange={(event) => setDataset(event.target.value)} placeholder="/path/to/dataset（kohya 文件夹）" />
                </Field>
                <IconButton label="选择数据集目录" onClick={() => void pick('dataset')} className="mt-4">
                  <FolderOpen className="size-4" />
                </IconButton>
              </div>
              <Field label="Run 名称">
                <Input value={runName} onChange={(event) => setRunName(event.target.value.replace(/[^a-zA-Z0-9_-]/g, '-'))} />
              </Field>
              <Field label="目标边长">
                <Input value={resolution} onChange={(event) => setResolution(event.target.value.replace(/[^0-9]/g, ''))} />
              </Field>
              <Field label="Steps">
                <Input value={steps} onChange={(event) => setSteps(event.target.value.replace(/[^0-9]/g, ''))} />
              </Field>
              <Field label="LR">
                <Input value={lr} onChange={(event) => setLr(event.target.value)} />
              </Field>
              <Field label="Dim">
                <Input value={dim} onChange={(event) => setDim(event.target.value.replace(/[^0-9]/g, ''))} />
              </Field>
              <Field label="Alpha">
                <Input value={alpha} onChange={(event) => setAlpha(event.target.value)} />
              </Field>
              <Field label="Microbatch">
                <Input value={batch} onChange={(event) => setBatch(event.target.value.replace(/[^0-9]/g, ''))} />
              </Field>
            </div>

            <Field label="高级覆盖（每行 KEY=VALUE）">
              <Textarea
                value={overrides}
                onChange={(event) => setOverrides(event.target.value)}
                placeholder={'MEMORY_PROFILE=balanced\nSAVE_EVERY=250'}
                className="mt-0.5 h-16 w-full resize-none font-mono leading-4"
              />
            </Field>

            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button tone="primary" onClick={() => void runAction('train')} disabled={!canStart || starting !== null}>
                <span className="inline-flex items-center gap-1.5">
                  {starting === 'train' ? <Spinner className="size-4" /> : <Play className="size-4" />}
                  开始训练
                </span>
              </Button>
              <Button tone="secondary" onClick={() => void check()} disabled={!ready || busy}>
                环境体检
              </Button>
              <Button tone="ghost" onClick={() => void runAction('inspect_data')} disabled={!canStart || starting !== null}>
                检查数据
              </Button>
              <Button tone="ghost" onClick={() => void runAction('cache_text')} disabled={!canStart || starting !== null}>
                缓存文本
              </Button>
              <Button tone="ghost" onClick={() => void runAction('cache_latents')} disabled={!canStart || starting !== null}>
                缓存潜变量
              </Button>
              <Button tone="ghost" onClick={() => setAuxOpen('export')}>
                导出命令
              </Button>
              <Button tone="ghost" onClick={() => setAuxOpen('sample')}>
                采样命令
              </Button>
            </div>
          </Card>

          <div className="space-y-4">
            {trainingJob ? (
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-section font-medium">训练状态</h2>
                  <Pill tone={trainingJob.state === 'failed' ? 'red' : trainingJob.state === 'succeeded' ? 'accent' : 'amber'}>
                    {trainingJob.state}
                  </Pill>
                </div>
                <div className="mt-2 flex items-center justify-between text-caption text-[var(--color-text-secondary)]">
                  <span>step {trainingJob.metrics?.step ?? trainingJob.progress.current} / {trainingJob.progress.total || '—'}</span>
                  <span>loss {trainingJob.metrics?.loss !== undefined ? trainingJob.metrics.loss.toFixed(4) : '—'}</span>
                </div>
                <ProgressBar value={trainingJob.progress.percent} className="mt-1.5" />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-caption text-[var(--color-text-tertiary)]">
                    {trainingJob.error?.message ?? (trainingJob.state === 'running' ? '训练中，日志在共享终端' : '')}
                  </span>
                  <Button tone="ghost" onClick={() => openWindow('terminal')}>
                    <span className="inline-flex items-center gap-1"><Terminal className="size-4" /> 终端</span>
                  </Button>
                </div>
              </Card>
            ) : null}

            <Card className="p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-section font-medium">命令预览</h2>
                <Pill tone="neutral">copy-ready</Pill>
              </div>
              <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap rounded-[4px] bg-black/25 p-3 font-mono text-caption leading-5 text-[var(--color-text-secondary)]">
                {command}
              </pre>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-caption text-[var(--color-text-tertiary)]">
                  {ready ? '环境就绪；执行入口在下一阶段接入' : '先在训练页安装环境'}
                </span>
                <Button
                  tone="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(command)
                    toast.push('命令已复制', 'success')
                  }}
                >
                  复制
                </Button>
              </div>
            </Card>

            <Card className="p-4">
              <div className="flex items-center gap-2 text-ui font-medium">
                <Terminal className="size-4" /> 环境体检
              </div>
              {doctor ? (
                <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-[4px] bg-black/25 p-2.5 font-mono text-caption leading-4 text-[var(--color-text-secondary)]">
                  {doctor.output || '没有输出'}
                </pre>
              ) : (
                <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">
                  训练页安装环境后，可以在这里运行 <code className="rounded bg-white/[0.05] px-1">kohakumoss-doctor</code>。
                </p>
              )}
            </Card>
          </div>
        </div>
      )}

      <Modal
        open={Boolean(auxOpen)}
        onClose={() => setAuxOpen(null)}
        title={auxOpen === 'export' ? '导出适配器命令' : '采样命令'}
        description="命令入口；真实执行在 CUDA 主机/远端阶段接入。"
        width="max-w-3xl"
        footer={
          <div className="flex gap-1.5">
            <Button tone="ghost" onClick={() => setAuxOpen(null)}>关闭</Button>
            <Button
              tone="primary"
              onClick={() => {
                const action = auxOpen
                if (!action) return
                setAuxOpen(null)
                void runAction(action)
              }}
              disabled={starting !== null || !version || !ready}
            >
              {starting === auxOpen ? <Spinner className="size-4" /> : null}
              执行
            </Button>
            <Button
              tone="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(auxOpen === 'export' ? buildExport() : buildSample())
                toast.push('命令已复制', 'success')
              }}
            >
              复制命令
            </Button>
          </div>
        }
      >
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-[4px] bg-black/25 p-3 font-mono text-caption leading-5 text-[var(--color-text-secondary)]">
          {auxOpen === 'export' ? buildExport() : buildSample()}
        </pre>
      </Modal>
    </div>
  )
}
