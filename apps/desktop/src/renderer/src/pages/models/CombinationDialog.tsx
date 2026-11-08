import { useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import {
  combinationBundle,
  combinationIds,
  missingBytes,
  SLOT_LABEL,
  SLOT_ROLE,
  SLOTS,
  slotChoices,
  suggestedName,
  type SlotChoice,
  type SlotKey,
} from '@shared/modelCombos'
import type { Catalog, ModelCombination } from '@shared/types'
import { call } from '../../lib/api'
import { Button, Field, Input, Modal, Select, Spinner, useToast } from '../../components/ui'
import { recommendedBundle, sizeText } from './logic'
import type { ModelLocation } from './useModelLocation'

/** The option that opens a file picker instead of choosing a part. */
const PICK_FILE = '__pick-file'

export type SlotValues = Record<SlotKey, string>

function defaults(catalog: Catalog, location: ModelLocation, initial?: Partial<Record<SlotKey, string | null>>): SlotValues {
  const recommended = recommendedBundle(catalog.bundles.filter((bundle) => !bundle.custom))
  const pick = (slot: SlotKey): string => {
    const given = initial?.[slot]
    if (given) return given
    const choices = slotChoices(catalog.models, slot, location.isModelInstalled)
    const wanted = recommended?.components[slot]
    return (choices.find((choice) => wanted && choice.ids.includes(wanted)) ?? choices[0])?.id ?? ''
  }
  return { dit: pick('dit'), textEncoder: pick('textEncoder'), vae: pick('vae') }
}

/** A native option holds plain text only: the size and whether it is here go in brackets, "MOSS-Image SFT INT8（15 GB，已下载）". */
function optionText(choice: SlotChoice): string {
  const facts = [choice.sizeBytes ? sizeText(choice.sizeBytes) : '', !choice.local && choice.installed ? '已下载' : ''].filter(Boolean)
  return facts.length ? `${choice.label}（${facts.join('，')}）` : choice.label
}

/**
 * 自己组合: a 主模型, a 文本编码器 and a VAE, each from the official downloads
 * or the person's own files, saved as a model. Only what is missing downloads.
 */
export function CombinationDialog({
  open,
  catalog,
  location,
  initial,
  onClose,
}: {
  open: boolean
  catalog: Catalog
  location: ModelLocation
  /** Slots filled from a folder the person picked. */
  initial?: Partial<Record<SlotKey, string | null>>
  onClose: () => void
}): React.JSX.Element {
  const toast = useToast()
  const [values, setValues] = useState<SlotValues>(() => defaults(catalog, location, initial))
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const [busy, setBusy] = useState(false)

  const choices = useMemo(
    () =>
      Object.fromEntries(SLOTS.map((slot) => [slot, slotChoices(catalog.models, slot, location.isModelInstalled)])) as Record<
        SlotKey,
        SlotChoice[]
      >,
    [catalog.models, location.isModelInstalled],
  )
  const suggested = suggestedName(values, catalog.models)
  const shownName = named ? name : suggested
  const need = missingBytes(combinationIds(values, catalog.models), catalog.models, location.isModelInstalled)
  const complete = SLOTS.every((slot) => values[slot])

  async function pickFile(slot: SlotKey): Promise<void> {
    try {
      const path = await call<string | null>(Ipc.pickDialog, { kind: 'model', title: `选择${SLOT_LABEL[slot]}文件` })
      if (!path) return
      const role = SLOT_ROLE[slot] as 'dit' | 'text_encoder' | 'vae'
      const result = await call<{ ids: Array<string | null> }>(Ipc.modelsRegisterScan, {
        items: [{ path, role, layout: 'comfyui-single-file' }],
      })
      const id = result.ids[0]
      if (!id) throw new Error('找不到这个文件')
      setValues((current) => ({ ...current, [slot]: id }))
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : String(cause), 'error')
    }
  }

  async function save(): Promise<void> {
    setBusy(true)
    try {
      const combination = await call<ModelCombination>(Ipc.modelsSaveCombination, {
        name: shownName.trim() || suggested,
        components: values,
      })
      if (need > 0) {
        await location.downloadBundle(combinationBundle(combination, catalog.models))
        toast.push(`已开始下载「${combination.name}」`, 'success')
      } else {
        toast.push(`已保存「${combination.name}」`, 'success')
      }
      onClose()
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : String(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="自己组合"
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <span className="tabular mr-auto text-ui text-ink-2" data-combination-need>
            {need > 0 ? `还要下载 ${sizeText(need)}` : '不用再下载'}
          </span>
          <Button tone="ghost" size="md" onClick={onClose}>
            取消
          </Button>
          <Button tone="primary" size="md" disabled={busy || !complete} onClick={() => void save()}>
            {busy ? <Spinner /> : null}
            {need > 0 ? '下载并保存' : '保存'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-combination-dialog>
        <Field label="名字">
          <Input
            value={shownName}
            maxLength={80}
            onChange={(event) => {
              setNamed(true)
              setName(event.target.value)
            }}
          />
        </Field>
        <div className="flex flex-col gap-2.5">
          {SLOTS.map((slot) => {
            const list = choices[slot]
            const downloads = list.filter((choice) => !choice.local)
            const own = list.filter((choice) => choice.local)
            return (
              <div key={slot} className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-3">
                <label htmlFor={`combination-${slot}`} className="text-ui text-ink-2">
                  {SLOT_LABEL[slot]}
                </label>
                <Select
                  id={`combination-${slot}`}
                  value={values[slot]}
                  onValueChange={(value) => {
                    if (value === PICK_FILE) void pickFile(slot)
                    else setValues((current) => ({ ...current, [slot]: value }))
                  }}
                >
                  <optgroup label="下载">
                    {downloads.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {optionText(choice)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="电脑上的文件">
                    {own.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {optionText(choice)}
                      </option>
                    ))}
                    <option value={PICK_FILE}>选择文件…</option>
                  </optgroup>
                </Select>
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
