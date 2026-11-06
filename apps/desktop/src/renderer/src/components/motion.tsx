import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react'

type MotionPreset = 'page' | 'fade' | 'flyout' | 'dialog' | 'sheet' | 'toast'

const closedTransforms: Record<Exclude<MotionPreset, 'fade'>, string> = {
  page: 'translateY(8px)',
  flyout: 'translateY(-4px) scale(0.985)',
  dialog: 'translateY(8px) scale(0.985)',
  sheet: 'translateX(12px)',
  toast: 'translateY(6px)',
}

type MotionSnapshot = Map<Element, Keyframe>

function fadeTargets(element: HTMLElement): Element[] {
  // Keep ancestors of our shared glass surfaces at opacity 1: a translucent
  // ancestor is a backdrop root and cuts off the image the card needs to blur.
  // Fade each surface itself and the largest remaining content groups instead.
  const branches = new Set<Element>()
  for (const surface of element.querySelectorAll('.glass, .glass-thin, .glass-strong, .content-surface')) {
    for (let parent = surface.parentElement; parent && !branches.has(parent); parent = parent.parentElement) {
      branches.add(parent)
      if (parent === element) break
    }
  }
  const targets: Element[] = []
  const pending: Element[] = [element]
  while (pending.length) {
    const current = pending.pop()!
    if (branches.has(current)) {
      for (const child of current.children) pending.push(child)
    } else targets.push(current)
  }
  return targets
}

const listeners = new Set<() => void>()
let stopWatching: (() => void) | undefined

function animationEnabled(): boolean {
  if (typeof window === 'undefined') return false
  const preference = document.documentElement.dataset.uiAnimation
  return preference === 'on' || (preference !== 'off' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!stopWatching) {
    const notify = (): void => listeners.forEach((callback) => callback())
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const observer = new MutationObserver(notify)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-animation'] })
    media.addEventListener('change', notify)
    stopWatching = () => {
      observer.disconnect()
      media.removeEventListener('change', notify)
    }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopWatching?.()
      stopWatching = undefined
    }
  }
}

export function useUiAnimationEnabled(): boolean {
  return useSyncExternalStore(subscribe, animationEnabled, () => false)
}

function playMotion(
  element: HTMLElement,
  preset: MotionPreset,
  entering: boolean,
  interrupted: { current: MotionSnapshot | undefined },
  onFinished?: () => void,
): () => void {
  const style = getComputedStyle(element)
  const durationValue = style.getPropertyValue('--motion-normal').trim()
  const parsedDuration = Number.parseFloat(durationValue)
  const duration = Number.isFinite(parsedDuration) ? parsedDuration * (durationValue.endsWith('ms') ? 1 : 1000) : 180
  const ease = style.getPropertyValue('--motion-ease').trim() || 'ease-out'
  const targets = fadeTargets(element)
  const plans = new Map<Element, { closed: Keyframe; visible: Keyframe }>()
  if (preset !== 'fade') {
    plans.set(element, { closed: { transform: closedTransforms[preset] }, visible: { transform: 'none' } })
  }
  for (const target of targets) {
    const plan = plans.get(target) ?? { closed: {}, visible: {} }
    plan.closed.opacity = 0
    plan.visible.opacity = 1
    plans.set(target, plan)
  }
  const animations = Array.from(plans, ([target, { closed, visible }]) => {
    const sampled = interrupted.current?.get(target)
    const from: Keyframe = {}
    for (const property of ['opacity', 'transform'] as const) {
      if (closed[property] !== undefined) from[property] = sampled?.[property] ?? (entering ? closed[property] : visible[property])
    }
    return { target, closed, animation: target.animate([from, entering ? visible : closed], { duration, easing: ease, fill: 'both' }) }
  })
  interrupted.current = undefined
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    window.clearTimeout(timer)
    for (const { animation } of animations) {
      if (entering) animation.cancel()
      else animation.finish()
    }
    onFinished?.()
  }
  // Hidden windows may stop advancing their animation timeline. Never let that
  // hold a modal in the top layer or retain a dismissed surface indefinitely.
  const timer = window.setTimeout(finish, duration + 60)
  void Promise.all(animations.map(({ animation }) => animation.finished)).then(finish, () => undefined)
  return () => {
    if (!finished) {
      finished = true
      interrupted.current = new Map(
        animations.map(({ target, closed }) => {
          const current = getComputedStyle(target)
          const frame: Keyframe = {}
          if (closed.opacity !== undefined) frame.opacity = current.opacity
          if (closed.transform !== undefined) frame.transform = current.transform
          return [target, frame]
        }),
      )
    }
    window.clearTimeout(timer)
    for (const { animation } of animations) animation.cancel()
  }
}

export function useMotionPresence(open: boolean, preset: MotionPreset, onExited?: () => void) {
  const enabled = useUiAnimationEnabled()
  const [retained, setRetained] = useState(open)
  // Mount an opened layer immediately; only a completed exit releases it.
  if (open && !retained) setRetained(true)
  const ref = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const interrupted = useRef<MotionSnapshot | undefined>(undefined)
  const exited = useRef(onExited)
  exited.current = onExited

  useLayoutEffect(() => {
    const element = ref.current
    const opening = open && !wasOpen.current
    wasOpen.current = open
    if (!element) return
    const finishExit = (): void => {
      setRetained(false)
      exited.current?.()
    }
    if (!enabled) {
      interrupted.current = undefined
      if (!open) finishExit()
      return
    }
    if (open && !opening && !interrupted.current) return
    return playMotion(element, preset, open, interrupted, open ? undefined : finishExit)
  }, [open, preset, enabled])

  return { present: open || retained, ref }
}

export function Presence({
  open,
  preset = 'fade',
  onExited,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'ref'> & {
  open: boolean
  preset?: MotionPreset
  onExited?: () => void
}): React.JSX.Element | null {
  const { present, ref } = useMotionPresence(open, preset, onExited)
  const content = useRef(children)
  if (open) content.current = children
  if (!present) return null
  return (
    <div {...props} ref={ref} data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined}>
      {content.current}
    </div>
  )
}

export function MotionPanel({
  transitionKey,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'ref'> & { transitionKey: string | number }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const enabled = useUiAnimationEnabled()
  const previous = useRef<string | number | undefined>(undefined)
  const interrupted = useRef<MotionSnapshot | undefined>(undefined)
  useLayoutEffect(() => {
    const changed = previous.current !== transitionKey
    previous.current = transitionKey
    if (!enabled || changed) interrupted.current = undefined
    if (!enabled || (!changed && !interrupted.current) || !ref.current) return
    return playMotion(ref.current, 'page', true, interrupted)
  }, [transitionKey, enabled])
  // Only the current page is mounted: no overlapping forms, duplicated effects,
  // delayed navigation or stale outgoing page that can still receive input.
  return (
    <div {...props} ref={ref}>
      {children}
    </div>
  )
}

export function Collapse({
  open,
  children,
  className = '',
  ...props
}: Omit<ComponentProps<'div'>, 'ref'> & { open: boolean }): React.JSX.Element {
  return (
    <div {...props} className={`app-collapse ${className}`} data-open={open} aria-hidden={!open} inert={!open}>
      <div className="app-collapse-inner">{children}</div>
    </div>
  )
}
