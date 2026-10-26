const assert = require('node:assert/strict')

module.exports = async function checkStudioMotion({ evaluate, waitFor, webContents }) {
  const sidebar = (side) => `.studio-sidebar[data-side="${side}"]`
  const finish = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).getAnimations({ subtree: true }).forEach(animation => animation.finish())`)
  const width = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width`)
  for (const [side, name] of [['left', '左栏'], ['right', '右栏']]) {
    const selector = sidebar(side)
    await evaluate(`document.documentElement.dataset.uiAnimation = 'on'; document.querySelector(${JSON.stringify(selector)}).style.setProperty('--motion-normal', '2000ms')`)
    const expanded = await width(selector)
    const click = (label) => evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector('button[aria-label="${label}"]').click()`)
    await click(`收起${name}`)
    await waitFor(`document.querySelector(${JSON.stringify(selector)}).dataset.collapsed === 'true'`)
    const midpoint = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      const animations = element.getAnimations({ subtree: true })
      animations.forEach(animation => { animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) / 3 })
      return {
        width: element.getBoundingClientRect().width,
        contentWidth: element.querySelector('.studio-sidebar-content').getBoundingClientRect().width,
        sliding: animations.some(animation => animation.transitionProperty === '--studio-sidebar-open'),
        inert: element.querySelector('.studio-sidebar-content').inert,
      }
    })()`)
    assert.equal(midpoint.sliding, true)
    assert.ok(midpoint.width > 34 && midpoint.width < expanded - 1, `${side}: expected intermediate width, got ${midpoint.width}/${expanded}`)
    assert.ok(Math.abs(midpoint.contentWidth - (expanded - 1)) < 1, 'Content must not reflow during collapse')
    assert.equal(midpoint.inert, true)

    await click(`展开${name}`)
    await waitFor(`document.querySelector(${JSON.stringify(selector)}).dataset.collapsed === 'false'`)
    const reversed = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      element.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 0 })
      return element.getBoundingClientRect().width
    })()`)
    assert.ok(Math.abs(reversed - midpoint.width) < 2, `${side}: reversal jumped from ${midpoint.width} to ${reversed}`)
    await finish(selector)
    assert.ok(Math.abs(await width(selector) - expanded) < 1)

    // Ordinary divider resizing must stay immediate while UI animation is on.
    const resizing = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      const divider = element.querySelector('[role=separator]')
      divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      return element.getAnimations().length
    })()`)
    assert.equal(resizing, 0)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector('[role=separator]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))`)

    await click(`收起${name}`)
    await waitFor(`document.querySelector(${JSON.stringify(selector)}).dataset.collapsed === 'true'`)
    await finish(selector)
    assert.ok(Math.abs(await width(selector) - 33) < 1)
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), `展开${name}`)
    await click(`展开${name}`)
    await evaluate('document.documentElement.dataset.uiAnimation = "off"')
    await waitFor(`document.querySelector(${JSON.stringify(selector)}).getAnimations({ subtree: true }).length === 0`)
    assert.ok(Math.abs(await width(selector) - expanded) < 1)
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), `收起${name}`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).style.removeProperty('--motion-normal')`)
  }

  if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3')
  try {
    await webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await evaluate('document.documentElement.dataset.uiAnimation = "system"; document.querySelector("button[aria-label=收起左栏]").click()')
    await waitFor('document.querySelector(".studio-sidebar[data-side=left]").dataset.collapsed === "true"')
    assert.equal(await evaluate('document.querySelector(".studio-sidebar[data-side=left]").getAnimations({ subtree: true }).length'), 0)
    assert.ok(Math.abs(await width(sidebar('left')) - 33) < 1)
    await evaluate('document.querySelector("button[aria-label=展开左栏]").click()')
    await waitFor('document.querySelector(".studio-sidebar[data-side=left]").dataset.collapsed === "false"')
  } finally {
    await evaluate('document.documentElement.dataset.uiAnimation = "off"')
    await webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  }
  console.log('Studio motion checks passed: interpolated widths, stable content, reversal, instant resizing, focus handoff and reduced-motion preferences')
}
