import { FileUp, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { AdapterEntry, Catalog, DownloadTask } from '@shared/types'
import { useApp } from '../../store'
import { Notice } from '../../components/common/Notice'
import { Button, ConfirmDialog, EmptyState, Group, LoadingRow, Pill, Row, Section, Spinner, useToast } from '../../components/ui'
import { DownloadProgress } from './DownloadProgress'
import { itemProgress, itemState, sizeText, taskFor } from './logic'
import { DownloadActionIcon, RemoveButton, SizeText } from './ModelEntries'
import type { ModelLocation } from './useModelLocation'

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** Where a LoRA comes from; its size is a column of its own. */
function adapterOrigin(adapter: AdapterEntry): string | undefined {
  return adapter.provider === 'local' ? (adapter.tags.includes('trained') ? '自己训练的' : '从电脑导入') : adapter.notes
}

const adapterBytes = (adapter: AdapterEntry): number =>
  adapter.installed ? adapter.installedBytes || adapter.sizeBytes : adapter.sizeBytes

/** LoRA: installed ones (import local files, delete) and ones available to download. */
export function LoraTab({ catalog, location }: { catalog: Catalog; location: ModelLocation }): React.JSX.Element {
  const toast = useToast()
  const importAdapters = useApp((state) => state.importAdapters)
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<AdapterEntry | null>(null)
  if (!location.ready) {
    const hostName = location.host?.name ?? '远程主机'
    return location.scanning ? (
      <LoadingRow label={`正在查看 ${hostName} 上的 LoRA…`} />
    ) : (
      <Notice
        tone="danger"
        action={
          <Button size="xs" onClick={location.rescan}>
            重试
          </Button>
        }
      >
        读不到 {hostName} 上的 LoRA{location.scanError ? `：${location.scanError}` : ''}。检查这台主机是否在线，然后重试。
      </Notice>
    )
  }
  const adapters = catalog.adapters.filter((adapter) => location.kind === 'local' || adapter.provider !== 'local')
  const installed = adapters.filter((adapter) => location.isAdapterInstalled(adapter))
  const available = adapters.filter((adapter) => !location.isAdapterInstalled(adapter) && adapter.provider !== 'local')

  async function runImport(): Promise<void> {
    setBusy('import')
    try {
      const added = await importAdapters()
      if (added.length) toast.push(`已导入 ${added.length} 个 LoRA`, 'success')
    } catch (cause) {
      toast.push(`没能导入：${errorText(cause)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  async function act(adapter: AdapterEntry, action: 'download' | 'resume' | 'pause', task: DownloadTask | undefined): Promise<void> {
    setBusy(adapter.id)
    try {
      if (action === 'pause' && task) await location.pause(task)
      else if (action === 'resume' && task) await location.resume(task)
      else await location.download('adapter', adapter.id)
    } catch (cause) {
      toast.push(errorText(cause), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function remove(adapter: AdapterEntry): Promise<void> {
    setRemoving(null)
    try {
      await location.remove('adapter', adapter.id)
      toast.push(`已删除 ${adapter.name}`, 'success')
    } catch (cause) {
      toast.push(`没能删除：${errorText(cause)}`, 'error')
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="已安装"
        description="在创作里可以给画面叠加这些 LoRA。"
        actions={
          location.kind === 'local' ? (
            <Button tone="secondary" disabled={busy !== null} onClick={() => void runImport()}>
              {busy === 'import' ? <Spinner /> : <FileUp className="size-4" strokeWidth={1.6} />}导入 LoRA 文件
            </Button>
          ) : null
        }
      >
        {installed.length ? (
          <Group>
            {installed.map((adapter) => (
              <Row key={adapter.id} title={adapter.name} description={adapterOrigin(adapter)}>
                <SizeText bytes={adapterBytes(adapter)} />
                <RemoveButton name={adapter.name} onClick={() => setRemoving(adapter)} />
              </Row>
            ))}
          </Group>
        ) : (
          <Group>
            <EmptyState
              size="section"
              icon={<Sparkles className="size-6" strokeWidth={1.6} />}
              title="还没有 LoRA"
              description={location.kind === 'local' ? '导入电脑上的 .safetensors 文件，或从下面下载。' : '从下面下载到这台主机。'}
            />
          </Group>
        )}
      </Section>

      {available.length ? (
        <Section title="可以下载">
          <Group>
            {available.map((adapter) => {
              const task = taskFor(location.tasks, 'adapter', adapter.id)
              const state = itemState(adapter, false, task)
              const progress = itemProgress(false, task)
              return (
                <Row
                  key={adapter.id}
                  title={adapter.name}
                  description={
                    <span className="flex flex-col gap-1.5">
                      <span>{adapterOrigin(adapter)}</span>
                      {progress ? <DownloadProgress info={progress} label={`${adapter.name} 下载进度`} className="max-w-md pt-1" /> : null}
                    </span>
                  }
                >
                  <SizeText bytes={adapterBytes(adapter)} />
                  {state.text && !progress ? (
                    <Pill tone={state.tone} className="tabular">
                      {state.text}
                    </Pill>
                  ) : null}
                  {state.action && state.action !== 'delete' ? (
                    <Button
                      tone="secondary"
                      disabled={busy !== null}
                      onClick={() => void act(adapter, state.action as 'download' | 'resume' | 'pause', task)}
                    >
                      {busy === adapter.id ? <Spinner /> : <DownloadActionIcon action={state.action} label={state.actionLabel} />}
                      {state.actionLabel}
                    </Button>
                  ) : null}
                </Row>
              )
            })}
          </Group>
        </Section>
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        title={removing ? `删除「${removing.name}」？` : ''}
        description={
          removing?.provider === 'local' && removing.tags.includes('local-import')
            ? '会删除模型库里的这份副本，你最初导入的原文件不受影响。'
            : `会删除这个 LoRA 的文件，释放约 ${sizeText(removing?.installedBytes || removing?.sizeBytes)}。用到它的画面会不再叠加它。`
        }
        confirmLabel="删除"
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </div>
  )
}
