const assert = require('node:assert/strict')

module.exports = async function checkMotion({ evaluate, waitFor, webContents, capture }) {
  const finish = async (selector) => evaluate(`
    for (const element of document.querySelectorAll(${JSON.stringify(selector)})) {
      for (const animation of element.getAnimations()) {
        if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.finish()
      }
    }; void 0
  `)
  const click = async (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const preference = async (value, reduced = false) => {
    await webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }],
    })
    await evaluate(`document.documentElement.dataset.uiAnimation = ${JSON.stringify(value)}`)
    await waitFor(`document.querySelector('#motion-enabled').textContent === ${JSON.stringify(value === 'off' || (value === 'system' && reduced) ? 'off' : 'on')}`)
  }

  await preference('on')
  await click('#view-controls')
  await waitFor('Boolean(document.querySelector("#toggle-flyout"))')
  await finish('[data-testid=page-motion]')
  await click('#toggle-flyout')
  await waitFor('Boolean(document.querySelector("#flyout-demo"))')
  assert.equal(await evaluate('document.querySelector("#flyout-demo").getAnimations().length'), 1)
  await finish('#flyout-demo')
  await click('#toggle-flyout')
  await waitFor('document.querySelector("#flyout-demo")?.dataset.motionState === "closed"')
  assert.equal(await evaluate('document.querySelector("#flyout-demo").inert'), true)
  assert.equal(await evaluate('document.querySelector("#flyout-demo").textContent'), 'Original content')
  await click('#toggle-flyout')
  await waitFor('document.querySelector("#flyout-demo")?.dataset.motionState === "open"')
  await finish('#flyout-demo')
  await evaluate('new Promise(resolve => setTimeout(resolve, 280))')
  assert.equal(await evaluate('Boolean(document.querySelector("#flyout-demo"))'), true)
  assert.equal(await evaluate('document.querySelector("#exit-count").textContent'), '0')
  await click('#toggle-flyout')
  await waitFor('document.querySelector("#flyout-demo")?.dataset.motionState === "closed"')
  await evaluate('document.querySelector("#flyout-demo").getAnimations().forEach(animation => animation.pause())')
  await waitFor('!document.querySelector("#flyout-demo")')
  assert.equal(await evaluate('document.querySelector("#exit-count").textContent'), '1')

  assert.equal(await evaluate('document.querySelector("#collapse-demo").getBoundingClientRect().height'), 0)
  await click('#toggle-collapse')
  await waitFor('document.querySelector("#collapse-demo").getAnimations().length > 0')
  // Sample a paused frame atomically: separate renderer calls can let a short
  // transition finish before its height is read on a busy machine.
  const { height, expandedHeight } = await evaluate(`(() => {
    const element = document.querySelector('#collapse-demo')
    element.getAnimations().forEach(animation => {
      animation.pause()
      animation.currentTime = Number(animation.effect.getTiming().duration) / 2
    })
    return { height: element.getBoundingClientRect().height, expandedHeight: document.querySelector('#collapse-child').offsetHeight }
  })()`)
  assert.ok(height > 0 && height < expandedHeight, `Expected an intermediate collapse height, got ${height}/${expandedHeight}`)
  await finish('#collapse-demo')
  await click('#toggle-collapse')
  assert.equal(await evaluate('document.querySelector("#collapse-demo").inert'), true)
  await finish('#collapse-demo')
  await waitFor('document.querySelector("#collapse-demo").getBoundingClientRect().height === 0')

  await click('#toggle-notifications')
  await waitFor('Boolean(document.querySelector(".app-popover"))')
  await finish('.app-popover')
  await click('#toggle-notifications')
  await waitFor('document.querySelector(".app-popover")?.dataset.motionState === "closed"')
  assert.equal(await evaluate('document.querySelector(".app-popover").inert'), true)
  await finish('.app-popover')
  await waitFor('!document.querySelector(".app-popover")')

  await evaluate('document.querySelector("#open-modal").focus(); document.querySelector("#open-modal").click()')
  await waitFor('Boolean(document.querySelector("dialog[open]"))')
  await finish('.app-dialog-panel')
  await click('.app-dialog-panel header button')
  await waitFor('document.querySelector("dialog")?.dataset.motionState === "closed"')
  assert.equal(await evaluate('document.querySelector("dialog").open'), true)
  assert.equal(await evaluate('document.querySelector("dialog h2").textContent'), 'Modal')
  assert.equal(await evaluate('document.querySelector(".app-dialog-panel").inert'), true)
  await click('#open-modal')
  await waitFor('document.querySelector("dialog[open]")?.dataset.motionState === "open"')
  await finish('.app-dialog-panel')
  await evaluate('new Promise(resolve => setTimeout(resolve, 280))')
  assert.equal(await evaluate('Boolean(document.querySelector("dialog[open]"))'), true)
  await capture('motion-dialog')
  await click('.app-dialog-panel header button')
  await waitFor('document.querySelector("dialog")?.dataset.motionState === "closed"')
  await preference('off')
  await waitFor('!document.querySelector("dialog")')
  assert.equal(await evaluate('document.activeElement.id'), 'open-modal')

  await preference('system', true)
  await click('#toggle-flyout')
  await waitFor('Boolean(document.querySelector("#flyout-demo"))')
  assert.equal(await evaluate('document.querySelector("#flyout-demo").getAnimations().length'), 0)
  await click('#toggle-flyout')
  await waitFor('!document.querySelector("#flyout-demo")')
  await preference('on', true)
  await click('#toggle-flyout')
  await waitFor('Boolean(document.querySelector("#flyout-demo"))')
  assert.equal(await evaluate('document.querySelector("#flyout-demo").getAnimations().length'), 1)
  await click('#toggle-flyout')
  await waitFor('document.querySelector("#flyout-demo")?.dataset.motionState === "closed"')
  await preference('system', true)
  await waitFor('!document.querySelector("#flyout-demo")')

  await preference('on')
  for (let i = 0; i < 4; i++) {
    await click(i % 2 ? '#view-devices' : '#view-settings')
    const title = i % 2 ? '设备管理器' : '设置'
    await waitFor(`document.querySelector('h1')?.textContent === ${JSON.stringify(title)}`)
    assert.equal(await evaluate('document.querySelectorAll("[data-testid=page-motion]").length'), 1)
    assert.ok(await evaluate('document.querySelector("[data-testid=page-motion]").getAnimations().length <= 1'))
    assert.equal(await evaluate('document.querySelectorAll("h1").length'), 1)
  }
  await finish('[data-testid=page-motion]')
  await waitFor('document.querySelector("[data-testid=page-motion]").getAnimations().length === 0')
  assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-testid=page-motion]")).transform'), 'none')
  await click('#view-controls')
  await waitFor('Boolean(document.querySelector("#push-toast"))')
  await evaluate(`(() => {
    const timeout = window.setTimeout
    try {
      window.setTimeout = (callback, delay, ...args) => timeout(callback, delay === 5000 ? 40 : delay, ...args)
      document.querySelector('#push-toast').click()
    } finally { window.setTimeout = timeout }
  })()`)
  await waitFor('document.querySelector("[role=status]")?.dataset.motionState === "closed"')
  assert.equal(await evaluate('document.querySelector("[role=status]").inert'), true)
  await finish('[role=status]')
  await waitFor('!document.querySelector("[role=status]")')
  await preference('off')
  await evaluate('for (let i = 0; i < 6; i++) document.querySelector("#push-toast").click()')
  await waitFor('document.querySelectorAll("[role=status]").length === 3')
  await click('#view-devices')
  await waitFor('!document.querySelector("[role=status]")')
  console.log('Motion checks passed: interrupted/reversed exits, frozen content, hidden-window fallback, collapse interpolation, native modal retention, reduced motion, rapid page switching, toast expiry/bounds')
}
