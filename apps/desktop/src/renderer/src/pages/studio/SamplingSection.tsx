import { useEffect, useState } from 'react'
import type { EngineFeatures, ProjectCanvas } from '@shared/types'
import { Segmented, Select, Switch } from '../../components/ui'
import { FieldLabel, OptionalNumberInput, SliderField } from './InputControls'
import { percent } from './links'
import {
  HIRES_STRENGTH_DEFAULT,
  clampHiresDimension,
  enumOptions,
  enumValues,
  hiresChoice,
  hiresSize,
  withHiresPatch,
  withHiresScale,
  withSampling,
  type HiresChoice,
} from './sampling'

type Change = (update: (canvas: ProjectCanvas) => ProjectCanvas) => void

/**
 * 采样器, 调度器, shift, 高清修复, 步缓存 and CFG 截断, inside the params panel's
 * 高级. Everything starts unset (默认 = the engine decides); choices come from
 * the engine's own lists.
 */
export function SamplingSection({ canvas, features, onChange }: { canvas: ProjectCanvas; features: EngineFeatures | null | undefined; onChange: Change }): React.JSX.Element {
  const sampling = canvas.sampling ?? {}
  const known = Boolean(features)
  const disabled = !known
  const showSamplers = !known || features!.samplers || Boolean(sampling.sampler || sampling.scheduler)
  const showHires = !known || features!.hires || Boolean(sampling.hires)
  const showStepCache = enumValues(features, 'step_cache').length > 0 || Boolean(sampling.stepCache)
  const choice = hiresChoice(canvas)
  const [custom, setCustom] = useState(false)
  useEffect(() => setCustom(false), [canvas.id])
  const shownChoice: HiresChoice = custom && choice !== 'off' ? 'custom' : choice

  return (
    <div className="flex flex-col gap-5" data-sampling-section>
      {features === null ? <p className="text-caption text-ink-2">没有可用的引擎，采样设置暂时不能改。</p> : null}

      {showSamplers ? (
        <>
          <section className="flex flex-col gap-2">
            <FieldLabel htmlFor="studio-sampler">采样器</FieldLabel>
            <Select
              id="studio-sampler"
              value={sampling.sampler ?? ''}
              disabled={disabled}
              options={enumOptions(features, 'sampler', sampling.sampler)}
              onValueChange={(value) => onChange((current) => withSampling(current, { sampler: value || undefined }))}
            />
          </section>
          <section className="flex flex-col gap-2">
            <FieldLabel htmlFor="studio-scheduler">调度器</FieldLabel>
            <Select
              id="studio-scheduler"
              value={sampling.scheduler ?? ''}
              disabled={disabled}
              options={enumOptions(features, 'scheduler', sampling.scheduler)}
              onValueChange={(value) => onChange((current) => withSampling(current, { scheduler: value || undefined }))}
            />
          </section>
        </>
      ) : null}

      <section className="flex flex-col gap-2">
        <FieldLabel htmlFor="studio-shift">Shift</FieldLabel>
        <OptionalNumberInput
          id="studio-shift"
          label="Shift"
          value={sampling.shift}
          parse={(value) => Number.isFinite(value) && value > 0 && value <= 100 ? Math.round(value * 100) / 100 : null}
          onCommit={(shift) => onChange((current) => withSampling(current, { shift }))}
        />
        <p className="text-caption text-ink-2">噪声时间表的偏移，留空用模型默认值。</p>
      </section>

      {showHires ? (
        <section className="flex flex-col gap-2.5" data-hires>
          <div className="flex items-center justify-between gap-2">
            <span className="flex flex-col">
              <span className="text-caption font-semibold text-ink-2">高清修复</span>
              <span className="text-caption text-ink-2">先出图，再放大补细节</span>
            </span>
            <Switch
              aria-label="高清修复"
              checked={Boolean(sampling.hires)}
              disabled={disabled}
              onCheckedChange={(on) => onChange((current) => on ? withHiresScale(current, 2) : withSampling(current, { hires: undefined }))}
            />
          </div>
          {sampling.hires ? (
            <>
              <Segmented<HiresChoice>
                block
                label="高清修复尺寸"
                value={shownChoice}
                onChange={(value) => {
                  if (value === 'custom') { setCustom(true); return }
                  setCustom(false)
                  if (value !== 'off') onChange((current) => withHiresScale(current, Number(value)))
                }}
                options={[
                  { value: '1.5', label: '×1.5', hint: sizeHint(canvas, 1.5) },
                  { value: '2', label: '×2', hint: sizeHint(canvas, 2) },
                  { value: 'custom', label: '自定义' },
                ]}
              />
              {shownChoice === 'custom' ? (
                <div className="flex items-center gap-2">
                  <OptionalNumberInput
                    label="高清修复宽度"
                    value={sampling.hires.width}
                    placeholder=""
                    parse={(value) => clampHiresDimension(value, sampling.hires!.width)}
                    onCommit={(width) => { if (width !== undefined) onChange((current) => withHiresPatch(current, { width })) }}
                    className="text-center"
                  />
                  <span aria-hidden="true" className="text-ink-2">×</span>
                  <OptionalNumberInput
                    label="高清修复高度"
                    value={sampling.hires.height}
                    placeholder=""
                    parse={(value) => clampHiresDimension(value, sampling.hires!.height)}
                    onCommit={(height) => { if (height !== undefined) onChange((current) => withHiresPatch(current, { height })) }}
                    className="text-center"
                  />
                </div>
              ) : (
                <p className="tabular text-caption text-ink-2">输出 {sampling.hires.width} × {sampling.hires.height}</p>
              )}
              <SliderField
                label="重绘幅度"
                value={sampling.hires.strength ?? HIRES_STRENGTH_DEFAULT}
                min={0}
                max={1}
                step={0.05}
                format={percent}
                onChange={(strength) => onChange((current) => withHiresPatch(current, { strength }))}
              />
              <div className="flex items-center gap-3 text-caption">
                <label htmlFor="studio-hires-steps" className="w-14 shrink-0 text-ink-2">步数</label>
                <OptionalNumberInput
                  id="studio-hires-steps"
                  label="高清修复步数"
                  value={sampling.hires.steps}
                  placeholder="默认（同主步数）"
                  parse={(value) => Number.isFinite(value) && value >= 1 ? Math.min(1000, Math.round(value)) : null}
                  onCommit={(steps) => onChange((current) => withHiresPatch(current, { steps }))}
                />
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {showStepCache ? (
        <section className="flex flex-col gap-2">
          <FieldLabel htmlFor="studio-step-cache">步缓存</FieldLabel>
          <Select
            id="studio-step-cache"
            value={sampling.stepCache ?? ''}
            disabled={disabled}
            options={enumOptions(features, 'step_cache', sampling.stepCache)}
            onValueChange={(value) => onChange((current) => withSampling(current, { stepCache: value || undefined }))}
          />
          <p className="text-caption text-ink-2">跳过变化很小的步骤，更快但可能损失细节。</p>
        </section>
      ) : null}

      {features?.cli && sampling.cfgTruncation === undefined ? null : <section className="flex flex-col gap-2">
        <FieldLabel htmlFor="studio-cfg-truncation">CFG 截断</FieldLabel>
        <OptionalNumberInput
          id="studio-cfg-truncation"
          label="CFG 截断"
          value={sampling.cfgTruncation}
          parse={(value) => Number.isFinite(value) && value >= 0 && value <= 1 ? Math.round(value * 100) / 100 : null}
          onCommit={(cfgTruncation) => onChange((current) => withSampling(current, { cfgTruncation }))}
        />
        <p className="text-caption text-ink-2">0 到 1：在这个进度之后不再用 CFG，更快。CFG 为 1 时没有作用。</p>
      </section>}
    </div>
  )
}

function sizeHint(canvas: ProjectCanvas, scale: number): string {
  const size = hiresSize(canvas, scale)
  return `${size.width} × ${size.height}`
}
