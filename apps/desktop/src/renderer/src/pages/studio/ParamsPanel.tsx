import { Lock, LockOpen, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Notice } from '../../components/common/Notice'
import type { Catalog, GpuInventorySnapshot, ManagedHost, ProjectCanvas, Settings } from '@shared/types'
import {
  ADAPTER_STRENGTH_MAX,
  ADAPTER_STRENGTH_MIN,
  ADAPTER_STRENGTH_STEP,
  adapterStatuses,
  clampAdapterStrength,
  formatAdapterStrength,
  normalizeCanvasAdapters,
} from '@shared/adapters'
import {
  Advanced,
  Button,
  EmptyState,
  FieldLabel,
  IconButton,
  Input,
  Kbd,
  Modal,
  Segmented,
  Select,
  Spinner,
  Textarea,
  cn,
  useCopyText,
} from '../../components/ui'
import {
  QUALITY_PRESETS,
  SIZE_PRESETS,
  clampDimension,
  isSeedLocked,
  parseSeed,
  qualityFor,
  qualityPreset,
  qualityLabel,
  sizePresetFor,
  type QualityId,
  type SizePresetId,
} from './defaults'
import { canvasDescription, withDescription, type CompiledPrompt } from './prompt'
import { installedBundles, type Blocker, type BundleChoice } from './readiness'
import { resizeCanvas } from './canvases'
import { useApp } from '../../store'
import { ImageCardPanel } from './ImageCardPanel'
import { SliderField, SlotHeader, SlotRow } from './InputControls'
import { InputsSection, type InputsWiring } from './InputsSection'
import { SamplingSection } from './SamplingSection'
import { samplingSummary } from './sampling'

const SHORTCUT = typeof window !== 'undefined' && window.clover?.platform === 'darwin' ? '⌘ ↵' : 'Ctrl ↵'

/** Commit-on-blur number field, so typing "1" on the way to "1024" is not clamped. */
function DimensionInput({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const next = clampDimension(Number(draft), value)
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }
  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
      className="tabular text-center"
    />
  )
}

export interface ParamsPanelProps {
  canvas: ProjectCanvas | null
  regionCount: number
  catalog: Catalog | null
  bundle: BundleChoice
  settings: Settings | null
  gpuInventory: GpuInventorySnapshot | null
  hosts: ManagedHost[]
  remoteHostId: string
  onRemoteHostChange: (id: string) => void
  blockers: Blocker[]
  prompt: CompiledPrompt | null
  busy: boolean
  submitting: boolean
  onChange: (update: (canvas: ProjectCanvas) => ProjectCanvas) => void
  onPickBundle: (id: string) => void
  onOpenAdapters: () => void
  onGenerate: () => void
  onCopyAsLayout: () => void
  onAddCanvas: () => void
  onNavigate: (to: string) => void
  /** Pictures, engine features and pick mode for the 输入 and sampling sections. */
  inputs?: InputsWiring
  /** For a picture card: make a new canvas that starts from it. */
  onUseAsStart?: (imageCanvasId: string) => void
}

export function ParamsPanel(props: ParamsPanelProps): React.JSX.Element {
  const { canvas } = props
  if (!canvas) {
    return (
      <div className="flex h-full flex-col justify-center">
        <EmptyState
          title="还没有画面"
          description="新建一个画面，写一句描述就能开始生成。"
          action={
            <Button tone="primary" size="md" onClick={props.onAddCanvas}>
              新建画面
            </Button>
          }
        />
      </div>
    )
  }
  if (canvas.kind === 'image') return <ImageCardPanel canvas={canvas} onUseAsStart={props.onUseAsStart} />
  return <CanvasParams {...props} canvas={canvas} />
}

function CanvasParams({
  canvas,
  regionCount,
  catalog,
  bundle,
  settings,
  gpuInventory,
  hosts,
  remoteHostId,
  onRemoteHostChange,
  blockers,
  prompt,
  busy,
  submitting,
  onChange,
  onPickBundle,
  onOpenAdapters,
  onGenerate,
  onCopyAsLayout,
  onNavigate,
  inputs,
}: ParamsPanelProps & { canvas: ProjectCanvas }): React.JSX.Element {
  const copyText = useCopyText()
  const openUpdate = useApp((state) => state.setUpdatePopoverOpen)
  const readOnly = canvas.kind === 'result'
  const [customSize, setCustomSize] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const sizePreset: SizePresetId = customSize ? 'custom' : sizePresetFor(canvas.width, canvas.height)
  const quality = qualityFor(canvas.steps)
  const installed = installedBundles(catalog)
  const adapters = normalizeCanvasAdapters(canvas.adapters)
  const adapterRows = adapterStatuses(adapters, catalog?.adapters)
  // An engine without LoRA (兼容模式 / AMD 原生): nothing to add; rows already there stay so they can be removed.
  const loraUnsupported = inputs?.features ? !inputs.features.lora : false
  const remoteEnabled = settings?.remoteHostsEnabled === true
  const remoteHost = remoteEnabled ? (hosts.find((host) => host.id === remoteHostId) ?? null) : null
  const description = canvasDescription(canvas)
  const seedLocked = isSeedLocked(canvas)

  useEffect(() => setCustomSize(false), [canvas.id])

  const defaultGpu =
    settings?.gpuSelection && settings.gpuSelection !== 'auto'
      ? gpuInventory?.devices.find((device) => device.uuid === (settings.gpuSelection as { uuid: string }).uuid)?.name
      : undefined
  const boundMissing = Boolean(
    canvas.deviceUuid && gpuInventory && !gpuInventory.devices.some((device) => device.uuid === canvas.deviceUuid),
  )
  const gpuName = canvas.deviceUuid ? gpuInventory?.devices.find((device) => device.uuid === canvas.deviceUuid)?.name : undefined
  const locationName = remoteHost ? remoteHost.name : '本机'
  const advancedSummary = [seedLocked ? `种子 ${canvas.seed}` : '种子随机', locationName, gpuName, samplingSummary(canvas)]
    .filter(Boolean)
    .join(' · ')

  const bundleOptions = [...installed]
  if (bundle.bundle && !bundleOptions.some((item) => item.id === bundle.bundle!.id)) bundleOptions.unshift(bundle.bundle)

  const setAdapters = (next: ProjectCanvas['adapters']): void =>
    onChange((current) => ({ ...current, adapters: normalizeCanvasAdapters(next) }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-5">
        {readOnly ? <Notice className="mb-5">这是一次生成的结果，参数已固定。想改动就复制成新画面。</Notice> : null}
        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-2.5">
            {/* What the model is finally sent sits next to the description it is built from. */}
            <FieldLabel
              htmlFor="studio-description"
              value={
                <Button tone="ghost" size="xs" className="-mr-2" onClick={() => setPromptOpen(true)}>
                  查看最终提示词
                </Button>
              }
            >
              描述
            </FieldLabel>
            <Textarea
              id="studio-description"
              aria-label="描述"
              value={description}
              onChange={(event) => onChange((current) => withDescription(current, event.target.value))}
              placeholder="想要什么样的画面？例如：春日街景，暖色调，午后阳光，胶片质感"
              className="h-[116px] resize-none"
            />
            {regionCount > 0 ? <p className="text-caption text-ink-2">另有 {regionCount} 个区域，在画面上编辑</p> : null}
          </section>

          {inputs && !readOnly ? <InputsSection canvas={canvas} onChange={onChange} wiring={inputs} blockers={blockers} /> : null}

          <section className="flex flex-col gap-2.5">
            <FieldLabel htmlFor="studio-model">模型</FieldLabel>
            <Select
              id="studio-model"
              value={bundle.bundle?.id ?? ''}
              disabled={readOnly || bundleOptions.length === 0}
              onChange={(event) => onPickBundle(event.target.value)}
            >
              {bundleOptions.length === 0 ? <option value="">{catalog ? '还没有可用的模型' : '正在读取模型…'}</option> : null}
              {bundleOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {installed.some((entry) => entry.id === item.id) ? item.name : `${item.name}（未下载）`}
                </option>
              ))}
            </Select>
            {loraUnsupported && !adapterRows.length ? null : (
              <SlotHeader title="LoRA" hint="叠加一种画风或角色">
                {readOnly || loraUnsupported ? null : (
                  <Button tone="ghost" size="xs" className="-mr-2" onClick={onOpenAdapters} data-adapter-picker>
                    <Plus className="size-3.5" aria-hidden="true" strokeWidth={1.6} />
                    添加
                  </Button>
                )}
              </SlotHeader>
            )}
            {adapterRows.length ? (
              <div className="flex flex-col gap-1">
                {adapterRows.map(({ adapter, name, installed: present }) => (
                  <SlotRow
                    key={adapter.id}
                    data-adapter-row={adapter.id}
                    title={present ? name : `${name}（找不到文件）`}
                    titleTone={present ? 'ink' : 'warn'}
                    removeLabel={`移除 ${name}`}
                    onRemove={readOnly ? undefined : () => setAdapters(adapters.filter((item) => item.id !== adapter.id))}
                  >
                    <SliderField
                      label="强度"
                      ariaLabel={`${name} 强度`}
                      min={ADAPTER_STRENGTH_MIN}
                      max={ADAPTER_STRENGTH_MAX}
                      step={ADAPTER_STRENGTH_STEP}
                      value={adapter.strength}
                      format={formatAdapterStrength}
                      onChange={(value) =>
                        setAdapters(
                          adapters.map((item) => (item.id === adapter.id ? { ...item, strength: clampAdapterStrength(value) } : item)),
                        )
                      }
                    />
                  </SlotRow>
                ))}
              </div>
            ) : null}
          </section>

          <section className="flex flex-col gap-2.5">
            <FieldLabel value={`${canvas.width} × ${canvas.height}`}>尺寸</FieldLabel>
            <Segmented<SizePresetId>
              block
              label="尺寸"
              value={sizePreset}
              onChange={(value) => {
                if (value === 'custom') {
                  setCustomSize(true)
                  return
                }
                setCustomSize(false)
                const preset = SIZE_PRESETS.find((item) => item.id === value)
                if (preset) onChange((current) => resizeCanvas(current, preset.width, preset.height))
              }}
              options={[
                ...SIZE_PRESETS.map((preset) => ({ value: preset.id, label: preset.id, hint: `${preset.width} × ${preset.height}` })),
                { value: 'custom' as const, label: '自定义' },
              ]}
              className="[&>button]:px-1"
            />
            {sizePreset === 'custom' && !readOnly ? (
              <div className="flex items-center gap-2">
                <DimensionInput
                  label="宽度"
                  value={canvas.width}
                  onCommit={(width) => onChange((current) => resizeCanvas(current, width, current.height))}
                />
                <span aria-hidden="true" className="text-ink-2">
                  ×
                </span>
                <DimensionInput
                  label="高度"
                  value={canvas.height}
                  onCommit={(height) => onChange((current) => resizeCanvas(current, current.width, height))}
                />
              </div>
            ) : null}
          </section>

          <section className="flex flex-col gap-2.5">
            <FieldLabel value={qualityLabel(canvas.steps)}>质量</FieldLabel>
            <Segmented<QualityId | 'custom'>
              block
              label="质量"
              value={quality}
              onChange={(value) => {
                if (value === 'custom') return
                const preset = qualityPreset(value)
                onChange((current) => ({ ...current, steps: preset.steps, cfg: preset.cfg }))
              }}
              options={QUALITY_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, hint: preset.hint }))}
            />
          </section>

          <Advanced dense summary={advancedSummary} className="-mx-3.5">
            <div className="flex flex-col gap-5 px-3.5 pb-2 pt-2">
              <section className="flex flex-col gap-2">
                <FieldLabel htmlFor="studio-seed">种子</FieldLabel>
                <div className="flex items-center gap-1.5">
                  <Input
                    id="studio-seed"
                    inputMode="numeric"
                    className="tabular"
                    value={seedLocked ? String(canvas.seed) : ''}
                    placeholder={canvas.seed ? `随机 · 上次 ${canvas.seed}` : '随机'}
                    onChange={(event) => {
                      const seed = parseSeed(event.target.value)
                      if (event.target.value.trim() === '') onChange((current) => ({ ...current, seedLocked: false }))
                      else if (seed !== null) onChange((current) => ({ ...current, seed, seedLocked: true }))
                    }}
                  />
                  <IconButton
                    label={seedLocked ? '解锁种子（每次随机）' : '锁定种子（保持不变）'}
                    aria-pressed={seedLocked}
                    className={cn(seedLocked && 'bg-well-strong text-ink')}
                    onClick={() => onChange((current) => ({ ...current, seedLocked: !isSeedLocked(current) }))}
                  >
                    {seedLocked ? <Lock className="size-4" strokeWidth={1.6} /> : <LockOpen className="size-4" strokeWidth={1.6} />}
                  </IconButton>
                </div>
                <p className="text-caption text-ink-2">
                  {seedLocked ? '每次生成都用这个种子。' : '每次生成换一个新种子；锁定后保持不变。'}
                </p>
              </section>

              <section className="flex flex-col gap-2">
                <SliderField
                  id="studio-cfg"
                  label="CFG"
                  min={0}
                  max={10}
                  step={0.5}
                  value={canvas.cfg}
                  format={(value) => String(value)}
                  onChange={(cfg) => onChange((current) => ({ ...current, cfg }))}
                />
                <p className="text-caption text-ink-2">越高越贴近描述，过高会生硬。快速档建议 1。</p>
              </section>

              <section className="flex flex-col gap-2">
                <FieldLabel htmlFor="studio-negative">不想出现的内容</FieldLabel>
                <Textarea
                  id="studio-negative"
                  value={canvas.negative}
                  onChange={(event) => onChange((current) => ({ ...current, negative: event.target.value }))}
                  className="min-h-[64px] resize-none"
                  rows={2}
                />
              </section>

              {inputs ? <SamplingSection canvas={canvas} features={inputs.features} onChange={onChange} /> : null}

              {remoteEnabled ? (
                <section className="flex flex-col gap-2">
                  <FieldLabel htmlFor="studio-location">运行位置</FieldLabel>
                  <Select id="studio-location" value={remoteHost?.id ?? ''} onChange={(event) => onRemoteHostChange(event.target.value)}>
                    <option value="">这台电脑</option>
                    {hosts.map((host) => (
                      <option key={host.id} value={host.id}>
                        {host.status === 'error' ? `${host.name}（连接不上）` : host.name}
                      </option>
                    ))}
                  </Select>
                </section>
              ) : null}

              {remoteHost ? (
                remoteHost.devices.length ? (
                  <section className="flex flex-col gap-2">
                    <FieldLabel htmlFor="studio-remote-gpu">显卡</FieldLabel>
                    <Select
                      id="studio-remote-gpu"
                      value={canvas.deviceId ?? ''}
                      onChange={(event) => onChange((current) => ({ ...current, deviceId: event.target.value || undefined }))}
                    >
                      <option value="">自动选择</option>
                      {remoteHost.devices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name}
                        </option>
                      ))}
                    </Select>
                  </section>
                ) : null
              ) : (
                <section className="flex flex-col gap-2">
                  <FieldLabel htmlFor="studio-gpu">显卡</FieldLabel>
                  <Select
                    id="studio-gpu"
                    value={canvas.deviceUuid ?? ''}
                    onChange={(event) => onChange((current) => ({ ...current, deviceUuid: event.target.value || undefined }))}
                  >
                    <option value="">{defaultGpu ? `跟随默认（${defaultGpu}）` : '跟随默认'}</option>
                    {boundMissing ? (
                      <option value={canvas.deviceUuid} disabled>
                        之前选的显卡现在找不到
                      </option>
                    ) : null}
                    {(gpuInventory?.devices ?? []).map((device) => (
                      <option key={device.uuid} value={device.uuid}>
                        {device.name} · 显卡 {device.index}
                      </option>
                    ))}
                  </Select>
                  {boundMissing ? <Notice tone="warn">之前选的显卡现在找不到，生成前请换一个或改回默认。</Notice> : null}
                </section>
              )}
            </div>
          </Advanced>
        </fieldset>
      </div>

      <div className="flex shrink-0 flex-col gap-2.5 px-5 pb-4 pt-3">
        {readOnly ? (
          <Button tone="primary" size="lg" block onClick={onCopyAsLayout}>
            复制为新画面
          </Button>
        ) : (
          <>
            {blockers.length ? (
              <ul aria-live="polite" className="flex flex-col gap-1.5">
                {blockers.map((blocker, index) => (
                  // Every reason not to generate reads the same: a Notice with the action that fixes it.
                  <li key={`${blocker.id}-${index}`}>
                    <Notice
                      action={
                        blocker.action ? (
                          <Button
                            size="xs"
                            onClick={() => (blocker.action!.opens === 'update' ? openUpdate(true) : onNavigate(blocker.action!.to))}
                          >
                            {blocker.action.label}
                          </Button>
                        ) : undefined
                      }
                    >
                      {blocker.message}
                    </Notice>
                  </li>
                ))}
              </ul>
            ) : null}
            <Button
              tone="primary"
              size="lg"
              block
              data-studio-generate
              aria-busy={submitting || busy}
              disabled={submitting || busy || blockers.length > 0}
              onClick={onGenerate}
              title={busy ? '这个画面正在生成' : undefined}
            >
              {submitting || busy ? <Spinner /> : null}
              {submitting ? '正在提交…' : busy ? '生成中…' : '生成'}
              {!submitting && !busy ? <Kbd>{SHORTCUT}</Kbd> : null}
            </Button>
          </>
        )}
      </div>

      <Modal
        open={promptOpen}
        onClose={() => setPromptOpen(false)}
        title="最终提示词"
        description="这是生成时实际发送给模型的内容，由描述和可见的区域组成。"
        width="max-w-3xl"
        footer={
          <>
            <Button tone="ghost" size="md" onClick={() => setPromptOpen(false)}>
              关闭
            </Button>
            <Button
              tone="secondary"
              size="md"
              disabled={!prompt?.ok}
              onClick={() => {
                if (prompt?.ok) void copyText(prompt.prompt, '已复制最终提示词')
              }}
            >
              复制
            </Button>
          </>
        }
      >
        {prompt?.ok ? (
          <pre className="selectable max-h-[52vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-well p-3 font-mono text-caption text-ink">
            {prompt.preview}
          </pre>
        ) : (
          <p className="text-control text-ink-2">{prompt?.errors[0] ?? '描述还不完整'}</p>
        )}
      </Modal>
    </div>
  )
}
