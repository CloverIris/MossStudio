import { Brush, ImageOff, Plus, X } from 'lucide-react'
import type { CanvasImageLink, ControlAdapterEntry, EngineFeatures, ProjectCanvas } from '@shared/types'
import { MenuItem, Popover } from '../../components/common/Popover'
import { Advanced, Button, IconButton, Segmented, Select } from '../../components/ui'
import { cloverUrl } from '../../lib/clover'
import { FieldLabel, OptionalNumberInput, SliderField } from './InputControls'
import {
  MAX_REFERENCES,
  canvasPicture,
  clearMask,
  controlKindLabel,
  linkSourceCanvas,
  patchControl,
  patchControlImage,
  patchInit,
  patchReferences,
  percent,
  removeLink,
  roleLabel,
  setControlAdapter,
  type LinkRole,
  type PickTarget,
} from './links'
import { enumLabel, enumValues } from './sampling'

/** What the 输入 section needs from the Studio page besides the canvas itself. */
export interface InputsWiring {
  canvases: readonly ProjectCanvas[]
  /** Engine features of the canvas's target; undefined while reading, null when no engine is usable. */
  features: EngineFeatures | null | undefined
  controlAdapters: readonly ControlAdapterEntry[]
  pickTarget: PickTarget | null
  onPickTarget: (target: PickTarget | null) => void
  /** Choose picture files and link them into a role (references may take several). */
  onAddFromFile: (role: LinkRole, kind?: string) => void
  maskTool: boolean
  onToggleMask: () => void
  onNavigate: (to: string) => void
}

type Change = (update: (canvas: ProjectCanvas) => ProjectCanvas) => void

const pct = (value: number): string => percent(value)
const times = (value: number): string => value.toFixed(2).replace(/\.?0+$/, '') || '0'

/** The picture a link brings in: thumbnail, name, and a remove action. */
function SourceRow({
  link,
  canvases,
  label,
  onRemove,
  children,
}: {
  link: CanvasImageLink
  canvases: readonly ProjectCanvas[]
  label: string
  onRemove: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const source = linkSourceCanvas(link, canvases)
  const picture = source ? canvasPicture(source, link.output) : null
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-well p-2" data-input-row={label}>
      <div className="flex items-center gap-2.5">
        <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-well-strong">
          {picture ? (
            <img src={cloverUrl(picture)} alt="" draggable={false} className="size-full object-cover" />
          ) : (
            <ImageOff className="size-4 text-ink-2" strokeWidth={1.6} aria-hidden="true" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui text-ink">{source?.title ?? '找不到了'}</span>
          <span className="truncate text-caption text-ink-2">{picture ? label : source ? `${label} · 还没生成` : label}</span>
        </span>
        <IconButton label={`移除${label}`} className="size-7" onClick={onRemove}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {children}
    </div>
  )
}

/** 添加 → 从画板选择 / 从文件; while picking, a cancel instead. */
function AddButton({
  canvas,
  role,
  kind,
  label,
  wiring,
  disabled,
}: {
  canvas: ProjectCanvas
  role: LinkRole
  kind?: string
  label: string
  wiring: InputsWiring
  disabled?: boolean
}): React.JSX.Element {
  const picking = wiring.pickTarget?.canvasId === canvas.id && wiring.pickTarget.role === role && wiring.pickTarget.kind === kind
  if (picking) {
    return (
      <Button tone="secondary" size="sm" className="h-[26px] px-2" onClick={() => wiring.onPickTarget(null)}>
        取消选择
      </Button>
    )
  }
  return (
    <Popover
      align="end"
      label={`添加${label}`}
      trigger={(props) => (
        <Button
          tone="ghost"
          size="sm"
          className="-mr-2 h-[26px] px-2"
          disabled={disabled}
          aria-label={`添加${label}`}
          aria-expanded={props['aria-expanded']}
          aria-controls={props['aria-controls']}
          aria-haspopup={props['aria-haspopup']}
          onClick={props.toggle}
        >
          <Plus className="size-3.5" aria-hidden="true" />添加
        </Button>
      )}
    >
      {(close) => (
        <>
          <MenuItem onSelect={() => { close(); wiring.onPickTarget({ canvasId: canvas.id, role, ...(kind ? { kind } : {}) }) }}>从画板选择</MenuItem>
          <MenuItem onSelect={() => { close(); wiring.onAddFromFile(role, kind) }}>从文件…</MenuItem>
        </>
      )}
    </Popover>
  )
}

function SlotHeader({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-[26px] items-center justify-between gap-2">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-ui text-ink">{title}</span>
        {hint ? <span className="truncate text-caption text-ink-2">{hint}</span> : null}
      </span>
      {children}
    </div>
  )
}

/**
 * 输入: the pictures a layout canvas generates from. Each is a link to another
 * card on the board (drawn as a wire). Rows the engine cannot do are hidden;
 * with no usable engine they are shown disabled with the reason.
 */
export function InputsSection({ canvas, onChange, wiring }: { canvas: ProjectCanvas; onChange: Change; wiring: InputsWiring }): React.JSX.Element | null {
  const { features, canvases } = wiring
  const inputs = canvas.inputs
  const known = Boolean(features)
  const unavailable = features === null ? '没有可用的引擎，暂时不能添加图片' : features === undefined ? '正在读取引擎支持的功能…' : null
  // A row stays visible while it holds something, so it can always be removed.
  const showInit = !known || features!.imageInput || Boolean(inputs?.init)
  const showControl = !known || features!.control || Boolean(inputs?.control)
  const showReferences = !known || features!.references || Boolean(inputs?.references?.links.length)
  if (!showInit && !showControl && !showReferences) return null

  const picking = wiring.pickTarget?.canvasId === canvas.id ? wiring.pickTarget : null
  const adapter = inputs?.control ? wiring.controlAdapters.find((item) => item.id === inputs.control!.adapterId) : undefined
  const controlKinds = adapter
    ? [...adapter.controlKinds, ...(inputs?.control?.images ?? []).map((image) => image.kind).filter((kind) => !adapter.controlKinds.includes(kind))]
    : (inputs?.control?.images ?? []).map((image) => image.kind)
  const resizeValues = enumValues(features, 'resize')
  const referenceLinks = inputs?.references?.links ?? []
  const hasAdvanced = Boolean(inputs?.init || inputs?.control?.images.length || referenceLinks.length || inputs?.control?.adapterId)
  const disabled = unavailable !== null

  return (
    <section aria-label="输入" className="flex flex-col gap-2.5" data-inputs-section>
      <FieldLabel>输入</FieldLabel>
      {unavailable ? <p className="text-caption text-ink-2">{unavailable}</p> : null}
      {picking ? (
        <p role="status" className="rounded-lg bg-accent-soft px-3 py-2 text-caption text-ink">
          在画板上点一张有图片的卡片作为{picking.role === 'control' ? `控制图 · ${controlKindLabel(picking.kind ?? '')}` : roleLabel(picking.role)}，按 Esc 取消
        </p>
      ) : null}

      {showInit ? (
        <div className="flex flex-col gap-1.5">
          {inputs?.init ? (
            <SourceRow link={inputs.init.link} canvases={canvases} label="起始图" onRemove={() => onChange((current) => removeLink(current, 'init'))}>
              <SliderField
                label="重绘幅度"
                value={inputs.init.strength}
                min={0}
                max={1}
                step={0.05}
                format={pct}
                onChange={(strength) => onChange((current) => patchInit(current, { strength }))}
              />
            </SourceRow>
          ) : (
            <SlotHeader title="起始图" hint="从一张图开始改">
              <AddButton canvas={canvas} role="init" label="起始图" wiring={wiring} disabled={disabled} />
            </SlotHeader>
          )}
          {inputs?.init && (!known || features!.imageInput) ? (
            <div className="flex items-center justify-between gap-2 px-2" data-mask-row>
              <span className="flex min-w-0 flex-1 items-baseline gap-2" title={inputs.mask ? '只重画涂过的地方' : '没有遮罩时整张图都会重画'}>
                <span className="shrink-0 text-ui text-ink">遮罩</span>
                <span className="truncate text-caption text-ink-2">{inputs.mask ? '已画' : '未画'}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {inputs.mask ? (
                  <Button tone="ghost" size="sm" className="h-[26px] px-2" onClick={() => onChange(clearMask)}>清除</Button>
                ) : null}
                <Button
                  tone={wiring.maskTool ? 'primary' : 'secondary'}
                  size="sm"
                  className="h-[26px] px-2"
                  aria-pressed={wiring.maskTool}
                  disabled={disabled}
                  onClick={wiring.onToggleMask}
                >
                  <Brush className="size-3.5" aria-hidden="true" />{wiring.maskTool ? '完成' : '画遮罩'}
                </Button>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {showControl ? (
        <div className="flex flex-col gap-1.5" data-control-row>
          <SlotHeader title="控制" hint={wiring.controlAdapters.length ? '按深度、边缘或姿态引导构图' : undefined} />
          {wiring.controlAdapters.length === 0 && !inputs?.control ? (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-well px-3 py-2">
              <span className="text-caption text-ink-2">需要控制适配器</span>
              <Button tone="secondary" size="sm" className="h-[26px] px-2" onClick={() => wiring.onNavigate('/models')}>
                去添加
              </Button>
            </div>
          ) : (
            <>
              <Select
                aria-label="控制适配器"
                value={inputs?.control?.adapterId ?? ''}
                disabled={disabled}
                onChange={(event) => onChange((current) => setControlAdapter(current, event.target.value))}
              >
                <option value="">{inputs?.control?.adapterId ? '不使用控制' : '选择控制适配器'}</option>
                {wiring.controlAdapters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                {inputs?.control?.adapterId && !adapter ? <option value={inputs.control.adapterId} disabled>找不到的适配器</option> : null}
              </Select>
              {controlKinds.map((kind) => {
                const image = inputs?.control?.images.find((item) => item.kind === kind)
                const label = `控制图 · ${controlKindLabel(kind)}`
                return image ? (
                  <SourceRow key={kind} link={image.link} canvases={canvases} label={label} onRemove={() => onChange((current) => removeLink(current, 'control', kind))}>
                    <SliderField
                      label="强度"
                      value={image.strength}
                      min={0}
                      max={2}
                      step={0.05}
                      format={times}
                      onChange={(strength) => onChange((current) => patchControlImage(current, kind, { strength }))}
                    />
                  </SourceRow>
                ) : (
                  <SlotHeader key={kind} title={controlKindLabel(kind)}>
                    <AddButton canvas={canvas} role="control" kind={kind} label={label} wiring={wiring} disabled={disabled} />
                  </SlotHeader>
                )
              })}
            </>
          )}
        </div>
      ) : null}

      {showReferences ? (
        <div className="flex flex-col gap-1.5" data-references-row>
          <SlotHeader title="参考图" hint={referenceLinks.length ? `${referenceLinks.length} / ${MAX_REFERENCES}` : '让结果参考这些图'}>
            {referenceLinks.length < MAX_REFERENCES ? (
              <AddButton canvas={canvas} role="reference" label="参考图" wiring={wiring} disabled={disabled} />
            ) : null}
          </SlotHeader>
          {referenceLinks.map((link, index) => (
            <SourceRow
              key={`${link.canvasId}-${link.output ?? 0}`}
              link={link}
              canvases={canvases}
              label={`参考图 ${index + 1}`}
              onRemove={() => onChange((current) => removeLink(current, 'reference', index))}
            />
          ))}
        </div>
      ) : null}

      {hasAdvanced ? (
        <Advanced summary="缩放方式、控制范围" className="-mx-3.5">
          <div className="flex flex-col gap-4 px-3.5 pb-2 pt-2">
            {inputs?.init && resizeValues.length ? (
              <section className="flex flex-col gap-2">
                <FieldLabel>起始图尺寸不同时</FieldLabel>
                <Segmented
                  block
                  label="起始图缩放方式"
                  value={inputs.init.resize ?? resizeValues[0]!}
                  onChange={(resize) => onChange((current) => patchInit(current, { resize: resize as 'crop' | 'fit' | 'stretch' }))}
                  options={resizeValues.map((value) => ({ value, label: enumLabel('resize', value) }))}
                />
              </section>
            ) : null}
            {inputs?.control?.adapterId ? (
              <section className="flex flex-col gap-2">
                <FieldLabel value={inputs.control.loraStrength === undefined ? '默认' : times(inputs.control.loraStrength)}>适配器强度</FieldLabel>
                <SliderField
                  label="适配器强度"
                  value={inputs.control.loraStrength ?? 1}
                  min={0}
                  max={2}
                  step={0.05}
                  format={times}
                  onChange={(loraStrength) => onChange((current) => patchControl(current, { loraStrength }))}
                />
                {inputs.control.loraStrength !== undefined ? (
                  <Button tone="ghost" size="sm" className="self-start" onClick={() => onChange((current) => patchControl(current, { loraStrength: undefined }))}>恢复默认</Button>
                ) : null}
              </section>
            ) : null}
            {(inputs?.control?.images ?? []).map((image) => (
              <section key={image.kind} className="flex flex-col gap-1.5">
                <FieldLabel value={`${pct(image.start)} – ${pct(image.end)}`}>{controlKindLabel(image.kind)}起止</FieldLabel>
                <SliderField label="开始" value={image.start} min={0} max={1} step={0.05} format={pct} onChange={(start) => onChange((current) => patchControlImage(current, image.kind, { start }))} />
                <SliderField label="结束" value={image.end} min={0} max={1} step={0.05} format={pct} onChange={(end) => onChange((current) => patchControlImage(current, image.kind, { end }))} />
              </section>
            ))}
            {referenceLinks.length ? (
              <section className="flex flex-col gap-2">
                <FieldLabel htmlFor="studio-reference-edge">参考图最长边</FieldLabel>
                <OptionalNumberInput
                  id="studio-reference-edge"
                  label="参考图最长边"
                  value={inputs?.references?.maxEdge}
                  parse={(value) => Number.isFinite(value) ? Math.min(2048, Math.max(16, Math.round(value))) : null}
                  onCommit={(maxEdge) => onChange((current) => patchReferences(current, { maxEdge }))}
                />
                <p className="text-caption text-ink-2">16 到 2048 像素；留空由引擎决定。</p>
              </section>
            ) : null}
          </div>
        </Advanced>
      ) : null}
    </section>
  )
}
