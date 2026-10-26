import { useId, useLayoutEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ListChecks, X } from 'lucide-react'
import type { OnboardingStep } from '@shared/types'

interface Rect { x: number; y: number; width: number; height: number }
interface Target extends Rect { radius: number }
interface Hint { anchor: string; text: string; title: string; position?: string }
interface Layout {
  container: HTMLElement
  targets: Target[]
  hints: Hint[]
  width: number
  height: number
}

function visibleRect(element: HTMLElement): Target | null {
  if (element.matches(':disabled') || element.closest('[inert], [aria-hidden="true"]')) return null
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  if (!rect.width || !rect.height || style.visibility !== 'visible') return null
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top)
  let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom)
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    const clip = parent.getBoundingClientRect()
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
  }
  if (right - left < 4 || bottom - top < 4) return null
  // Match the native outline so the unmasked page does not form a second rim.
  const outline = parseFloat(style.outlineWidth) || 0
  return { x: left - outline, y: top - outline, width: right - left + outline * 2, height: bottom - top + outline * 2, radius: (parseFloat(style.borderTopLeftRadius) || 0) + outline }
}

function overlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
}

export function OobeSpotlight({ active, step, hostId, route, onActivate, onDismiss }: {
  active: boolean
  step: OnboardingStep | undefined
  hostId: string
  route: string
  onActivate: () => void
  onDismiss: () => void
}): React.JSX.Element | null {
  const maskId = `oobe-mask-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [layout, setLayout] = useState<Layout | null>(null)

  useLayoutEffect(() => {
    if (!active) return
    function activate(event: MouseEvent): void {
      const control = event.target instanceof Element ? event.target.closest('button, a[href], [role="button"], [role="tab"]') : null
      if (control?.closest('[data-oobe-highlighted="true"]') && !control.matches(':disabled, [aria-disabled="true"]')) onActivate()
    }
    document.addEventListener('click', activate, true)
    return () => document.removeEventListener('click', activate, true)
  }, [active, onActivate])

  useLayoutEffect(() => {
    if (!active || !step) return
    let frame = 0
    let scrolled = false
    let watched: HTMLElement[] = []
    let highlighted = new Set<HTMLElement>()
    let anchored = new Set<HTMLElement>()
    function highlight(elements: HTMLElement[]): void {
      const next = new Set(elements)
      highlighted.forEach((element) => { if (!next.has(element)) element.removeAttribute('data-oobe-highlighted') })
      next.forEach((element) => { if (!highlighted.has(element)) element.setAttribute('data-oobe-highlighted', 'true') })
      highlighted = next
    }
    function anchors(sources: HTMLElement[]): Hint[] {
      const elements = sources.map((element) => element.querySelector<HTMLElement>('[data-oobe-hint-target]') ?? element)
      const next = new Set(elements)
      anchored.forEach((element) => {
        if (next.has(element)) return
        element.removeAttribute('data-oobe-hint-anchor')
        element.style.removeProperty('--oobe-hint-anchor')
      })
      anchored = next
      return elements.map((element, index) => {
        const source = sources[index]
        const name = `--${maskId}-hint-${index}`
        if (element.dataset.oobeHintAnchor !== name) {
          element.setAttribute('data-oobe-hint-anchor', name)
          element.style.setProperty('--oobe-hint-anchor', name)
        }
        return { anchor: name, text: source.dataset.oobeHint || `按高亮位置完成${step?.title}配置，准备清单会自动更新。`, title: source.dataset.oobeHintTitle || `准备${step?.title}`, position: source.dataset.oobeHintPosition }
      })
    }
    const resize = new ResizeObserver(() => schedule())
    function measure(): void {
      frame = 0
      const modal = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter((element) => element.matches(':modal')).at(-1)
      if (route === '/devices' && modal) {
        highlight([])
        anchors([])
        setLayout(null)
        resize.disconnect()
        watched = []
        return
      }
      const container = modal ?? document.body
      const elements = step ? [...container.querySelectorAll<HTMLElement>(`[data-oobe="${step.id}"]`)].filter((element) => {
        const owner = element.closest<HTMLElement>('[data-oobe-host]')?.dataset.oobeHost
        const rect = element.getBoundingClientRect()
        return (!owner || owner === 'any' || owner === hostId) && !element.matches(':disabled')
          && !element.closest('[inert], [aria-hidden="true"]') && rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility === 'visible'
      }) : []
      const primary = elements.find((element) => element.dataset.oobeHint)
      // Style the real controls so their outlines move with layout, scrolling
      // and transforms without waiting for React to position a separate ring.
      highlight(elements)
      const hintElements = elements.filter((element) => element.dataset.oobeHint)
      const hints = anchors(hintElements.length ? hintElements : elements.slice(0, 1))
      if (!scrolled && primary) {
        const rect = primary.getBoundingClientRect()
        const panel = document.querySelector('.app-oobe-panel')?.getBoundingClientRect()
        if (rect.top < 52 || rect.bottom > innerHeight - 48 || panel && overlap(
          { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          { x: panel.left, y: panel.top, width: panel.width, height: panel.height },
        )) {
          scrolled = true
          for (let parent = primary.parentElement; parent; parent = parent.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
              parent.scrollTop += rect.top - parent.getBoundingClientRect().top - 16
              break
            }
          }
        }
      }
      const targets = elements.flatMap((element) => {
        const rect = visibleRect(element)
        return rect ? [rect] : []
      })
      const next: Layout = { container, targets, hints, width: innerWidth, height: innerHeight }
      setLayout((previous) => previous?.container === next.container && JSON.stringify({ ...previous, container: null }) === JSON.stringify({ ...next, container: null }) ? previous : next)
      const observing = elements
      if (observing.length !== watched.length || observing.some((element, index) => element !== watched[index])) {
        resize.disconnect()
        observing.forEach((element) => resize.observe(element))
        watched = observing
      }
      if (document.getAnimations().some((animation) => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))) schedule()
    }
    function schedule(): void { if (!frame) frame = requestAnimationFrame(measure) }
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'disabled', 'inert', 'data-oobe', 'data-oobe-host'] })
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
      highlight([])
      anchors([])
    }
  }, [active, step?.id, hostId, route, maskId])

  if (!active || !step || !layout?.hints.length) return null
  return createPortal(
    <div className="oobe-spotlight" data-oobe-spotlight>
      <svg className="oobe-spotlight-mask" width={layout.width} height={layout.height} aria-hidden="true">
        <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={layout.width} height={layout.height}>
          <rect width="100%" height="100%" fill="white" />
          {layout.targets.map((target, index) => <rect key={index} x={target.x} y={target.y} width={target.width} height={target.height} rx={target.radius} fill="black" />)}
        </mask></defs>
        <rect width="100%" height="100%" fill="rgba(0, 0, 0, 0.35)" mask={`url(#${maskId})`} />
      </svg>
      {layout.hints.map((hint) => <aside key={hint.anchor} role="note" aria-label="配置引导提示" className="oobe-spotlight-hint" data-position={hint.position} style={{ '--oobe-hint-anchor': hint.anchor } as CSSProperties}>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="oobe-spotlight-heading flex items-center gap-1.5 text-ui font-semibold text-accent-300"><ListChecks className="size-4" />{hint.title}</div>
          <p className="oobe-spotlight-description text-ui leading-5 text-[var(--color-text-secondary)]">{hint.text}</p>
        </div>
        <button type="button" aria-label="暂时隐藏引导高亮" title="隐藏高亮和提示，保留准备清单" className="app-icon-button inline-flex size-5 shrink-0 items-center justify-center rounded text-[var(--color-text-tertiary)] hover:bg-white/10" onClick={onDismiss}><X className="size-4" /></button>
      </aside>)}
    </div>, layout.container,
  )
}
