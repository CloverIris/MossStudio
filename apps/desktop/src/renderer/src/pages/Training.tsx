import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  GitBranch,
  GraduationCap,
  Loader2,
  Play,
  RefreshCw,
  Server,
  Stethoscope,
  Trash2,
  Wand2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { BranchInfo, CommitInfo, TrainerRuntimeInfo, TrainerVersion, TrainingHost } from '@shared/types'
import { call } from '../lib/api'
import { dateTime } from '../lib/format'
import { openWindow } from '../lib/windows'
import { announceTrainingHost, getSelectedTrainingHost, TRAINING_HOST_EVENT } from '../lib/trainingHost'
import { useApp } from '../store'
import { Button, Card, EmptyState, IconButton, Modal, Pill, Select, Spinner, cn, useToast } from '../components/ui'

const runtimeLabel: Record<TrainerVersion['runtimeState'], string> = {
  missing: '未装环境',
  created: '环境已建',
  installing: '安装中',
  ready: '环境就绪',
  error: '环境失败',
}

export function TrainingPage(): React.JSX.Element {
  const toast = useToast()
  const settings = useApp((state) => state.settings)
  const env = useApp((state) => state.env)
  const [mirror, setMirror] = useState<{ ready: boolean; path: string } | null>(null)
  const [versions, setVersions] = useState<TrainerVersion[]>([])
  const [hosts, setHosts] = useState<TrainingHost[]>([])
  const sshHosts = hosts.filter((host) => host.kind === 'ssh')
  const [selectedHostId, setSelectedHostId] = useState(getSelectedTrainingHost)
  const [remoteHostId, setRemoteHostId] = useState('')
  const [remoteVersions, setRemoteVersions] = useState<TrainerVersion[]>([])
  const [remoteBranches, setRemoteBranches] = useState<BranchInfo[]>([])
  const [remoteCommits, setRemoteCommits] = useState<CommitInfo[]>([])
  const [remoteBranch, setRemoteBranch] = useState('main')
  const [remoteCommit, setRemoteCommit] = useState('')
  const [remoteBusy, setRemoteBusy] = useState<string | null>(null)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [branch, setBranch] = useState('main')
  const [commit, setCommit] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [doctor, setDoctor] = useState<{ id: string; ok: boolean; output: string } | null>(null)
  const [remoteInstallTarget, setRemoteInstallTarget] = useState<TrainerVersion | null>(null)

  const refresh = useCallback(async () => {
    const [mirrorInfo, list, hostList] = await Promise.all([
      call<{ ready: boolean; path: string }>(Ipc.trainerMirror),
      call<TrainerVersion[]>(Ipc.trainerVersions),
      call<TrainingHost[]>(Ipc.trainerHosts),
    ])
    setMirror(mirrorInfo)
    setVersions(list)
    setHosts(hostList)
    return mirrorInfo
  }, [])

  const loadCommits = useCallback(async (name: string) => {
    const rows = await call<CommitInfo[]>(Ipc.trainerCommits, { branch: name, limit: 80 })
    setCommits(rows)
    setCommit((current) => current || rows[0]?.sha || '')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (selectedHostId !== 'local' && sshHosts.some((host) => host.id === selectedHostId)) setRemoteHostId(selectedHostId)
    if (!remoteHostId && sshHosts[0]) setRemoteHostId(sshHosts[0].id)
  }, [remoteHostId, sshHosts, selectedHostId])
  useEffect(() => {
    const sync = (): void => setSelectedHostId(getSelectedTrainingHost())
    window.addEventListener(TRAINING_HOST_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(TRAINING_HOST_EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])

  useEffect(() => {
    if (!remoteHostId) {
      setRemoteVersions([])
      return
    }
    void call<TrainerVersion[]>(Ipc.trainerRemoteVersions, { hostId: remoteHostId })
      .then(setRemoteVersions)
      .catch(() => setRemoteVersions([]))
  }, [remoteHostId])

  useEffect(() => {
    if (!mirror?.ready || branches.length > 0) return
    void (async () => {
      try {
        const next = await call<BranchInfo[]>(Ipc.trainerBranches)
        setBranches(next)
        const defaultBranch = next.find((item) => item.isDefault)?.name ?? next[0]?.name ?? 'main'
        setBranch(defaultBranch)
        await loadCommits(defaultBranch)
      } catch (error) {
        toast.push(error instanceof Error ? error.message : String(error), 'error')
      }
    })()
  }, [mirror?.ready, branches.length, loadCommits])

  async function deployOrUpdate(): Promise<void> {
    setBusy('mirror')
    try {
      const next = await call<BranchInfo[]>(Ipc.trainerBranches)
      setBranches(next)
      const defaultBranch = next.find((item) => item.isDefault)?.name ?? next[0]?.name ?? 'main'
      setBranch(defaultBranch)
      await loadCommits(defaultBranch)
      await refresh()
      toast.push('训练器仓库已更新', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function createVersion(): Promise<void> {
    if (!commit) return
    setBusy('create')
    try {
      const version = await call<TrainerVersion>(Ipc.trainerCreate, { branch, commit })
      await refresh()
      toast.push(`已创建 ${version.name}`, 'success')
      setCommit('')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function install(version: TrainerVersion): Promise<void> {
    if (selectedHostId !== 'local') {
      toast.push('当前训练目标是远端 host；请在上方远端版本安装环境，避免写成本机依赖', 'error')
      return
    }
    setBusy(version.id)
    try {
      await call<TrainerRuntimeInfo>(Ipc.trainerInstall, { id: version.id })
      await refresh()
      toast.push('训练环境已就绪', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function runDoctor(version: TrainerVersion): Promise<void> {
    setBusy(version.id)
    try {
      const result = await call<{ ok: boolean; output: string }>(Ipc.trainerDoctor, { id: version.id })
      setDoctor({ id: version.id, ...result })
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function remoteDeploy(): Promise<void> {
    if (!remoteHostId) return
    setRemoteBusy('deploy')
    try {
      const list = await call<BranchInfo[]>(Ipc.trainerRemoteBranches, { hostId: remoteHostId })
      setRemoteBranches(list)
      const name = list.find((item) => item.isDefault)?.name ?? list[0]?.name ?? 'main'
      setRemoteBranch(name)
      const commits = await call<CommitInfo[]>(Ipc.trainerRemoteCommits, { hostId: remoteHostId, branch: name, limit: 80 })
      setRemoteCommits(commits)
      setRemoteCommit(commits[0]?.sha ?? '')
      await refresh()
      toast.push('远端训练器仓库已更新', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setRemoteBusy(null)
    }
  }

  async function remoteCreate(): Promise<void> {
    if (!remoteHostId || !remoteCommit) return
    setRemoteBusy('create')
    try {
      await call(Ipc.trainerRemoteCreate, { hostId: remoteHostId, branch: remoteBranch, commit: remoteCommit })
      setRemoteVersions(await call<TrainerVersion[]>(Ipc.trainerRemoteVersions, { hostId: remoteHostId }))
      await refresh()
      toast.push('远端训练版本已创建', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setRemoteBusy(null)
    }
  }

  async function remoteInstall(version: TrainerVersion): Promise<void> {
    setRemoteBusy(version.id)
    try {
      await call(Ipc.trainerRemoteInstall, { hostId: version.hostId, versionId: version.id })
      setRemoteVersions(await call<TrainerVersion[]>(Ipc.trainerRemoteVersions, { hostId: remoteHostId }))
      await refresh()
      toast.push(`远端训练环境已就绪：${sshHosts.find((host) => host.id === version.hostId)?.name ?? version.hostId}`, 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
      setRemoteVersions(await call<TrainerVersion[]>(Ipc.trainerRemoteVersions, { hostId: remoteHostId }).catch(() => remoteVersions))
    } finally {
      setRemoteBusy(null)
    }
  }

  async function remoteCheck(version: TrainerVersion): Promise<void> {
    setRemoteBusy(version.id)
    try {
      const result = await call<{ ok: boolean; output: string }>(Ipc.trainerRemoteDoctor, { hostId: version.hostId, versionId: version.id })
      setDoctor({ id: version.id, ...result })
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setRemoteBusy(null)
    }
  }

  async function remoteRemove(version: TrainerVersion): Promise<void> {
    setRemoteBusy(version.id)
    try {
      await call(Ipc.trainerRemoteRemove, { hostId: version.hostId, versionId: version.id })
      setRemoteVersions(await call<TrainerVersion[]>(Ipc.trainerRemoteVersions, { hostId: remoteHostId }))
      await refresh()
      toast.push('远端训练版本已删除', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setRemoteBusy(null)
    }
  }

  async function remove(version: TrainerVersion): Promise<void> {
    setBusy(version.id)
    try {
      await call(Ipc.trainerRemove, { id: version.id })
      await refresh()
      toast.push('已删除训练版本', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const localCuda = env?.gpu.kind === 'nvidia'
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? null
  const selectedIsSsh = Boolean(selectedHost && selectedHost.kind === 'ssh')
  const selectedVersion = versions[0]

  return (
    <div className="space-y-4 pb-8">
      <header>
        <div className="flex items-center gap-2 text-caption font-semibold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
          <GraduationCap className="size-4" />
          Kohaku Trainer · External
        </div>
        <h1 className="mt-1.5 text-[25px] font-semibold tracking-[-0.02em]">训练</h1>
        <p className="mt-1 max-w-[700px] text-ui leading-5 text-[var(--color-text-secondary)]">
          把 KohakuMossTrainer 部署到你的目录，按 commit 管理版本和 Python 环境；训练窗口负责配置、数据缓存和运行。
          启动器不打包上游代码。
        </p>
        <button
          type="button"
          onClick={() => void call(Ipc.openExternal, { url: 'https://github.com/KohakuBlueleaf/KohakuMossTrainer' })}
          className="mt-1 inline-flex items-center gap-1 text-caption text-accent-300 hover:underline"
        >
          KohakuMossTrainer · KohakuMoss License 1.0 <ExternalLink className="size-2.5" />
        </button>
      </header>

      {selectedHostId === 'local' && !localCuda ? (
        <div className="flex items-start gap-2.5 rounded-[6px] border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
          <p className="text-ui leading-5 text-[var(--color-text-secondary)]">
            当前选中的是本机，但本机没有 CUDA（macOS/MPS 不受 KohakuMossTrainer 支持）。
            选择上方 SSH 训练目标主机，或改用 Linux/Windows + NVIDIA 本机；远端训练仍需先创建并安装 trainer 版本。
          </p>
        </div>
      ) : null}

      <Card className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-ui font-medium"><Server className="size-4" />训练目标主机</div>
          <Select value={selectedHostId} onChange={(event) => { announceTrainingHost(event.target.value); setSelectedHostId(event.target.value) }} className="min-w-[220px]">
            {(hosts.length ? hosts : [{ id: 'local', name: '本机', kind: 'local', status: 'ok' } as TrainingHost]).map((host) => <option key={host.id} value={host.id}>{host.name}{host.kind === 'local' ? ' · 本机' : ` · ${host.user}@${host.host}`}</option>)}
          </Select>
        </div>
        <p className="mt-1.5 text-caption leading-4 text-[var(--color-text-tertiary)]">
          {selectedIsSsh ? `远端训练：${selectedHost?.name} · ${selectedHost?.trainerRoot}。训练窗口会只显示该 host 的版本。` : localCuda ? '本机 CUDA 可用于训练。' : '本机没有 CUDA；选择 SSH 训练主机，或在 NVIDIA 机器运行。'}
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-section font-medium">
              <GitBranch className="size-4" />
              训练器仓库
            </div>
            <Pill tone={mirror?.ready ? 'accent' : 'neutral'}>{mirror?.ready ? '已拉取' : '未部署'}</Pill>
          </div>
          <p className="mt-1 break-all font-mono text-caption text-[var(--color-text-tertiary)]">
            {mirror?.path ?? '尚未拉取'}
          </p>
          <p className="mt-0.5 break-all text-caption text-[var(--color-text-tertiary)]">
            根目录：{settings?.trainerRoot ?? '默认 .dev-data/trainer'}
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex min-w-[110px] flex-col gap-1">
              <span className="text-micro uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">分支</span>
              <Select
                value={branch}
                onChange={(event) => {
                  setBranch(event.target.value)
                  void loadCommits(event.target.value)
                }}
              >
                {(branches.length ? branches : [{ name: 'main', sha: '', isDefault: true, isStable: false }]).map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}{item.isStable ? ' · stable' : ''}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex min-w-[220px] flex-1 flex-col gap-1">
              <span className="text-micro uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">提交</span>
              <Select
                value={commit}
                onChange={(event) => setCommit(event.target.value)}
                disabled={commits.length === 0}
              >
                {commits.length === 0 ? <option value="">{mirror?.ready ? '正在读取提交…' : '先拉取仓库'}</option> : null}
                {commits.map((item) => (
                  <option key={item.sha} value={item.sha}>
                    {item.short} · {item.subject.slice(0, 48)}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button tone="secondary" onClick={() => void deployOrUpdate()} disabled={busy === 'mirror'}>
              <span className="inline-flex items-center gap-1.5">
                {busy === 'mirror' ? <Spinner className="size-4" /> : <Download className="size-4" />}
                {mirror?.ready ? '拉取更新' : '拉取训练器'}
              </span>
            </Button>
            <Button tone="primary" onClick={() => void createVersion()} disabled={!commit || busy === 'create'}>
              <span className="inline-flex items-center gap-1.5">
                {busy === 'create' ? <Spinner className="size-4" /> : <Wand2 className="size-4" />}
                创建版本
              </span>
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-section font-medium">
              <Server className="size-4" />
              训练主机
            </div>
            <div className="flex items-center gap-1">
              <Pill tone="neutral">{hosts.length} host</Pill>
              <Button tone="ghost" onClick={() => openWindow('devices')}>管理设备</Button>
            </div>
          </div>
          <div className="mt-3 space-y-1.5">
            {hosts.map((host) => {
              const local = host.kind === 'local'
              return (
                <div key={host.id} className="flex items-center gap-2 rounded-[5px] border border-[var(--color-border-subtle)] px-2.5 py-2">
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      host.status === 'ok' ? 'bg-accent-400' : host.status === 'error' ? 'bg-red-400' : local && localCuda ? 'bg-amber-400' : 'bg-neutral-500',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-ui">{host.name}</span>
                      {local ? <Pill tone="neutral">Local</Pill> : <Pill tone="neutral">SSH</Pill>}
                      {host.status === 'ok' ? <Pill tone="accent">正常</Pill> : host.status === 'error' ? <Pill tone="red">失败</Pill> : null}
                    </div>
                    <div className="truncate text-caption text-[var(--color-text-tertiary)]">
                      {local
                        ? `${env?.gpu.name ?? '正在检测'} · ${localCuda ? 'CUDA 可用于训练' : '不支持 MPS 训练'}`
                        : `${host.user}@${host.host}:${host.port ?? 22} · ${host.trainerRoot}`}
                    </div>
                    {host.error ? (
                      <div className="mt-0.5 line-clamp-2 text-micro leading-3.5 text-red-300/80">{host.error}</div>
                    ) : host.remote?.gpu ? (
                      <div className="mt-0.5 truncate text-micro text-[var(--color-text-tertiary)]">{host.remote.os} · {host.remote.gpu.split('\n')[0]}</div>
                    ) : null}
                  </div>
                  <Button tone={selectedHostId === host.id ? 'primary' : 'ghost'} onClick={() => { announceTrainingHost(host.id); setSelectedHostId(host.id) }}>{selectedHostId === host.id ? '当前训练' : '用于训练'}</Button>
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-caption leading-4 text-[var(--color-text-tertiary)]">
            SSH 登录方式沿用设备管理器的设置；先“测试连接”并确认首次连接的主机密钥指纹。
          </p>
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-section font-medium">
            <Server className="size-4" />
            SSH 远端训练器
          </div>
          <div className="flex items-center gap-1">
            <Pill tone={sshHosts.length ? 'accent' : 'neutral'}>{sshHosts.length} SSH host</Pill>
            <Button tone="ghost" onClick={() => openWindow('devices')}>管理设备</Button>
          </div>
        </div>
        {sshHosts.length === 0 ? (
          <p className="mt-2 text-caption leading-4 text-[var(--color-text-tertiary)]">
            还没有 SSH 主机。先在设备管理器里添加并测试连接，再部署远端 trainer。
          </p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="flex min-w-[180px] flex-col gap-1">
                <span className="text-micro uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">主机</span>
                <Select value={remoteHostId} onChange={(event) => setRemoteHostId(event.target.value)}>
                  {sshHosts.map((host) => <option key={host.id} value={host.id}>{host.name} · {host.user}@{host.host}</option>)}
                </Select>
              </label>
              <label className="flex min-w-[100px] flex-col gap-1">
                <span className="text-micro uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">分支</span>
                <Select value={remoteBranch} onChange={(event) => { setRemoteBranch(event.target.value); void call<CommitInfo[]>(Ipc.trainerRemoteCommits, { hostId: remoteHostId, branch: event.target.value, limit: 80 }).then((rows) => { setRemoteCommits(rows); setRemoteCommit(rows[0]?.sha ?? '') }).catch(() => undefined) }}>
                  {(remoteBranches.length ? remoteBranches : [{ name: 'main', sha: '', isDefault: true, isStable: false }]).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </Select>
              </label>
              <label className="flex min-w-[220px] flex-1 flex-col gap-1">
                <span className="text-micro uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">提交</span>
                <Select value={remoteCommit} onChange={(event) => setRemoteCommit(event.target.value)}>
                  {remoteCommits.length === 0 ? <option value="">先拉取远端仓库</option> : null}
                  {remoteCommits.map((item) => <option key={item.sha} value={item.sha}>{item.short} · {item.subject.slice(0, 44)}</option>)}
                </Select>
              </label>
              <Button tone="secondary" onClick={() => void remoteDeploy()} disabled={!remoteHostId || remoteBusy !== null}>
                {remoteBusy === 'deploy' ? <Spinner className="size-4" /> : <Download className="size-4" />}
                拉取/更新
              </Button>
              <Button tone="primary" onClick={() => void remoteCreate()} disabled={!remoteCommit || remoteBusy !== null}>
                {remoteBusy === 'create' ? <Spinner className="size-4" /> : <Wand2 className="size-4" />}
                创建远端版本
              </Button>
            </div>
            <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">
              远端路径：{sshHosts.find((host) => host.id === remoteHostId)?.trainerRoot ?? '—'} · 使用系统 ssh，不自动上传数据/权重。
            </p>
            {remoteVersions.length > 0 ? (
              <div className="mt-2 space-y-1">
                {remoteVersions.map((version) => (
                  <div key={version.id} className="flex flex-wrap items-center gap-2 rounded-[5px] border border-[var(--color-border-subtle)] px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-caption">{version.name}</span>
                    <Pill tone={version.runtimeState === 'ready' ? 'accent' : 'amber'}>{runtimeLabel[version.runtimeState]}</Pill>
                    <Button tone="secondary" onClick={() => setRemoteInstallTarget(version)} disabled={remoteBusy !== null}>
                      {remoteBusy === version.id ? <Spinner className="size-4" /> : null}
                      安装远端环境
                    </Button>
                    <Button tone="ghost" onClick={() => void remoteCheck(version)} disabled={version.runtimeState !== 'ready' || remoteBusy !== null}>体检</Button>
                    <button type="button" onClick={() => void remoteRemove(version)} className="text-[var(--color-text-tertiary)] hover:text-red-300"><Trash2 className="size-4" /></button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-caption text-[var(--color-text-tertiary)]">还没有远端版本；先拉取仓库并创建版本。</p>
            )}
          </>
        )}
      </Card>

      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-[14px] font-semibold">本机训练版本</h2>
          <p className="mt-0.5 text-caption text-[var(--color-text-tertiary)]">
            仅本机版本；远端 SSH 版本请在上方「SSH 远端训练器」安装。每个版本固定 commit + 独立 worktree。
          </p>
        </div>
        <IconButton label="刷新" onClick={() => void refresh()}>
          <RefreshCw className="size-4" />
        </IconButton>
      </div>

      {versions.length === 0 ? (
        <EmptyState
          icon={<GraduationCap className="size-8" />}
          title="还没有训练版本"
          description="先拉取 trainer 仓库，选择一个 commit 创建版本；然后在训练窗口里配置数据集和权重。"
          action={
            <Button tone="secondary" onClick={() => void deployOrUpdate()}>
              拉取训练器
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {versions.map((version) => (
            <Card key={version.id} className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ui font-medium">{version.name}</span>
                    <Pill tone={version.channel === 'stable' ? 'accent' : 'neutral'}>{version.channel}</Pill>
                    <Pill tone={version.runtimeState === 'ready' ? 'accent' : version.runtimeState === 'error' ? 'red' : 'amber'}>
                      {runtimeLabel[version.runtimeState]}
                    </Pill>
                    {version.dirty ? <Pill tone="amber">有本地修改</Pill> : null}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-caption text-[var(--color-text-tertiary)]">
                    <span>{version.shortCommit}</span>
                    <span>{dateTime(version.commitDate)}</span>
                    <span className="truncate">{version.subject}</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    tone="secondary"
                    onClick={() => void install(version)}
                    disabled={busy === version.id || selectedHostId !== 'local'}
                  >
                    {busy === version.id ? <Spinner className="size-4" /> : <Download className="size-4" />}
                    {version.runtimeState === 'ready' ? '重装本机环境' : '安装本机环境'}
                  </Button>
                  <IconButton label="环境体检" onClick={() => void runDoctor(version)} disabled={version.runtimeState !== 'ready'}>
                    <Stethoscope className="size-4" />
                  </IconButton>
                  <Button tone="primary" onClick={() => openWindow('trainer')}>
                    <span className="inline-flex items-center gap-1.5">
                      <Play className="size-4" /> 训练窗口
                    </span>
                  </Button>
                  <IconButton label="删除" onClick={() => void remove(version)} disabled={busy === version.id}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {selectedVersion ? (
        <p className="text-caption text-[var(--color-text-tertiary)]">
          训练窗口默认使用最新版本；环境体检会运行 <code className="rounded bg-white/[0.05] px-1">kohakumoss-doctor</code>。
        </p>
      ) : null}

      <Modal
        open={Boolean(remoteInstallTarget)}
        onClose={() => setRemoteInstallTarget(null)}
        title="在远端安装训练环境"
        description="依赖安装会通过 SSH 在目标主机执行，不会写入本机 Python 环境。"
        width="max-w-lg"
        footer={
          <>
            <Button tone="ghost" onClick={() => setRemoteInstallTarget(null)}>取消</Button>
            <Button tone="primary" disabled={remoteBusy !== null} onClick={() => { const target = remoteInstallTarget; setRemoteInstallTarget(null); if (target) void remoteInstall(target) }}>在远端安装</Button>
          </>
        }
      >
        <div className="space-y-2 p-4 text-ui leading-5 text-[var(--color-text-secondary)]">
          <div className="rounded border border-[var(--color-border-subtle)] bg-white/[0.025] p-2.5">
            <div>主机：<span className="font-medium text-[var(--color-text)]">{sshHosts.find((host) => host.id === remoteInstallTarget?.hostId)?.name ?? remoteInstallTarget?.hostId ?? '—'}</span></div>
            <div className="font-mono text-caption text-[var(--color-text-tertiary)]">{(() => { const host = sshHosts.find((item) => item.id === remoteInstallTarget?.hostId); return host ? `${host.user}@${host.host}:${host.port ?? 22}` : '—' })()}</div>
            <div className="mt-1 break-all font-mono text-caption text-[var(--color-text-tertiary)]">训练器根目录：{sshHosts.find((host) => host.id === remoteInstallTarget?.hostId)?.trainerRoot ?? '—'}</div>
          </div>
          <p>将创建/复用该 host 的 venv，并在远端执行 <code className="rounded bg-black/25 px-1">pip install -e "$VERSIONS/…"</code>。</p>
        </div>
      </Modal>

      <Modal
        open={Boolean(doctor)}
        onClose={() => setDoctor(null)}
        title="KohakuMoss Doctor"
        description="环境体检输出"
        width="max-w-3xl"
        footer={<Button tone="secondary" onClick={() => setDoctor(null)}>关闭</Button>}
      >
        <pre className="max-h-[50vh] overflow-auto rounded-[4px] bg-black/30 p-3 font-mono text-caption leading-5 text-[var(--color-text-secondary)]">
          {doctor?.output || '没有输出'}
        </pre>
      </Modal>
    </div>
  )
}
