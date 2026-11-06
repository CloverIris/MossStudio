import { ArrowDownToLine, FileUp, Pause, Play, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { AdapterEntry, Catalog, DownloadTask } from '@shared/types'
import { useApp } from '../../store'
import { Button, ConfirmDialog, EmptyState, Group, IconButton, ProgressBar, Row, Section, Spinner, cn, useToast } from '../../components/ui'
import { itemState, sizeText, taskFor } from './logic'
import type { ModelLocation } from './useModelLocation'

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

function adapterDescription(adapter: AdapterEntry): string {
  const origin = adapter.provider === 'local' ? (adapter.tags.includes('trained') ? '自己训练的' : '从电脑导入') : adapter.notes
  return [origin, sizeText(adapter.installed ? adapter.installedBytes || adapter.sizeBytes : adapter.sizeBytes)].filter(Boolean).join(' · ')
}

/** LoRA: installed ones (import local files, delete) and ones available to download. */
export function LoraTab({ catalog, location }: { catalog: Catalog; location: ModelLocation }): React.JSX.Element {
  const toast = useToast()
  const importAdapters = useApp((state) => state.importAdapters)
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<AdapterEntry | null>(null)
  if (!location.ready) {
    return (
      <p className="px-1 text-ui text-ink-2">
        {location.scanning
          ? `正在查看 ${location.host?.name ?? '远程主机'} 上的 LoRA`
          : `读不到 ${location.host?.name ?? '远程主机'} 上的 LoRA，回到「模型」重试。`}
      </p>
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
              <Row key={adapter.id} title={adapter.name} description={adapterDescription(adapter)}>
                <IconButton label={`删除 ${adapter.name}`} onClick={() => setRemoving(adapter)}>
                  <Trash2 className="size-4" strokeWidth={1.6} />
                </IconButton>
              </Row>
            ))}
          </Group>
        ) : (
          <Group>
            <EmptyState
              className="py-10"
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
              return (
                <Row
                  key={adapter.id}
                  title={adapter.name}
                  description={
                    <span className="flex flex-col gap-1.5">
                      <span>{adapterDescription(adapter)}</span>
                      {state.percent !== null ? (
                        <ProgressBar value={state.percent} label={`${adapter.name} 下载进度`} className="max-w-64" />
                      ) : null}
                    </span>
                  }
                >
                  {state.action !== 'download' ? (
                    <span className={cn('tabular text-caption', state.tone === 'danger' ? 'text-danger' : 'text-ink-2')}>{state.text}</span>
                  ) : null}
                  {state.action && state.action !== 'delete' ? (
                    <Button
                      tone="secondary"
                      disabled={busy !== null}
                      onClick={() => void act(adapter, state.action as 'download' | 'resume' | 'pause', task)}
                    >
                      {busy === adapter.id ? (
                        <Spinner />
                      ) : state.action === 'pause' ? (
                        <Pause className="size-4" strokeWidth={1.6} />
                      ) : state.action === 'resume' ? (
                        <Play className="size-4" strokeWidth={1.6} />
                      ) : (
                        <ArrowDownToLine className="size-4" strokeWidth={1.6} />
                      )}
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
