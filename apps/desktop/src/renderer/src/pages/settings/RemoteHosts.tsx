import { Pencil, Plus, SquareTerminal, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { DownloadTask, EngineRemoteProgress, ManagedHost, RemoteEngineInfo } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { SshTerminalSheet } from '../Terminal'
import { Button, ConfirmDialog, Group, IconButton, ProgressBar, Row, Section, Spinner, StatusDot, useToast } from '../../components/ui'
import { hostSummary, remoteInstallOptions } from './devicesModel'
import { errorText } from './fields'
import { HostDialog } from './HostDialog'
import { emptyHostForm, hostFormFrom, hostPathsPatch, hostSavePayload, type HostForm } from './hostForm'

export function RemoteHosts(): React.JSX.Element {
  const toast = useToast()
  const [hosts, setHosts] = useState<ManagedHost[] | null>(null)
  const [engines, setEngines] = useState<Record<string, RemoteEngineInfo>>({})
  const [progress, setProgress] = useState<Record<string, EngineRemoteProgress>>({})
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [dialog, setDialog] = useState<HostForm | null>(null)
  const [removing, setRemoving] = useState<ManagedHost | null>(null)
  const [terminal, setTerminal] = useState<ManagedHost | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = (await call<ManagedHost[]>(Ipc.hostsList)).filter((host) => host.kind === 'ssh')
      setHosts(list)
      return list
    } catch (error) {
      toast.push(errorText(error), 'error')
      setHosts((current) => current ?? [])
      return []
    }
  }, [toast])

  const checkEngine = useCallback(async (hostId: string, refreshCuda = false) => {
    try {
      const info = await call<RemoteEngineInfo>(Ipc.engineRemoteStatus, { hostId, refreshCuda })
      setEngines((current) => ({ ...current, [hostId]: info }))
      return info
    } catch {
      return undefined
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(
    () =>
      onEvent(Events.hostsChanged, () => {
        void refresh()
      }),
    [refresh],
  )
  useEffect(
    () =>
      onEvent<EngineRemoteProgress>(Events.engineRemoteProgress, (next) => {
        setProgress((current) => ({ ...current, [next.hostId]: next }))
      }),
    [],
  )

  // Look up each reachable host's engine once the list is known.
  const reachable = useMemo(
    () =>
      (hosts ?? [])
        .filter((host) => host.status === 'ok')
        .map((host) => host.id)
        .join(','),
    [hosts],
  )
  useEffect(() => {
    for (const id of reachable.split(',').filter(Boolean)) void checkEngine(id)
  }, [reachable, checkEngine])

  function markBusy(hostId: string, label: string | null): void {
    setBusy((current) => {
      const next = { ...current }
      if (label) next[hostId] = label
      else delete next[hostId]
      return next
    })
  }

  async function test(host: ManagedHost, quiet = false): Promise<ManagedHost | null> {
    markBusy(host.id, '正在测试连接…')
    try {
      const next = await call<ManagedHost>(Ipc.hostsTest, { id: host.id })
      setHosts((current) => current?.map((item) => (item.id === next.id ? next : item)) ?? [next])
      if (next.status === 'ok') {
        if (!quiet) toast.push(`${next.name} 连接正常`, 'success')
        void checkEngine(next.id)
      } else {
        toast.push(`${next.name} 连接失败：${next.error ?? '请检查地址、用户名和登录方式'}`, 'error')
      }
      return next
    } catch (error) {
      toast.push(errorText(error), 'error')
      return null
    } finally {
      markBusy(host.id, null)
    }
  }

  async function save(form: HostForm): Promise<boolean> {
    try {
      const saved = await call<ManagedHost>(Ipc.hostsSave, hostSavePayload(form))
      await call(Ipc.hostsUpdatePaths, hostPathsPatch(saved.id, form))
      await refresh()
      void test(saved)
      return true
    } catch (error) {
      toast.push(`没有保存：${errorText(error)}`, 'error')
      return false
    }
  }

  async function remove(host: ManagedHost): Promise<void> {
    setRemoving(null)
    try {
      await call(Ipc.hostsRemove, { id: host.id })
      toast.push(`已移除 ${host.name}`, 'success')
      await refresh()
    } catch (error) {
      toast.push(errorText(error), 'error')
    }
  }

  /** Same as first run, on the remote host: connection, engine, then the recommended model. */
  async function prepare(host: ManagedHost): Promise<void> {
    const online = host.status === 'ok' ? host : await test(host, true)
    if (online?.status !== 'ok') return
    try {
      markBusy(host.id, '正在检查 CUDA…')
      let engine = await checkEngine(host.id, true)
      if (!engine?.available) {
        markBusy(host.id, '正在安装引擎…')
        const result = await call<{ version: string }>(Ipc.engineInstallRemote, { hostId: host.id, ...remoteInstallOptions() })
        toast.push(`${host.name} 已安装引擎 ${result.version}`, 'success')
        engine = await checkEngine(host.id)
      }
      markBusy(host.id, '正在准备模型…')
      const task = await call<DownloadTask>(Ipc.enginePrepareRemoteModel, { hostId: host.id })
      toast.push(`${host.name} 开始下载 ${task.label}，进度在「活动」里`, 'success')
    } catch (error) {
      toast.push(`${host.name}：${errorText(error)}`, 'error')
    } finally {
      markBusy(host.id, null)
    }
  }

  return (
    <Section
      title="远程主机"
      actions={
        <Button onClick={() => setDialog(emptyHostForm())}>
          <Plus className="size-4" />
          添加 SSH 主机
        </Button>
      }
    >
      <Group>
        {hosts === null ? <Row title="正在读取…" leading={<Spinner />} /> : null}
        {hosts?.length === 0 ? (
          <Row title="还没有远程主机" description="添加一台装有 NVIDIA 显卡的 Linux 电脑，就可以在创作时选择在它上面运行。" />
        ) : null}
        {hosts?.map((host) => {
          const engine = engines[host.id]
          const summary = hostSummary(host, engine)
          const working = busy[host.id]
          const install = progress[host.id]
          const installing = working === '正在安装引擎…' && install && install.phase !== 'done' && install.phase !== 'error'
          return (
            <div key={host.id} className="flex flex-col">
              <Row
                leading={<StatusDot status={summary.status} />}
                title={host.name}
                description={working ? (installing ? install.message : working) : `${summary.statusLabel} · ${summary.detail}`}
              >
                <Button onClick={() => void prepare(host)} disabled={Boolean(working)}>
                  {working ? <Spinner /> : null}
                  {engine?.available ? '准备模型' : '准备引擎和模型'}
                </Button>
                <Button tone="ghost" onClick={() => void test(host)} disabled={Boolean(working)}>
                  测试
                </Button>
                <IconButton label={`打开 ${host.name} 的终端`} onClick={() => setTerminal(host)}>
                  <SquareTerminal className="size-4" />
                </IconButton>
                <IconButton label={`编辑 ${host.name}`} onClick={() => setDialog(hostFormFrom(host))}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton label={`移除 ${host.name}`} onClick={() => setRemoving(host)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </Row>
              {installing && typeof install.percent === 'number' ? (
                <div className="px-3.5 pb-3 pl-10">
                  <ProgressBar value={install.percent} label={`${host.name} 引擎安装进度`} />
                </div>
              ) : null}
            </div>
          )
        })}
      </Group>

      <HostDialog open={dialog !== null} initial={dialog ?? emptyHostForm()} onClose={() => setDialog(null)} onSave={save} />
      <ConfirmDialog
        open={removing !== null}
        title={`移除 ${removing?.name ?? ''}？`}
        description="只会删除这里保存的连接信息。远程主机上的引擎、模型和训练结果都会保留；正在运行的任务不会被停止。"
        confirmLabel="移除"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void remove(removing)
        }}
      />
      <SshTerminalSheet
        open={terminal !== null}
        hostId={terminal?.id ?? null}
        hostName={terminal?.name ?? ''}
        onClose={() => setTerminal(null)}
      />
    </Section>
  )
}
