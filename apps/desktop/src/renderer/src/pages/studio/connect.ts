import type { ControlAdapterEntry, EngineFeatures, ProjectCanvas } from '@shared/types'
import { controlKindLabel, linksOf, MAX_REFERENCES, wouldCycle, type LinkRole } from './links'
import { engineUnavailableReason, type Blocker } from './readiness'

/**
 * Connecting cards by dragging a wire: which cards offer a picture, which
 * drops are allowed, and what the role menu offers. Pure, no React.
 */

export type ConnectCheck = { ok: true } | { ok: false; reason: string }

/** Whether a wire from `sourceId` may end on `target`. */
export function canConnect(canvases: readonly ProjectCanvas[], sourceId: string, target: ProjectCanvas | undefined): ConnectCheck {
  if (!target) return { ok: false, reason: '' }
  if (target.id === sourceId) return { ok: false, reason: '不能连到自己' }
  if (target.kind !== 'layout') return { ok: false, reason: '只能连到可编辑的画面' }
  const source = canvases.find((canvas) => canvas.id === sourceId)
  if (!source) return { ok: false, reason: '' }
  if (source.kind === 'style' && target.upscale) return { ok: false, reason: '放大会照着原图重画，不用接风格' }
  if (wouldCycle(target, sourceId, canvases)) return { ok: false, reason: '这样会连成一个圈' }
  return { ok: true }
}

export type LinkMenuEntry =
  | { type: 'heading'; label: string }
  | { type: 'item'; role: LinkRole; kind?: string; label: string; disabled?: boolean; hint?: string; current?: boolean }
  | { type: 'note'; label: string }

/**
 * The role menu shown when a wire is dropped on a layout canvas. Only roles
 * the engine supports appear; control lists the kinds of the canvas's chosen
 * control adapter. `features` null means no engine is usable; `blockers` (the
 * readiness of the 生成 footer) then words why.
 */
export function linkMenu(
  target: ProjectCanvas,
  sourceId: string,
  features: EngineFeatures | null | undefined,
  adapters: readonly ControlAdapterEntry[],
  blockers: readonly Blocker[] = [],
): LinkMenuEntry[] {
  if (!features) return [{ type: 'note', label: engineUnavailableReason(features, blockers, '把图片接进来') ?? '' }]
  // A 放大 takes one picture: its 原图.
  if (target.upscale) {
    const current = target.inputs?.init?.link.canvasId === sourceId
    return [
      { type: 'item', role: 'init', label: '作为原图', current, hint: current ? '已连接' : target.inputs?.init ? '替换现有' : undefined },
    ]
  }
  const links = linksOf(target)
  const entries: LinkMenuEntry[] = []
  if (features.imageInput) {
    const current = target.inputs?.init?.link.canvasId === sourceId
    entries.push({
      type: 'item',
      role: 'init',
      label: '作为起始图',
      current,
      hint: current ? '已连接' : target.inputs?.init ? '替换现有' : undefined,
    })
  }
  if (features.control) {
    entries.push({ type: 'heading', label: '作为控制图' })
    const adapterId = target.inputs?.control?.adapterId
    const adapter = adapterId ? adapters.find((item) => item.id === adapterId) : undefined
    if (!adapter) {
      entries.push({ type: 'item', role: 'control', label: '先在右侧选择控制适配器', disabled: true })
    } else if (!adapter.controlKinds.length) {
      entries.push({ type: 'item', role: 'control', label: '这个控制适配器没有可用的类型', disabled: true })
    } else {
      for (const kind of adapter.controlKinds) {
        const linked = links.find((entry) => entry.role === 'control' && entry.kind === kind)
        const current = linked?.link.canvasId === sourceId
        entries.push({
          type: 'item',
          role: 'control',
          kind,
          label: controlKindLabel(kind),
          current,
          hint: current ? '已连接' : linked ? '替换现有' : undefined,
        })
      }
    }
  }
  if (features.references) {
    const references = links.filter((entry) => entry.role === 'reference')
    const current = references.some((entry) => entry.link.canvasId === sourceId)
    const full = references.length >= MAX_REFERENCES
    entries.push({
      type: 'item',
      role: 'reference',
      label: '作为参考图',
      current,
      disabled: current || full,
      hint: current ? '已连接' : full ? `最多 ${MAX_REFERENCES} 张` : undefined,
    })
  }
  if (!entries.length) return [{ type: 'note', label: '当前引擎不支持把图片接进来' }]
  return entries
}

/**
 * The menu of a wire dropped on the empty board: a new 画面 fed by the
 * picture, as its start picture or as a reference, or a 放大 of it
 * (`kind: 'upscale'`).
 */
export function newCanvasMenu(features: EngineFeatures | null | undefined, blockers: readonly Blocker[] = []): LinkMenuEntry[] {
  if (!features) return [{ type: 'note', label: engineUnavailableReason(features, blockers, '把图片接进来') ?? '' }]
  const entries: LinkMenuEntry[] = []
  if (features.imageInput) entries.push({ type: 'item', role: 'init', label: '新画面 · 起始图' })
  if (features.references) entries.push({ type: 'item', role: 'reference', label: '新画面 · 参考图' })
  if (features.imageInput) entries.push({ type: 'item', role: 'init', kind: 'upscale', label: '放大' })
  return entries.length ? entries : [{ type: 'note', label: '现在的引擎不能把图片接进新画面' }]
}
