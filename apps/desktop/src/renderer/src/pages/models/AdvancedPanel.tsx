import { FolderPlus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import { importFolderMessage, type ImportFolderResult } from '../../lib/modelFolder'
import type { Catalog, DownloadTask, ModelEntry } from '@shared/types'
import { call } from '../../lib/api'
import { ModelDirectoriesCard } from '../../components/ModelDirectoriesCard'
import { Button, ConfirmDialog, Field, Group, Pill, ProgressBar, Row, Section, Spinner, useToast } from '../../components/ui'
import { TextSetting } from '../training/TextSetting'
import { ROLE_LABEL, bundlesUsing, isOfferedComponent, itemState, sizeText, taskFor } from './logic'
import { DownloadActionIcon, RemoveButton } from './ModelEntries'
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
    const verb = model.provider === 'local' ? '移除' : '删除'
    try {
      await location.remove('model', model.id)
      toast.push(`已${verb} ${model.name}`, 'success')
    } catch (cause) {
      toast.push(`没能${verb}：${errorText(cause)}`, 'error')
    }
  }

  const users = removing ? bundlesUsing(removing.id, catalog.bundles).map((bundle) => bundle.name) : []
  return (
    <>
      <Group>
        {parts.map((model) => {
          const task = taskFor(location.tasks, 'model', model.id)
          // installState describes this computer's files; a remote host only has its inventory.
          const state = itemState(
            location.kind === 'remote' ? { ...model, installState: undefined } : model,
            location.isModelInstalled(model),
            task,
          )
          const format = model.provider === 'local' ? '本地文件' : model.format === 'comfyui' ? '单文件' : null
          return (
            <Row
              key={model.id}
              title={model.name}
              description={
                <span className="flex flex-col gap-1.5">
                  <span>
                    {[ROLE_LABEL[model.role], format, model.precision.toUpperCase(), sizeText(model.sizeBytes)].filter(Boolean).join(' · ')}
                  </span>
                  {state.percent !== null ? (
                    <ProgressBar value={state.percent} label={`${model.name} 下载进度`} className="max-w-64" />
                  ) : null}
                </span>
              }
            >
              {state.text ? (
                <Pill tone={state.tone} className="tabular">
                  {state.text}
                </Pill>
              ) : null}
              {state.action === 'delete' ? (
                <RemoveButton remove={model.provider === 'local'} name={model.name} onClick={() => setRemoving(model)} />
              ) : state.action ? (
                <Button
                  tone="secondary"
                  disabled={busy !== null}
                  onClick={() => void act(model, state.action as 'download' | 'resume' | 'pause', task)}
                >
                  {busy === model.id ? <Spinner /> : <DownloadActionIcon action={state.action} label={state.actionLabel} />}
                  {state.actionLabel}
                </Button>
              ) : null}
            </Row>
          )
        })}
      </Group>
      <ConfirmDialog
        open={Boolean(removing)}
        title={removing ? `${removing.provider === 'local' ? '移除' : '删除'}「${removing.name}」？` : ''}
        description={
          removing?.provider === 'local'
            ? '只从模型库里移除，电脑上的原文件不会被删除。'
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
        {/* Paths save themselves on Enter or when the field loses focus, like the trainer's paths. */}
        <div className="flex flex-col gap-3 px-3.5 py-3">
          <Field label="模型保存目录" hint="这台主机上存放下载模型的文件夹。">
            <TextSetting
              label="模型保存目录"
              value={root}
              validate={(value) => (value ? null : '填写一个文件夹')}
              onSave={async (value) => {
                await call(Ipc.hostsUpdatePaths, { id: hostId, modelsRoot: value ?? '' })
                setRoot(value ?? '')
              }}
            />
          </Field>
          <Field label="生成时使用的模型文件夹" hint="留空时按上面的目录自动查找。">
            <div className="flex items-start gap-2">
              <TextSetting
                label="生成时使用的模型文件夹"
                className="flex-1"
                value={modelPath}
                placeholder="例如 ~/.mossstudio/models/…/snapshots/…"
                onSave={async (value) => {
                  await call(Ipc.hostsUpdatePaths, { id: hostId, modelPath: value ?? '' })
                  setModelPath(value ?? '')
                }}
              />
              <Button
                tone="secondary"
                disabled={busy !== null}
                onClick={() =>
                  void run('find', async () => {
                    const result = await call<{ found?: string; message: string }>(Ipc.remoteResourceInspect, {
                      hostId,
                      kind: 'models',
                      path: root.trim() || '~/.mossstudio/models',
                    })
                    if (!result.found) throw new Error(result.message)
                    await call(Ipc.hostsUpdatePaths, { id: hostId, modelPath: result.found })
                    setModelPath(result.found)
                    return result.message
                  })
                }
              >
                {busy === 'find' ? <Spinner /> : null}
                自动查找
              </Button>
            </div>
          </Field>
        </div>
        <Row title="下载完整的默认模型" description="把官方默认模型整个下载到这台主机，完成后自动设为生成时使用的文件夹。">
          <Button
            tone="secondary"
            disabled={busy !== null}
            onClick={() =>
              void run('prepare', async () => {
                await call(Ipc.hostsUpdatePaths, { id: hostId, modelsRoot: root.trim() || undefined })
                await call<DownloadTask>(Ipc.enginePrepareRemoteModel, { hostId })
                return '已开始下载，进度在「下载」里'
              })
            }
          >
            {busy === 'prepare' ? <Spinner /> : null}
            下载
          </Button>
        </Row>
        {modelPath ? (
          <Row title="删除生成用的模型文件夹" description={modelPath}>
            <RemoveButton name={modelPath} disabled={busy !== null} onClick={() => setConfirmRemove(true)} />
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
      const result = await call<ImportFolderResult>(Ipc.modelsImportFolder)
      if (result.canceled) return
      toast.push(importFolderMessage(result), 'success')
    } catch (cause) {
      toast.push(errorText(cause), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Group>
      <Row
        title="在原位置使用这个模型文件夹"
        description="选一个完整的模型文件夹（例如从别的电脑拷来的 MOSS-Image），添加到模型库。文件留在原处，不复制、不移动。"
      >
        <Button tone="secondary" disabled={busy} onClick={() => void importFolder()}>
          {busy ? <Spinner /> : <FolderPlus className="size-4" strokeWidth={1.6} />}
          选择文件夹
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
