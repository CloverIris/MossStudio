import {
  AlertTriangle,
  Boxes,
  Cpu,
  GraduationCap,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  SquareTerminal,
  Trash2,
  Wifi,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { ComputeDevice, ManagedHost, SshAuthMethod } from '@shared/types'
import { call } from '../lib/api'
import { dateTime } from '../lib/format'
import { openWindow } from '../lib/windows'
import { announceTrainingHost } from '../lib/trainingHost'
import { useApp } from '../store'
import { Button, Card, Input, Modal, Pill, Spinner, cn, useToast } from '../components/ui'

interface HostForm {
  id?: string
  name: string
  host: string
  user: string
  port: string
  authMethod: SshAuthMethod
  identityFile: string
  password: string
  hasPassword: boolean
  trainerRoot: string
  engineRoot: string
  outputRoot: string
  modelsRoot: string
}

const EMPTY_FORM: HostForm = {
  name: '',
  host: '',
  user: '',
  port: '22',
  authMethod: 'identityFile',
  identityFile: '',
  password: '',
  hasPassword: false,
  trainerRoot: '~/.mossstudio/trainer',
  engineRoot: '~/.mossstudio/engine',
  outputRoot: '~/.mossstudio/outputs',
  modelsRoot: '~/.mossstudio/models',
}

const AUTH_METHODS: Array<{ value: SshAuthMethod; label: string }> = [
  { value: 'identityFile', label: 'Identity file' },
  { value: 'password', label: '密码' },
  { value: 'none', label: '无验证' },
]

function statusTone(host: ManagedHost): 'accent' | 'red' | 'amber' | 'neutral' {
  if (host.status === 'ok') return 'accent'
  if (host.status === 'error') return 'red'
  if (host.kind === 'ssh') return 'amber'
  return 'neutral'
}

function statusLabel(host: ManagedHost): string {
  if (host.status === 'ok') return '在线'
  if (host.status === 'error') return '连接失败'
  return '未探测'
}

function activeJobsFor(
  hostId: string,
  jobs: ReturnType<typeof useApp.getState>['jobs'],
): number {
  return jobs.filter((job) => {
    if (job.state !== 'running' && job.state !== 'starting' && job.state !== 'queued') return false
    if (hostId === 'local') return !job.hostId || job.hostId === 'local'
    return job.hostId === hostId
  }).length
}

function DeviceCard({ device }: { device: ComputeDevice }): React.JSX.Element {
  return (
    <div className="rounded-[5px] border border-[var(--color-border-subtle)] bg-white/[0.025] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Cpu className="size-4 shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="truncate text-ui font-medium">{device.name}</span>
        </div>
        <span
          className={cn(
            'mt-1 size-1.5 shrink-0 rounded-full',
            device.available ? 'bg-accent-400' : 'bg-neutral-500',
          )}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-caption text-[var(--color-text-tertiary)]">
        <span className="truncate">{device.detail}</span>
        <span className="shrink-0">{device.source === 'remote' ? '远端' : '本机'}</span>
      </div>
    </div>
  )
}

export function DevicesPage(): React.JSX.Element {
  const toast = useToast()
  const jobs = useApp((state) => state.jobs)
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [selectedId, setSelectedId] = useState('local')
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState<string | null>(null)
  const [hostOpen, setHostOpen] = useState(false)
  const [form, setForm] = useState<HostForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<ManagedHost | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await call<ManagedHost[]>(Ipc.hostsList)
      setHosts(next)
      setSelectedId((current) => (next.some((host) => host.id === current) ? current : next[0]?.id ?? 'local'))
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selected = hosts.find((host) => host.id === selectedId) ?? hosts[0] ?? null
  const deviceCount = useMemo(() => hosts.reduce((total, host) => total + host.devices.length, 0), [hosts])
  const activeJobs = useMemo(
    () => jobs.filter((job) => job.state === 'running' || job.state === 'starting' || job.state === 'queued').length,
    [jobs],
  )
  const remoteHosts = hosts.filter((host) => host.kind === 'ssh')

  function openAdd(): void {
    setForm(EMPTY_FORM)
    setHostOpen(true)
  }

  function openEdit(host: ManagedHost): void {
    setForm({
      id: host.id,
      name: host.name,
      host: host.host ?? '',
      user: host.user ?? '',
      port: String(host.port ?? 22),
      authMethod: host.authMethod ?? 'identityFile',
      identityFile: host.identityFile ?? '',
      password: '',
      hasPassword: host.hasPassword ?? false,
      trainerRoot: host.trainerRoot,
      engineRoot: host.engineRoot ?? '~/.mossstudio/engine',
      outputRoot: host.outputRoot ?? '~/.mossstudio/outputs',
      modelsRoot: host.modelsRoot ?? '~/.mossstudio/models',
    })
    setHostOpen(true)
  }

  async function saveHost(): Promise<void> {
    if (!form.host.trim() || !form.user.trim() || !form.trainerRoot.trim()) {
      toast.push('host、user 和训练器根目录不能为空', 'error')
      return
    }
    if (form.authMethod === 'password' && !form.password && !form.hasPassword) {
      toast.push('请输入 SSH 密码', 'error')
      return
    }
    setSaving(true)
    try {
      const saved = await call<ManagedHost>(Ipc.hostsSave, {
        id: form.id,
        name: form.name,
        host: form.host.trim(),
        user: form.user.trim(),
        port: Number(form.port) || 22,
        authMethod: form.authMethod,
        identityFile: form.authMethod === 'identityFile' ? form.identityFile.trim() || undefined : undefined,
        password: form.authMethod === 'password' ? form.password || undefined : undefined,
        trainerRoot: form.trainerRoot.trim(),
        engineRoot: form.engineRoot.trim() || undefined,
        outputRoot: form.outputRoot.trim() || undefined,
        modelsRoot: form.modelsRoot.trim() || undefined,
      })
      setHosts((current) => {
        const existing = current.some((host) => host.id === saved.id)
        return existing ? current.map((host) => (host.id === saved.id ? saved : host)) : [...current, saved]
      })
      setSelectedId(saved.id)
      setHostOpen(false)
      setForm(EMPTY_FORM)
      toast.push('设备连接已保存，先测试连接', 'success')
      void testHost(saved)
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function pickIdentityFile(): Promise<void> {
    try {
      const path = await call<string | null>(Ipc.pickDialog, { kind: 'file', title: '选择 SSH Identity file' })
      if (path) setForm((current) => ({ ...current, identityFile: path }))
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  function closeHostForm(): void {
    setHostOpen(false)
    setForm(EMPTY_FORM)
  }

  async function testHost(host: ManagedHost): Promise<void> {
    setTesting(host.id)
    try {
      const next = await call<ManagedHost>(Ipc.hostsTest, { id: host.id })
      setHosts((current) => current.map((item) => (item.id === next.id ? next : item)))
      setSelectedId(next.id)
      if (next.status === 'ok') {
        toast.push(`${next.name} 连接正常 · ${next.devices.length} 个设备`, 'success')
      } else {
        toast.push(next.error ?? `${next.name} 连接失败`, 'error')
      }
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setTesting(null)
    }
  }

  async function removeHost(): Promise<void> {
    if (!removeTarget || removeTarget.kind === 'local') return
    try {
      await call(Ipc.hostsRemove, { id: removeTarget.id })
      setHosts((current) => current.filter((host) => host.id !== removeTarget.id))
      setSelectedId('local')
      setRemoveTarget(null)
      toast.push('设备连接已移除', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  return (
    <div className="space-y-4 pb-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">设备管理器</h1>
          <p className="mt-1 max-w-[620px] text-ui leading-5 text-[var(--color-text-secondary)]">
            推理、训练和终端共用同一份算力库存。这里只管理连接与设备；实例仍由启动器管理。
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Pill tone="neutral">{hosts.length} host</Pill>
          <Pill tone="neutral">{deviceCount} 设备</Pill>
          <Pill tone={activeJobs ? 'accent' : 'neutral'}>{activeJobs} 进行中</Pill>
          <Button tone="ghost" onClick={() => void refresh()} disabled={loading}>
            <span className="inline-flex items-center gap-1.5">
              {loading ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
              刷新
            </span>
          </Button>
          <Button data-oobe="device" data-oobe-hint="添加一台 Linux NVIDIA SSH 主机，保存后测试连接；再在准备清单中切换到这台主机。" tone="primary" onClick={openAdd}>
            <span className="inline-flex items-center gap-1.5">
              <Plus className="size-4" /> 添加 SSH 设备
            </span>
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="h-fit overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-ui font-medium">
              <Server className="size-4 text-[var(--color-text-tertiary)]" />
              连接与设备
            </div>
            <span className="text-caption text-[var(--color-text-tertiary)]">{remoteHosts.length} SSH</span>
          </div>
          <div className="p-1.5">
            {hosts.map((host) => {
              const active = activeJobsFor(host.id, jobs)
              return (
                <button
                  data-oobe="device" data-oobe-host={host.id}
                  key={host.id}
                  type="button"
                  onClick={() => setSelectedId(host.id)}
                  className={cn(
                    'mb-1 flex w-full items-start gap-2 rounded-[5px] px-2.5 py-2 text-left transition',
                    host.id === selected?.id ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]',
                  )}
                >
                  <span
                    className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      host.status === 'ok'
                        ? 'bg-accent-400'
                        : host.status === 'error'
                          ? 'bg-red-400'
                          : 'bg-neutral-500',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-ui font-medium">{host.name}</span>
                      {host.kind === 'local' ? <Pill tone="neutral">本机</Pill> : null}
                    </span>
                    <span className="mt-0.5 block truncate text-caption text-[var(--color-text-tertiary)]">
                      {host.kind === 'local'
                        ? `${host.devices.length} 个设备`
                        : `${host.user}@${host.host}:${host.port ?? 22}`}
                    </span>
                    <span className="mt-0.5 block text-micro text-[var(--color-text-tertiary)]">
                      {host.status === 'ok' ? `${host.devices.length} 设备` : statusLabel(host)}
                      {active ? ` · ${active} 进行中` : ''}
                    </span>
                  </span>
                </button>
              )
            })}
            {loading && hosts.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-3 py-8 text-ui text-[var(--color-text-tertiary)]">
                <Spinner className="size-4" /> 读取设备库存…
              </div>
            ) : null}
          </div>
        </Card>

        {selected ? (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[16px] font-semibold">{selected.name}</h2>
                    <Pill tone={statusTone(selected)}>{statusLabel(selected)}</Pill>
                    <Pill tone="neutral">{selected.kind === 'local' ? '本机' : 'SSH'}</Pill>
                    {selected.kind === 'local' ? <Pill tone="neutral">固定</Pill> : null}
                  </div>
                  <p className="mt-1 truncate text-ui text-[var(--color-text-tertiary)]">
                    {selected.kind === 'local'
                      ? 'Apple MPS / CUDA / CPU（按本机实际枚举）'
                      : `${selected.user}@${selected.host}:${selected.port ?? 22}`}
                    {selected.lastCheckedAt ? ` · ${dateTime(selected.lastCheckedAt)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    data-oobe="device" data-oobe-host={selected.id}
                    tone="secondary"
                    onClick={() => void testHost(selected)}
                    disabled={testing === selected.id}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {testing === selected.id ? <Spinner className="size-4" /> : <Wifi className="size-4" />}
                      测试连接
                    </span>
                  </Button>
                  {selected.kind === 'ssh' ? (
                    <>
                      <Button tone="ghost" onClick={() => openEdit(selected)}>
                        <span className="inline-flex items-center gap-1.5">
                          <Pencil className="size-4" /> 编辑
                        </span>
                      </Button>
                      <Button tone="ghost" onClick={() => setRemoveTarget(selected)}>
                        <span className="inline-flex items-center gap-1.5 text-red-300">
                          <Trash2 className="size-4" /> 移除
                        </span>
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-[5px] border border-[var(--color-border-subtle)] bg-white/[0.025] px-3 py-2">
                  <div className="text-caption uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">设备</div>
                  <div className="mt-1 text-[15px] font-semibold tabular-nums">{selected.devices.length}</div>
                </div>
                <div className="rounded-[5px] border border-[var(--color-border-subtle)] bg-white/[0.025] px-3 py-2">
                  <div className="text-caption uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">进行中</div>
                  <div className="mt-1 text-[15px] font-semibold tabular-nums">{activeJobsFor(selected.id, jobs)}</div>
                </div>
                <div className="rounded-[5px] border border-[var(--color-border-subtle)] bg-white/[0.025] px-3 py-2">
                  <div className="text-caption uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">根目录</div>
                  <div className="mt-1 truncate text-ui text-[var(--color-text-secondary)]" title={selected.trainerRoot}>
                    {selected.trainerRoot}
                  </div>
                </div>
              </div>

              {selected.error ? (
                <div className="mt-3 flex items-start gap-2 rounded-[5px] border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-caption leading-4 text-red-200">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span className="break-words">{selected.error}</span>
                </div>
              ) : null}

              {selected.kind === 'ssh' ? (
                <div className="mt-3 grid grid-cols-1 gap-2 text-caption text-[var(--color-text-tertiary)] sm:grid-cols-2">
                  <div className="rounded-[5px] border border-[var(--color-border-subtle)] px-2.5 py-2">
                    <div className="text-micro uppercase tracking-[0.1em]">远端路径</div>
                    <div className="mt-1 truncate" title={selected.instanceRoot}>
                      实例：{selected.instanceRoot ?? '未配置'}
                    </div>
                    <div className="truncate" title={selected.modelsRoot}>
                      模型：{selected.modelsRoot ?? '未配置'}
                    </div>
                  </div>
                  <div className="rounded-[5px] border border-[var(--color-border-subtle)] px-2.5 py-2">
                    <div className="text-micro uppercase tracking-[0.1em]">远端环境</div>
                    <div className="mt-1 truncate">OS：{selected.remote?.os ?? '未探测'}</div>
                    <div className="truncate">Python：{selected.remote?.python ?? '未探测'} · UV：{selected.remote?.uv ?? '无'}</div>
                  </div>
                </div>
              ) : null}
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[13px] font-semibold">设备库存</h3>
                  <p className="mt-0.5 text-caption text-[var(--color-text-tertiary)]">
                    {selected.kind === 'local'
                      ? '本机由启动器自动枚举；禁用/重命名在设置里。'
                      : '远端设备来自最近一次 SSH 探测；未测试时为空。'}
                  </p>
                </div>
                <Pill tone="neutral">{selected.devices.length}</Pill>
              </div>
              {selected.devices.length > 0 ? (
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {selected.devices.map((device) => (
                    <DeviceCard key={device.id} device={device} />
                  ))}
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 rounded-[5px] border border-dashed border-[var(--color-border)] px-3 py-5 text-ui text-[var(--color-text-tertiary)]">
                  {selected.kind === 'ssh' && selected.status === 'ok' ? (
                    <>
                      <AlertTriangle className="size-4 text-amber-300" />
                      连接正常，但 nvidia-smi 没有返回 NVIDIA GPU；该 host 目前不能用于训练。
                    </>
                  ) : (
                    <>
                      <Boxes className="size-4" />
                      还没有设备。先点「测试连接」拉取远端 GPU。
                    </>
                  )}
                </div>
              )}
            </Card>

            <Card className="p-4">
              <h3 className="text-[13px] font-semibold">使用入口</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button tone="secondary" onClick={() => { announceTrainingHost(selected.id); openWindow('launcher', '/training') }}>
                  <span className="inline-flex items-center gap-1.5">
                    <GraduationCap className="size-4" /> 在训练中使用
                  </span>
                </Button>
                <Button tone="ghost" onClick={() => openWindow('launcher', '/instances')}>
                  <span className="inline-flex items-center gap-1.5">
                    <Boxes className="size-4" /> 部署实例
                  </span>
                </Button>
              </div>
              <p className="mt-2 text-caption leading-4 text-[var(--color-text-tertiary)]">
                选择后训练页会使用该 host；远端训练需要先部署对应的 SSH trainer 版本。
              </p>
            </Card>
          </div>
        ) : null}
      </div>

      <Modal
        open={hostOpen}
        onClose={closeHostForm}
        title={form.id ? '编辑 SSH 设备' : '添加 SSH 设备'}
        description="支持 Identity file、密码或无验证登录，按设备记住选择。首次连接会提示确认并保存主机密钥指纹。"
        width="max-w-2xl"
        footer={
          <>
            <Button tone="secondary" onClick={closeHostForm}>
              取消
            </Button>
            <Button tone="primary" onClick={() => void saveHost()} disabled={saving}>
              <span className="inline-flex items-center gap-1.5">
                {saving ? <Spinner className="size-4" /> : null}
                保存并测试
              </span>
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">显示名称</span>
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="例如：4090 工作站"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">Host</span>
              <Input
                value={form.host}
                onChange={(event) => setForm({ ...form, host: event.target.value })}
                placeholder="192.168.1.20 或 gpu.example.com"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">User</span>
              <Input
                value={form.user}
                onChange={(event) => setForm({ ...form, user: event.target.value })}
                placeholder="ubuntu"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">Port</span>
              <Input
                inputMode="numeric"
                value={form.port}
                onChange={(event) => setForm({ ...form, port: event.target.value.replace(/[^0-9]/g, '') })}
                placeholder="22"
              />
            </label>
            <div className="sm:col-span-2">
              <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">登录方式</span>
              <div role="tablist" aria-label="SSH 登录方式" className="relative flex rounded-[5px] border border-[var(--color-border-subtle)] bg-white/[0.035] p-0.5">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-[3px] bg-white/[0.09] shadow-sm transition-transform duration-200"
                  style={{ width: 'calc((100% - 4px) / 3)', transform: `translateX(${AUTH_METHODS.findIndex((method) => method.value === form.authMethod) * 100}%)` }}
                />
                {AUTH_METHODS.map((method, index) => (
                  <button
                    key={method.value}
                    id={`ssh-auth-tab-${method.value}`}
                    type="button"
                    role="tab"
                    aria-selected={form.authMethod === method.value}
                    aria-controls={`ssh-auth-panel-${method.value}`}
                    tabIndex={form.authMethod === method.value ? 0 : -1}
                    onClick={() => setForm((current) => ({ ...current, authMethod: method.value }))}
                    onKeyDown={(event) => {
                      const next = event.key === 'ArrowRight' ? (index + 1) % 3
                        : event.key === 'ArrowLeft' ? (index + 2) % 3
                          : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null
                      if (next === null) return
                      event.preventDefault()
                      setForm((current) => ({ ...current, authMethod: AUTH_METHODS[next].value }))
                      document.getElementById(`ssh-auth-tab-${AUTH_METHODS[next].value}`)?.focus()
                    }}
                    className={cn('relative flex-1 rounded-[3px] px-2.5 py-1.5 text-ui font-medium transition-colors', form.authMethod === method.value ? 'text-[var(--color-text)]' : 'text-[var(--color-text-secondary)]')}
                  >
                    {method.label}
                  </button>
                ))}
              </div>
              <div className="-mx-1 mt-1 overflow-hidden">
                <div className="flex transition-transform duration-200" style={{ transform: `translateX(-${AUTH_METHODS.findIndex((method) => method.value === form.authMethod) * 100}%)` }}>
                  {AUTH_METHODS.map((method) => (
                    <div
                      key={method.value}
                      id={`ssh-auth-panel-${method.value}`}
                      role="tabpanel"
                      aria-labelledby={`ssh-auth-tab-${method.value}`}
                      aria-hidden={form.authMethod !== method.value}
                      inert={form.authMethod !== method.value}
                      className="min-w-0 flex-[0_0_100%] space-y-1.5 p-1"
                    >
                      {method.value === 'identityFile' ? (
                        <>
                          <label className="block">
                            <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">Identity file（可选）</span>
                            <div className="flex gap-1.5">
                              <Input value={form.identityFile} onChange={(event) => setForm({ ...form, identityFile: event.target.value })} placeholder="~/.ssh/id_ed25519" className="min-w-0 flex-1" />
                              <Button tone="secondary" style={{ height: 30 }} onClick={() => void pickIdentityFile()}>
                                <span className="inline-flex items-center gap-1.5"><FolderOpen className="size-4" />选择文件</span>
                              </Button>
                            </div>
                          </label>
                          <p className="text-caption text-[var(--color-text-tertiary)]">留空使用系统默认密钥或 SSH agent；加密私钥请先加入 agent。</p>
                        </>
                      ) : method.value === 'password' ? (
                        <>
                          <label className="block">
                            <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">SSH 密码</span>
                            <Input type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={form.hasPassword ? '留空保留已保存的密码' : '输入 SSH 登录密码'} />
                          </label>
                          <p className="text-caption text-[var(--color-text-tertiary)]">密码通过本机系统安全存储加密保存。</p>
                        </>
                      ) : (
                        <p className="py-3 text-ui leading-5 text-[var(--color-text-secondary)]">仅适用于服务端允许无认证的账户，不会尝试密钥或密码。</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">训练器根目录</span>
              <Input
                value={form.trainerRoot}
                onChange={(event) => setForm({ ...form, trainerRoot: event.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">推理引擎目录</span>
              <Input
                value={form.engineRoot}
                onChange={(event) => setForm({ ...form, engineRoot: event.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">远端输出目录</span>
              <Input
                value={form.outputRoot}
                onChange={(event) => setForm({ ...form, outputRoot: event.target.value })}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-caption text-[var(--color-text-secondary)]">模型 / 缓存根目录（远端）</span>
              <Input
                value={form.modelsRoot}
                onChange={(event) => setForm({ ...form, modelsRoot: event.target.value })}
              />
            </label>
          </div>
          <p className="text-caption leading-4 text-[var(--color-text-tertiary)]">
            远端模型由远端自行下载/缓存，不会自动上传本机的 27 GB 权重。路径不做自动创建，
            测试连接只读取能力与根目录状态。
          </p>
        </div>
      </Modal>

      <Modal
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        title="移除设备连接"
        description={removeTarget ? `将移除 ${removeTarget.name} 的连接配置。不会删除远端仓库、模型或已有任务。` : undefined}
        width="max-w-md"
        footer={
          <>
            <Button tone="secondary" onClick={() => setRemoveTarget(null)}>
              取消
            </Button>
            <Button tone="danger" onClick={() => void removeHost()}>
              移除
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-2 rounded-[5px] border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-ui leading-5 text-red-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          正在使用该 host 的训练 Job 不会被取消；如果它还在运行，请先在终端停止。
        </div>
      </Modal>
    </div>
  )
}
