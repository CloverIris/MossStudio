import { useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import { unusedDownloads } from '@shared/modelCombos'
import type { Catalog, DownloadTask, ModelEntry } from '@shared/types'
import { call } from '../../lib/api'
import { ModelDirectoriesCard } from '../../components/ModelDirectoriesCard'
import { ModelName } from '../../components/common/ModelName'
import { Button, ConfirmDialog, Field, Group, Modal, Row, Section, Spinner, Tag, useToast } from '../../components/ui'
import { TextSetting } from '../training/TextSetting'
import { sizeText } from './logic'
import { RemoveButton, SizeText } from './ModelEntries'
import type { ModelLocation } from './useModelLocation'

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** Downloads no model needs any more (for example single files from older versions), to clear them away. */
function UnusedFiles({ catalog, location }: { catalog: Catalog; location: ModelLocation }): React.JSX.Element | null {
  const toast = useToast()
  const [listing, setListing] = useState(false)
  const [removing, setRemoving] = useState<ModelEntry[] | null>(null)
  const unused = useMemo(
    () => unusedDownloads(catalog.models, catalog.bundles, location.isModelInstalled),
    [catalog.models, catalog.bundles, location.isModelInstalled],
  )
  if (!unused.length) return null
  const bytes = (entries: ModelEntry[]): number => entries.reduce((sum, model) => sum + (model.installedBytes || model.sizeBytes || 0), 0)

  async function remove(entries: ModelEntry[]): Promise<void> {
    setRemoving(null)
    try {
      await location.removeMany(
        'model',
        entries.map((model) => model.id),
      )
      toast.push(entries.length === 1 ? `已删除 ${entries[0]!.name}` : `已删除 ${entries.length} 个文件`, 'success')
    } catch (cause) {
      toast.push(`没能删除：${errorText(cause)}`, 'error')
    }
  }

  return (
    <div data-unused-files>
      <Group>
        <Row title="没有用到的文件" description={<span className="tabular">{`${unused.length} 个文件`}</span>}>
          <SizeText bytes={bytes(unused)} />
          <Button tone="ghost" onClick={() => setListing(true)}>
            查看
          </Button>
          <Button tone="secondary" onClick={() => setRemoving(unused)}>
            全部删除
          </Button>
        </Row>
      </Group>
      <Modal open={listing} title="没有用到的文件" onClose={() => setListing(false)} width="max-w-lg">
        <div className="flex flex-col gap-0.5">
          {unused.map((model) => (
            <Row
              key={model.id}
              title={<ModelName item={model} />}
              // The precision is a tag of its own unless the name already carries it.
              description={model.variant?.length ? undefined : <Tag>{model.precision.toUpperCase()}</Tag>}
            >
              <SizeText bytes={model.installedBytes || model.sizeBytes} />
              <RemoveButton name={model.name} onClick={() => setRemoving([model])} />
            </Row>
          ))}
        </div>
      </Modal>
      <ConfirmDialog
        open={Boolean(removing)}
        title={removing?.length === 1 ? `删除「${removing[0]!.name}」？` : `删除 ${removing?.length ?? 0} 个没有用到的文件？`}
        description={`可释放约 ${sizeText(bytes(removing ?? []))}。需要时可以重新下载。`}
        confirmLabel="删除"
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </div>
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

/** Everything under 模型 › 高级. */
export function AdvancedPanel({ catalog, location }: { catalog: Catalog; location: ModelLocation }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 pt-2">
      {location.kind === 'local' ? (
        <>
          <Section title="文件夹">
            <ModelDirectoriesCard />
          </Section>
          <UnusedFiles catalog={catalog} location={location} />
        </>
      ) : (
        <Section title={`${location.host?.name ?? '远程主机'} 上的文件夹`}>
          <RemoteFolders location={location} />
        </Section>
      )}
    </div>
  )
}
