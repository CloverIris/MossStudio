// Visual-rule audit, injected into the E2E page (plain JS: it runs in the
// renderer, not in Node). `window.__audit(options)` returns a list of
// violations for the current DOM:
//
//   border     an element draws a visible border (or a 1px "ring" box-shadow)
//   hr         a visible <hr>
//   palette    a text/background colour is not one of the theme tokens
//   contrast   ink / ink-2 text below 4.5:1 against its effective background
//   overflow   the window scrolls sideways, or content sticks out of it
//
// Options: { allow: [{ selector, rules: ['border', ...], reason }] }: elements
// matching `selector` (or inside one) are exempt from those rules.
;(() => {
  const TOKENS = [
    'frame', 'board', 'panel', 'surface', 'raised', 'well', 'well-strong', 'well-hover',
    'ink', 'ink-2', 'ink-3', 'on-ink', 'accent', 'accent-soft', 'on-accent',
    'ok', 'warn', 'danger', 'ok-soft', 'warn-soft', 'danger-soft', 'scrim', 'image-placeholder', 'scrollbar',
  ]
  const TEXT_TOKENS = ['ink', 'ink-2', 'ink-3', 'on-ink', 'accent', 'on-accent', 'ok', 'warn', 'danger']
  const READABLE = ['ink', 'ink-2']
  const RING_OK = ['accent', 'ink', 'frame', 'board', 'panel', 'surface', 'raised']

  // ---- colour parsing -----------------------------------------------------
  const clamp = (value) => Math.max(0, Math.min(255, value))
  const toSrgb = (linear) => {
    const v = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
    return clamp(Math.round(v * 255))
  }
  function oklabToRgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b
    const s_ = L - 0.0894841775 * a - 1.291485548 * b
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
    return [
      toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ]
  }
  const num = (token, scale = 1) => token.endsWith('%') ? (parseFloat(token) / 100) * scale : parseFloat(token)
  /** [r, g, b, a] (0–255, 0–1) or null for anything it does not understand. */
  function parse(color) {
    if (!color || color === 'transparent') return [0, 0, 0, 0]
    const match = /^(rgba?|color|oklab|oklch)\((.*)\)$/.exec(color.trim())
    if (!match) return null
    const [, fn, body] = match
    const [main, alphaPart] = body.split('/')
    const parts = main.trim().split(/[\s,]+/)
    let alpha = alphaPart !== undefined ? num(alphaPart.trim()) : 1
    if (fn === 'rgb' || fn === 'rgba') {
      if (parts.length === 4) alpha = num(parts[3])
      return [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), alpha]
    }
    if (fn === 'color') {
      if (parts[0] !== 'srgb') return null
      return [clamp(Math.round(num(parts[1]) * 255)), clamp(Math.round(num(parts[2]) * 255)), clamp(Math.round(num(parts[3]) * 255)), alpha]
    }
    if (fn === 'oklab') return [...oklabToRgb(num(parts[0]), num(parts[1], 0.4), num(parts[2], 0.4)), alpha]
    if (fn === 'oklch') {
      const L = num(parts[0]), C = num(parts[1], 0.4), H = (parseFloat(parts[2]) * Math.PI) / 180
      return [...oklabToRgb(L, C * Math.cos(H), C * Math.sin(H)), alpha]
    }
    return null
  }
  const fmt = (c) => c ? `rgba(${c.map((v, i) => i === 3 ? +v.toFixed(3) : Math.round(v)).join(', ')})` : 'unparsed'

  function tokenValues() {
    const probe = document.createElement('div')
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const values = {}
    for (const name of TOKENS) {
      probe.style.color = `var(--${name})`
      values[name] = parse(getComputedStyle(probe).color)
    }
    probe.remove()
    return values
  }
  const sameRgb = (a, b, tolerance = 3) => Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance
  /** Name of the token this colour is (any alpha for opaque tokens; the token's own alpha for translucent ones). */
  function matchToken(color, tokens, names) {
    for (const name of names) {
      const token = tokens[name]
      if (!token || !sameRgb(color, token)) continue
      if (token[3] >= 0.999 || Math.abs(token[3] - color[3]) <= 0.02) return name
    }
    return null
  }

  // ---- geometry / visibility --------------------------------------------
  function visible(element) {
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none' || style.display === 'contents') return false
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false
    // Hidden ancestors (display:none parents give zero rects already); opacity 0 subtrees.
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      if (parseFloat(getComputedStyle(node).opacity) === 0) return false
    }
    return true
  }
  function ownText(element) {
    let text = ''
    for (const child of element.childNodes) if (child.nodeType === Node.TEXT_NODE) text += child.textContent
    return text.trim()
  }
  const describe = (element) => {
    const id = element.id ? `#${element.id}` : ''
    const cls = typeof element.className === 'string' ? element.className.trim().split(/\s+/).slice(0, 6).join('.') : ''
    const label = element.getAttribute('aria-label') || ownText(element).slice(0, 30)
    const page = element.closest('[data-page]')?.getAttribute('data-page') ?? ''
    return `${page ? `[${page}] ` : ''}<${element.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ''}>${label ? ` "${label}"` : ''}`
  }

  /** The colour behind an element: its own and its ancestors' backgrounds composited. */
  function effectiveBackground(element) {
    const layers = []
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.backgroundImage && style.backgroundImage !== 'none') return null
      if (node.tagName === 'IMG' || node.tagName === 'CANVAS' || node.tagName === 'VIDEO') return null
      const bg = parse(style.backgroundColor)
      if (!bg) return null
      if (bg[3] > 0) layers.push(bg)
      if (bg[3] >= 0.999) break
    }
    let out = [255, 255, 255]
    for (const layer of layers.reverse()) {
      const a = layer[3]
      out = out.map((v, i) => layer[i] * a + v * (1 - a))
    }
    return out
  }
  function luminance([r, g, b]) {
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  window.__audit = function audit(options = {}) {
    const allow = options.allow ?? []
    const exempt = (element, rule) => allow.some((entry) => entry.rules.includes(rule) && element.closest(entry.selector))
    const tokens = tokenValues()
    const violations = []
    const add = (rule, element, detail) => {
      if (!exempt(element, rule)) violations.push({ rule, element: describe(element), detail })
    }

    // The window itself must never scroll sideways.
    const docWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
    if (docWidth > innerWidth + 1) violations.push({ rule: 'overflow', element: '<html>', detail: `document is ${docWidth}px wide in a ${innerWidth}px window` })

    for (const element of document.body.querySelectorAll('*')) {
      if (element.closest('svg') && element.tagName.toLowerCase() !== 'svg') continue
      if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'BR', 'OPTION'].includes(element.tagName)) continue
      if (!visible(element)) continue
      const style = getComputedStyle(element)

      // (a) borders and ring-style shadows
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const width = parseFloat(style.getPropertyValue(`border-${side}-width`))
        const borderStyle = style.getPropertyValue(`border-${side}-style`)
        const color = parse(style.getPropertyValue(`border-${side}-color`))
        if (width > 0 && borderStyle !== 'none' && borderStyle !== 'hidden' && (!color || color[3] > 0.01)) {
          add('border', element, `border-${side}: ${width}px ${borderStyle} ${fmt(color)}`)
          break
        }
      }
      if (style.boxShadow && style.boxShadow !== 'none' && element !== document.activeElement) {
        // "0 0 0 1px color" (blur 0, spread > 0) is a ring drawn as a line.
        for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
          const lengths = shadow.replace(/(rgba?|color|oklab|oklch)\([^)]*\)/g, '').trim().split(/\s+/).filter((t) => /px$/.test(t)).map(parseFloat)
          const color = parse((/(rgba?|color|oklab|oklch)\([^)]*\)/.exec(shadow) ?? [])[0])
          // Selection rings (accent or ink) and their offset gap (a tone colour) are allowed.
          const named = color && matchToken(color, tokens, RING_OK)
          if (lengths.length >= 4 && lengths[2] === 0 && lengths[3] > 0 && (!color || color[3] > 0.01) && !named) {
            add('border', element, `ring box-shadow: ${shadow.trim()}`)
            break
          }
        }
      }
      if (element.tagName === 'HR') add('hr', element, 'visible <hr>')

      // (b) palette: backgrounds and text colours come from the tokens
      const bg = parse(style.backgroundColor)
      if (bg === null) add('palette', element, `unparsed background ${style.backgroundColor}`)
      else if (bg[3] > 0.01 && !matchToken(bg, tokens, TOKENS)) add('palette', element, `background ${fmt(bg)} is not a theme token`)

      const text = ownText(element)
      const isIcon = element.tagName.toLowerCase() === 'svg'
      if (!text && !isIcon) continue
      const color = parse(style.color)
      const name = color && matchToken(color, tokens, TEXT_TOKENS)
      if (!color) add('palette', element, `unparsed text colour ${style.color}`)
      else if (!name) add('palette', element, `text colour ${fmt(color)} is not a text token`)

      // (d) visible text pushed outside the window
      const rect = element.getBoundingClientRect()
      if (text && (rect.right > innerWidth + 1 || rect.left < -1)) add('overflow', element, `text box ${Math.round(rect.left)}–${Math.round(rect.right)} outside 0–${innerWidth}`)

      // (c) contrast of readable text
      if (!text || !name || !READABLE.includes(name)) continue
      if (element.closest('[disabled], [aria-disabled="true"]')) continue
      const background = effectiveBackground(element)
      if (!background) continue
      let opacity = 1
      for (let node = element; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity)
      const alpha = color[3] * opacity
      const ink = color.slice(0, 3).map((v, i) => v * alpha + background[i] * (1 - alpha))
      const ratio = contrast(ink, background)
      if (ratio < 4.5) add('contrast', element, `${name} ${fmt(color)}${opacity < 1 ? ` at opacity ${opacity.toFixed(2)}` : ''} on ${fmt([...background, 1])} = ${ratio.toFixed(2)}:1`)
    }
    return violations
  }

  /** Text that is cut off without an ellipsis (reported, not enforced). */
  window.__clippedText = function clippedText() {
    const out = []
    for (const element of document.body.querySelectorAll('*')) {
      if (!ownText(element) || !visible(element)) continue
      const style = getComputedStyle(element)
      if (element.clientWidth <= 1) continue // visually hidden (sr-only) text
      if (style.textOverflow === 'ellipsis' || !['hidden', 'clip'].includes(style.overflowX)) continue
      if (element.scrollWidth > element.clientWidth + 1) out.push(describe(element))
    }
    return out
  }
})()
