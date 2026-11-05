import { ArrowDownToLine, FolderInput, Pause, Play, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { Catalog, DownloadTask, ModelEntry } from '@shared/types'
import { call } from '../../lib/api'
import { ModelDirectoriesCard } from '../../components/ModelDirectoriesCard'
import { Button, ConfirmDialog, Field, Group, IconButton, Input, ProgressBar, Row, Section, Spinner, cn, useToast } from '../../components/ui'
import { ROLE_LABEL, bundlesUsing, isOfferedComponent, itemState, sizeText, taskFor } from './logic'
import type { ModelLocation } from './useModelLocation'

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
const ROLE_ORDER: ModelEntry['role'][] = ['dit', 'full', 'text_encoder', 'vae', 'support']

/** Individual parts (main model, text encoder, VAE, configuration) of every model. */
function PartsList({ catalog, location }: { catalog: Catalog; location: ModelLocation }): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ModelEntry | null>(null)
  const parts = useMemo(
    () =>
      catalog.models
        .filter(isOfferedComponent)
        .filter((model) => location.kind === 'local' || model.provider !== 'local')
        .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)),
    [catalog.models, location.kind],
  )

  async function act(model: ModelEntry, action: 'download' | 'resume' | 'pause', task: DownloadTask | undefined): Promise<void> {
    setBusy(model.id)
    try {
      if (action === 'pause' && task) await location.pause(task)
      else if (action === 'resume' && task) await location.resume(task)
      else await location.download('model', model.id)
    } catch (cause) {
      toast.push(errorText(cause), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function remove(model: ModelEntry): Promise<void> {
    setRemoving(null)
    try {
      await location.remove('model', model.id)
      toast.push(`已删除 ${model.name}`, 'success')
    } catch (cause) {
      toast.push(`没能删除：${errorText(cause)}`, 'error')
    }
  }

  const users = removing ? bundlesUsing(removing.id, catalog.bundles).map((bundle) => bundle.name) : []
  return (
    <>
      <Group>
        {parts.map((model) => {
          const task = taskFor(location.tasks, 'model', model.id)
          // installState describes this computer's files; a remote host only has its inventory.
          const state = itemState(location.kind === 'remote' ? { ...model, installState: undefined } : model, location.isModelInstalled(model), task)
          const format = model.provider === 'local' ? '本地文件' : model.format === 'comfyui' ? '单文件' : null
          return (
            <Row
              key={model.id}
              title={model.name}
              description={
                <span className="flex flex-col gap-1.5">
                  <span>{[ROLE_LABEL[model.role], format, model.precision.toUpperCase(), sizeText(model.sizeBytes)].filter(Boolean).join(' · ')}</span>
                  {state.percent !== null ? <ProgressBar value={state.percent} label={`${model.name} 下载进度`} className="max-w-64" /> : null}
                </span>
              }
            >
              {!(state.action === 'download' && state.actionLabel === '下载') ? (
                <span className={cn('tabular text-caption', state.tone === 'ok' ? 'text-ok' : state.tone === 'danger' ? 'text-danger' : state.tone === 'warn' ? 'text-warn' : 'text-ink-2')}>
                  {state.text}
                </span>
              ) : null}
              {state.action === 'delete' ? (
                <IconButton label={`${state.actionLabel} ${model.name}`} onClick={() => setRemoving(model)}>
                  <Trash2 className="size-4" strokeWidth={1.6} />
                </IconButton>
              ) : state.action ? (
                <Button tone="secondary" disabled={busy !== null} onClick={() => void act(model, state.action as 'download' | 'resume' | 'pause', task)}>
                  {busy === model.id ? <Spinner /> : state.action === 'pause' ? <Pause className="size-4" strokeWidth={1.6} /> : state.action === 'resume' ? <Play className="size-4" strokeWidth={1.6} /> : <ArrowDownToLine className="size-4" strokeWidth={1.6} />}
                  {state.action === 'download' && state.actionLabel === '下载' ? `下载 · ${sizeText(model.sizeBytes)}` : state.actionLabel}
                </Button>
              ) : null}
            </Row>
          )
        })}
      </Group>
      <ConfirmDialog
        open={Boolean(removing)}
        title={removing ? `删除「${removing.name}」？` : ''}
        description={
          removing?.provider === 'local'
            ? '只移除模型库里的登记，电脑上的原文件不会被删除。'
            : `${users.length ? `${users.join('、')} 需要这个文件，删除后这些模型要重新下载它才能使用。` : ''}可释放约 ${sizeText(removing?.installedBytes || removing?.sizeBytes)}。`
        }
        confirmLabel={removing?.provider === 'local' ? '移除' : '删除'}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </>
  )
}

/** Remote host: where models are kept and which folder generation loads. */
function RemoteFolders({ location }: { location: ModelLocation }): React.JSX.Element | null {
  const toast = useToast()
  const host = location.host
  const [root, setRoot] = useState(host?.modelsRoot ?? '~/.mossstudio/models')
  const [modelPath, setModelPath] = useState(host?.modelPath ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  useEffect(() => setRoot(host?.modelsRoot ?? '~/.mossstudio/models'), [host?.id, host?.modelsRoot])
  useEffect(() => setModelPath(host?.modelPath ?? ''), [host?.id, host?.modelPath])
  if (!host) return null

  async function run(key: string, action: () => Promise<string | void>): Promise<void> {
    setBusy(key)
    try {
      const done = await action()
      if (done) toast.push(done, 'success')
    } catch (cause) {
      toast.push(errorText(cause), 'error')
    } finally {
      setBusy(null)
    }
  }
  const hostId = host.id

  return (
    <>
      <Group>
        <div className="flex flex-col gap-3 px-3.5 py-3">
          <Field label="模型保存目录" hint="这台主机上存放下载模型的文件夹。">
            <div className="flex gap-2">
              <Input value={root} onChange={(event) => setRoot(event.target.value)} className="min-w-0 flex-1" />
              <Button
                tone="secondary"
                size="md"
                disabled={busy !== null || !root.trim()}
                onClick={() => void run('root', async () => {
                  await call(Ipc.hostsUpdatePaths, { id: hostId, modelsRoot: root.trim() })
                  return '已保存'
                })}
              >
                保存
              </Button>
            </div>
          </Field>
          <Field label="生成时使用的模型文件夹" hint="留空时按上面的目录自动查找。">
            <div className="flex gap-2">
              <Input value={modelPath} onChange={(event) => setModelPath(event.target.value)} placeholder="例如 ~/.mossstudio/models/…/snapshots/…" className="min-w-0 flex-1" />
              <Button
                tone="secondary"
                size="md"
                disabled={busy !== null}
                onClick={() => void run('find', async () => {
                  const result = await call<{ found?: string; message: string }>(Ipc.remoteResourceInspect, { hostId, kind: 'models', path: root.trim() || '~/.mossstudio/models' })
                  if (!result.found) throw new Error(result.message)
                  setModelPath(result.found)
                  await call(Ipc.hostsUpdatePaths, { id: hostId, modelPath: result.found })
                  return result.message
                })}
              >
                自动查找
              </Button>
              <Button
                tone="secondary"
                size="md"
                disabled={busy !== null}
                onClick={() => void run('path', async () => {
                  await call(Ipc.hostsUpdatePaths, { id: hostId, modelPath: modelPath.trim() })
                  return '已保存'
                })}
              >
                保存
              </Button>
            </div>
          </Field>
        </div>
        <Row title="下载完整的默认模型" description="把官方默认模型整个下载到这台主机，完成后自动设为生成时使用的文件夹。">
          <Button
            tone="secondary"
            disabled={busy !== null}
            onClick={() => void run('prepare', async () => {
              await call(Ipc.hostsUpdatePaths, { id: hostId, modelsRoot: root.trim() || undefined })
              await call<DownloadTask>(Ipc.enginePrepareRemoteModel, { hostId })
              return '已开始下载，进度在「下载」里'
            })}
          >
            {busy === 'prepare' ? <Spinner /> : null}下载
          </Button>
        </Row>
        {modelPath ? (
          <Row title="删除生成用的模型文件夹" description={modelPath}>
            <Button tone="ghost" className="text-danger" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>删除</Button>
          </Row>
        ) : null}
      </Group>
      <ConfirmDialog
        open={confirmRemove}
        title="删除这个文件夹？"
        description={`会删除 ${host.name} 上的 ${modelPath} 整个文件夹，放在里面的其他模型部件也会一起删除，之后需要重新下载才能在这台主机上生成。`}
        confirmLabel="删除"
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          void run('remove', async () => {
            await call(Ipc.remoteResourceRemove, { hostId, path: modelPath })
            await call(Ipc.hostsUpdatePaths, { id: hostId, modelPath: '' })
            setModelPath('')
            location.rescan()
            return '已删除'
          })
        }}
      />
    </>
  )
}

function ImportFolderRow(): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  async function importFolder(): Promise<void> {
    setBusy(true)
    try {
      const result = await call<{ canceled: boolean; added: number; duplicates: number }>(Ipc.modelsImportFolder)
      if (result.canceled) return
      toast.push(
        result.added ? `已导入 ${result.added} 个模型文件${result.duplicates ? `，${result.duplicates} 个重复的已跳过` : ''}` : '这个文件夹里的文件都已经导入过',
        'success',
      )
    } catch (cause) {
      toast.push(errorText(cause), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Group>
      <Row title="复制模型文件夹到模型库" description="把一个模型文件夹复制进模型目录，适合从别的电脑拷来的模型。">
        <Button tone="secondary" disabled={busy} onClick={() => void importFolder()}>
          {busy ? <Spinner /> : <FolderInput className="size-4" strokeWidth={1.6} />}选择文件夹
        </Button>
      </Row>
    </Group>
  )
}

/** Everything under 模型 › 高级. */
export function AdvancedPanel({ catalog, location }: { catalog: Catalog; location: ModelLocation }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 pt-2">
      <Section title="单独的部件" description="每个模型由主模型、文本编码器、VAE 和运行配置组成；共用的部件只下载一次。">
        <PartsList catalog={catalog} location={location} />
      </Section>
      {location.kind === 'local' ? (
        <>
          <Section title="文件夹">
            <ModelDirectoriesCard />
          </Section>
          <ImportFolderRow />
        </>
      ) : (
        <Section title={`${location.host?.name ?? '远程主机'} 上的文件夹`}>
          <RemoteFolders location={location} />
        </Section>
      )}
    </div>
  )
}
