import type { ControlAdapterEntry, EngineFeatures, JobControlImage, JobParams, ProjectCanvas } from '@shared/types'
import { CLI_ENGINE_LABEL, cliSamplingAccepted } from '@shared/cliEngine'
import { ACTIVE_JOB_STATES } from './jobStatus'
import { controlKindLabel, linkSourceCanvas, canvasPicture, MAX_REFERENCES } from './links'
import type { Blocker } from './readiness'
import { cleanSampling, enumLabel, generationSize, outputSize } from './sampling'

/**
 * A canvas's pictures and sampling choices, resolved into what the engine
 * receives: every link becomes the source's picture path, the control adapter
 * id becomes its file. Anything that cannot be resolved is a blocker with a
 * reason; an input is never silently dropped. Pure, no React.
 */

export type JobInputParams = Pick<JobParams, 'initImage' | 'mask' | 'control' | 'references' | 'sampling'>

export interface JobInputContext {
  canvases: readonly ProjectCanvas[]
  /** What the target engine can do; undefined while reading, null when none is usable (not checked then). */
  features: EngineFeatures | null | undefined
  controlAdapters: readonly ControlAdapterEntry[]
  /** False until the adapter list has loaded; until then a control image waits instead of being reported missing. */
  controlAdaptersLoaded?: boolean
}

export interface ResolvedJobInputs {
  params: JobInputParams
  /** First-pass size (JobParams.width/height). */
  size: { width: number; height: number }
  /** Size of the finished picture (the hires target when 高清修复 is on). */
  output: { width: number; height: number }
  blockers: Blocker[]
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))

type SourceCheck = { path: string } | { reason: string }

function sourcePicture(canvases: readonly ProjectCanvas[], link: { canvasId: string; output?: number }, what: string): SourceCheck {
  const source = linkSourceCanvas(link, canvases)
  if (!source) return { reason: `${what}找不到了，请重新选择` }
  const path = canvasPicture(source, link.output)
  if (path) return { path }
  if (ACTIVE_JOB_STATES.has(source.jobState ?? '')) return { reason: `${what}「${source.title}」还在生成，完成后再试` }
  return { reason: `${what}「${source.title}」还没生成` }
}

export function resolveJobInputs(
  canvas: Pick<ProjectCanvas, 'width' | 'height' | 'inputs' | 'sampling' | 'baseSize'>,
  context: JobInputContext,
): ResolvedJobInputs {
  const blockers: Blocker[] = []
  const params: JobInputParams = {}
  const features = context.features ?? null
  const inputs = canvas.inputs
  const unsupported = (what: string): void => {
    const message = features?.cli
      ? `${CLI_ENGINE_LABEL[features.cli]}引擎只能文生图，不支持${what}，请移除后再生成`
      : `这台设备上的引擎不支持${what}，请移除后再生成`
    blockers.push({ id: 'input-unsupported', message })
  }
  const source = (link: { canvasId: string; output?: number }, what: string): string | null => {
    const check = sourcePicture(context.canvases, link, what)
    if ('reason' in check) {
      blockers.push({ id: 'input-source', message: check.reason })
      return null
    }
    return check.path
  }

  if (inputs?.init) {
    if (features && !features.imageInput) unsupported('起始图')
    const path = source(inputs.init.link, '起始图')
    if (path) {
      params.initImage = {
        path,
        strength: clamp(inputs.init.strength, 0, 1),
        ...(inputs.init.resize ? { resize: inputs.init.resize } : {}),
      }
    }
  }
  if (inputs?.mask) {
    if (!inputs.init) blockers.push({ id: 'input-invalid', message: '遮罩需要先设置起始图' })
    else params.mask = { path: inputs.mask.path }
  }

  const control = inputs?.control
  if (control && control.images.length) {
    if (features && !features.control) unsupported('控制图')
    const adapter = context.controlAdapters.find((item) => item.id === control.adapterId)
    if (!control.adapterId) {
      blockers.push({ id: 'input-adapter', message: '请选择控制适配器' })
    } else if (!adapter && context.controlAdaptersLoaded === false) {
      blockers.push({ id: 'input-adapter', message: '正在读取控制适配器…' })
    } else if (!adapter) {
      blockers.push({ id: 'input-adapter', message: '控制适配器找不到了，请重新添加或换一个', action: { label: '去添加', to: '/models' } })
    }
    const seen = new Set<string>()
    const images: JobControlImage[] = []
    for (const image of control.images) {
      const label = controlKindLabel(image.kind)
      if (seen.has(image.kind)) {
        blockers.push({ id: 'input-invalid', message: `「${label}」控制图只能接一张` })
        continue
      }
      seen.add(image.kind)
      if (adapter && adapter.controlKinds.length && !adapter.controlKinds.includes(image.kind)) {
        blockers.push({ id: 'input-invalid', message: `「${adapter.name}」不支持${label}控制，请移除这张控制图` })
      }
      const path = source(image.link, `控制图 · ${label}`)
      if (!path) continue
      const start = clamp(image.start, 0, 1)
      images.push({ kind: image.kind, path, strength: clamp(image.strength, 0, 10), start, end: clamp(image.end, start, 1) })
    }
    if (adapter) {
      params.control = {
        adapter: adapter.path,
        ...(control.loraStrength !== undefined ? { loraStrength: control.loraStrength } : {}),
        images,
      }
    }
  }

  const references = inputs?.references
  if (references && references.links.length) {
    if (features && !features.references) unsupported('参考图')
    if (references.links.length > MAX_REFERENCES)
      blockers.push({ id: 'input-invalid', message: `参考图最多 ${MAX_REFERENCES} 张，请移除多出来的` })
    const paths = references.links.flatMap((link, index) => {
      const path = source(link, `参考图 ${index + 1}`)
      return path ? [path] : []
    })
    params.references = { paths, ...(references.maxEdge !== undefined ? { maxEdge: references.maxEdge } : {}) }
  }

  const sampling = cleanSampling(canvas.sampling)
  if (sampling) {
    params.sampling = sampling
    if (features) {
      const samplerChange = features.cli ? !cliSamplingAccepted(sampling) : Boolean(sampling.sampler || sampling.scheduler)
      if (!features.samplers && samplerChange) unsupported('更换采样器')
      if (!features.hires && sampling.hires) unsupported('高清修复')
      const check = (param: 'sampler' | 'scheduler' | 'step_cache', value: string | undefined, what: string): void => {
        const allowed = features.values?.[param]
        // An empty list means the engine did not say; only a real list rules a name out.
        if (value && allowed?.length && !allowed.includes(value)) {
          blockers.push({ id: 'input-unsupported', message: `${what}「${enumLabel(param, value)}」这个引擎不支持，请改回默认` })
        }
      }
      if (features.samplers) {
        check('sampler', sampling.sampler, '采样器')
        check('scheduler', sampling.scheduler, '调度器')
      }
      check('step_cache', sampling.stepCache, '步缓存')
      // A CLI engine takes steps, CFG and shift, nothing else of the sampling.
      if (features.cli) {
        if (sampling.stepCache && sampling.stepCache !== 'off') unsupported('步缓存')
        if (sampling.cfgTruncation !== undefined) unsupported('CFG 截断')
      }
    }
  }

  return { params, size: generationSize(canvas), output: outputSize(canvas), blockers }
}
