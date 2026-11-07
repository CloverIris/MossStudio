import type { ControlAdapterEntry, EngineFeatures, ProjectCanvas } from '@shared/types'
import { controlKindLabel, linksOf, MAX_REFERENCES, type CanvasLinkEntry, type LinkRole } from './links'
import { engineUnavailableReason, type Blocker } from './readiness'

/**
 * The input slots a layout canvas shows on its left edge: one per linked
 * picture, plus an empty slot for every role that can still take one. Empty
 * slots are how people find out what a card accepts without opening a panel.
 * Pure, no React.
 */

export interface InputSlot {
  /** Stable within a canvas: `init`, `control:<kind>`, `control`, `reference:<n>`, `reference`. */
  key: string
  role: LinkRole
  /** Control kind of this slot (control slots of a chosen adapter). */
  kind?: string
  /** Chip text: the link's label when linked, the role's name when empty. */
  label: string
  /** What filling it does, for the empty slot's tooltip. */
  hint: string
  linked: boolean
  /**
   * For an empty slot: what must happen before a picture can go in, or null
   * when it can take one now. `adapter` = choose a control adapter for this
   * canvas, `adapter-missing` = no control adapter is installed at all.
   */
  needs: null | 'adapter' | 'adapter-missing' | 'engine'
  /** Why it cannot take a picture now (shown on hover and when a drop is refused). */
  reason?: string
}

export const ROLE_HINTS: Record<LinkRole, string> = {
  init: '从这张图开始改',
  control: '按这张图的深度或颜色构图',
  reference: '让结果参考这张图',
}

/** The slot a link entry is drawn into. */
export function linkSlotKey(entry: Pick<CanvasLinkEntry, 'role' | 'kind' | 'index'>): string {
  if (entry.role === 'control') return `control:${entry.kind ?? ''}`
  if (entry.role === 'reference') return `reference:${entry.index ?? 0}`
  return 'init'
}

/**
 * Slots of a layout canvas, in port order (start picture, control, references).
 * A role the engine cannot do shows only the links it already has, so they can
 * still be seen and removed. `features` undefined means still reading (every
 * role is offered); null means no engine is usable (empty slots say why).
 */
export function inputSlots(
  canvas: ProjectCanvas,
  features: EngineFeatures | null | undefined,
  adapters: readonly ControlAdapterEntry[],
  blockers: readonly Blocker[] = [],
): InputSlot[] {
  if (canvas.kind !== 'layout') return []
  const links = linksOf(canvas)
  const offers = (flag: 'imageInput' | 'control' | 'references'): boolean => features === undefined || features === null || features[flag]
  const engineReason = features === null ? (engineUnavailableReason(features, blockers, '把图片接进来') ?? undefined) : undefined
  const empty = (slot: Omit<InputSlot, 'linked' | 'needs' | 'hint'> & Partial<Pick<InputSlot, 'needs' | 'reason'>>): InputSlot => ({
    hint: ROLE_HINTS[slot.role],
    linked: false,
    ...slot,
    needs: slot.needs ?? (engineReason ? 'engine' : null),
    reason: slot.reason ?? engineReason,
  })
  const linked = (entry: CanvasLinkEntry): InputSlot => ({
    key: linkSlotKey(entry),
    role: entry.role,
    kind: entry.kind,
    label: entry.label,
    hint: ROLE_HINTS[entry.role],
    linked: true,
    needs: null,
  })
  const slots: InputSlot[] = []

  const init = links.find((entry) => entry.role === 'init')
  if (init) slots.push(linked(init))
  else if (offers('imageInput')) slots.push(empty({ key: 'init', role: 'init', label: '起始图' }))

  const controlLinks = links.filter((entry) => entry.role === 'control')
  if (offers('control') || controlLinks.length) {
    const adapterId = canvas.inputs?.control?.adapterId
    const adapter = adapterId ? adapters.find((item) => item.id === adapterId) : undefined
    const kinds = adapter ? adapter.controlKinds : []
    for (const kind of kinds) {
      const entry = controlLinks.find((item) => item.kind === kind)
      if (entry) slots.push(linked(entry))
      else if (offers('control'))
        slots.push(empty({ key: `control:${kind}`, role: 'control', kind, label: `控制 · ${controlKindLabel(kind)}` }))
    }
    // Links of kinds the chosen adapter does not list (or with no adapter) stay visible.
    for (const entry of controlLinks) if (!kinds.includes(entry.kind ?? '')) slots.push(linked(entry))
    if (!adapter && offers('control')) {
      const base = { key: 'control', role: 'control', label: '控制' } as const
      slots.push(
        empty(
          engineReason
            ? base
            : adapters.length
              ? { ...base, needs: 'adapter', reason: '先选择一个控制适配器' }
              : { ...base, needs: 'adapter-missing', reason: '需要先添加控制适配器' },
        ),
      )
    }
  }

  const references = links.filter((entry) => entry.role === 'reference')
  for (const entry of references) slots.push(linked(entry))
  if (offers('references') && references.length < MAX_REFERENCES)
    slots.push(empty({ key: 'reference', role: 'reference', label: '参考图' }))

  return slots
}

/** What dropping a wire on a slot does: link into it, or why not. */
export type SlotDrop = { ok: true; role: LinkRole; kind?: string } | { ok: false; reason: string }

export function slotDrop(slot: InputSlot, canvas: ProjectCanvas, sourceId: string): SlotDrop {
  if (slot.needs) return { ok: false, reason: slot.reason ?? '现在还不能接图片' }
  if (slot.role === 'reference') {
    const links = canvas.inputs?.references?.links ?? []
    if (links.some((link) => link.canvasId === sourceId)) return { ok: false, reason: '已经是这个画面的参考图' }
    if (links.length >= MAX_REFERENCES) return { ok: false, reason: `参考图最多 ${MAX_REFERENCES} 张` }
    return { ok: true, role: 'reference' }
  }
  if (slot.role === 'control') {
    if (!slot.kind) return { ok: false, reason: slot.reason ?? '先选择一个控制适配器' }
    return { ok: true, role: 'control', kind: slot.kind }
  }
  return { ok: true, role: 'init' }
}
