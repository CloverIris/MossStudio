import { FileUp, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Ipc } from '@shared/channels'
import type { ControlAdapterEntry } from '@shared/types'
import { Button, ConfirmDialog, EmptyState, Group, Row, Section, Spinner, useToast } from '../../components/ui'
import { call } from '../../lib/api'
import { useControlAdapters } from '../../lib/useControlAdapters'
import { controlKindLabel } from '../studio/links'
import { useEngineFeatures } from '../studio/useEngineFeatures'
import { sizeText } from './logic'
import { RemoveButton } from './ModelEntries'

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * 控制适配器: files that let a generation follow a depth, edge or pose picture.
 * Registered here (the engine checks each file), chosen per canvas in 创作.
 * Hidden when this computer's engine cannot use them.
 */
export function ControlAdaptersSection(): React.JSX.Element | null {
  const toast = useToast()
  const features = useEngineFeatures({})
  const { adapters, refresh } = useControlAdapters()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<ControlAdapterEntry | null>(null)

  if (features && !features.control && adapters.length === 0) return null
  const noEngine = features === null
  const reading = features === undefined

  async function add(): Promise<void> {
    setAdding(true)
    try {
      const path = await call<string | null>(Ipc.pickDialog, { kind: 'file', title: '选择控制适配器文件（.safetensors）' })
      if (!path) return
      const entry = await call<ControlAdapterEntry>(Ipc.controlAdaptersAdd, { path })
      refresh()
      toast.push(`已添加 ${entry.name}`, 'success')
    } catch (cause) {
      toast.push(`没能添加：${errorText(cause)}`, 'error')
    } finally {
      setAdding(false)
    }
  }

  async function remove(entry: ControlAdapterEntry): Promise<void> {
    setRemoving(null)
    try {
      await call(Ipc.controlAdaptersRemove, { id: entry.id })
      refresh()
      toast.push(`已移除 ${entry.name}`, 'success')
    } catch (cause) {
      toast.push(`没能移除：${errorText(cause)}`, 'error')
    }
  }

  return (
    <Section
      title="控制适配器"
      description={noEngine ? '引擎准备好后才能添加控制适配器。' : '让生成按深度、边缘或姿态图来构图。在创作的「输入 › 控制」里选用。'}
      actions={
        <Button tone="secondary" disabled={adding || noEngine || reading} onClick={() => void add()} data-control-adapter-add>
          {adding ? <Spinner /> : <FileUp className="size-4" strokeWidth={1.6} />}
          添加文件
        </Button>
      }
    >
      <Group>
        {adapters.length ? (
          adapters.map((entry) => (
            <Row
              key={entry.id}
              title={entry.name}
              description={
                <span className="tabular">{[...entry.controlKinds.map(controlKindLabel), sizeText(entry.sizeBytes)].join(' · ')}</span>
              }
            >
              <RemoveButton remove name={entry.name} onClick={() => setRemoving(entry)} />
            </Row>
          ))
        ) : (
          <EmptyState
            size="section"
            icon={<SlidersHorizontal className="size-6" strokeWidth={1.6} />}
            title="还没有控制适配器"
            description="添加电脑上的 .safetensors 控制适配器文件。"
          />
        )}
      </Group>

      <ConfirmDialog
        open={Boolean(removing)}
        title={removing ? `移除「${removing.name}」？` : ''}
        description="只从列表里移除，文件本身不会删除。用它的画面需要重新选一个适配器。"
        confirmLabel="移除"
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </Section>
  )
}
