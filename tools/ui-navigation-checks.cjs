const assert = require('node:assert/strict')

module.exports = async function checkNavigation({ evaluate, waitFor, capture, webContents, win, key }) {
  win.setContentSize(1280, 760)
  await waitFor('Boolean(document.querySelector("#page-navigation-trigger")) && Boolean(document.querySelector(".studio-workbench"))')
  await evaluate('document.documentElement.dataset.uiAnimation = "off"')
  const visibleStudio = 'document.querySelector(".studio-workbench").getClientRects().length > 0'
  const open = 'document.querySelector("#page-navigation-menu").matches(":popover-open")'
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const focusLabel = () => evaluate('document.activeElement.querySelector(".text-ui")?.textContent')
  const bounds = async () => {
    const result = await evaluate(`(() => {
      const rect = document.querySelector('#page-navigation-menu').getBoundingClientRect()
      const trigger = document.querySelector('#page-navigation-trigger').getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, triggerBottom: trigger.bottom }
    })()`)
    assert.ok(result.left >= 0 && result.right <= result.width && result.top >= result.triggerBottom && result.bottom <= result.height, JSON.stringify(result))
  }
  assert.equal(await evaluate('Boolean(document.querySelector(".app-shell > nav"))'), false)
  assert.equal(await evaluate('Math.abs(document.querySelector("main").getBoundingClientRect().bottom - innerHeight) < 1'), true)
  await evaluate('document.querySelector("#page-navigation-trigger").focus()')
  await key('Down')
  await waitFor(`${open} && document.activeElement.getAttribute('role') === 'menuitemradio'`)
  assert.equal(await focusLabel(), '创作')
  assert.equal(await evaluate('document.querySelectorAll("#page-navigation-menu [role=menuitemradio]").length'), 8)
  assert.equal(await evaluate('document.querySelectorAll("#page-navigation-menu [aria-checked=true]").length'), 1)
  await bounds()
  await capture('page-navigation')
  await key('Down')
  assert.equal(await focusLabel(), '引擎')
  await key('End')
  assert.equal(await focusLabel(), '设置')
  assert.equal(await evaluate(`(() => {
    const item = document.activeElement.getBoundingClientRect()
    const menu = document.querySelector('#page-navigation-menu').getBoundingClientRect()
    return item.top >= menu.top && item.bottom <= menu.bottom
  })()`), true, 'Keyboard focus must stay visible in a scrolling menu')
  await key('Enter')
  await waitFor(`!(${open}) && location.hash === '#/settings'`)
  assert.equal(await evaluate('document.querySelector("#page-navigation-trigger").textContent.trim()'), '设置')
  assert.equal(await evaluate('document.activeElement.id'), 'page-navigation-trigger')
  await click('#page-navigation-trigger')
  await waitFor(open)
  await key('Home')
  await key('Enter')
  await waitFor(`!(${open}) && ${visibleStudio}`)

  // The retained Studio keeps in-progress edits when switching pages.
  await evaluate(`(() => {
    const input = document.querySelector('textarea[placeholder="描述画面、文字、风格与布局。"]')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '切换后保留的提示词')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  for (const route of ['/engines', '/models', '/devices', '/training', '/gallery', '/diagnostics', '/settings', '/studio']) {
    await click('#page-navigation-trigger')
    await waitFor(open)
    await click(`#page-navigation-menu [data-route="${route}"]`)
    await waitFor(`location.hash === ${JSON.stringify(`#${route}`)} && !(${open})`)
    assert.equal(await evaluate('document.body.textContent.includes("界面出错了")'), false, route)
  }
  assert.equal(await evaluate('document.querySelector(\'textarea[placeholder="描述画面、文字、风格与布局。"]\').value'), '切换后保留的提示词')
  await click('#page-navigation-trigger')
  await waitFor(open)
  await key('Escape')
  await waitFor(`!(${open})`)
  assert.equal(await evaluate('document.activeElement.id'), 'page-navigation-trigger')

  if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3')
  await click('#page-navigation-trigger')
  await waitFor(open)
  const point = await evaluate('({ x: innerWidth - 4, y: innerHeight - 4 })')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await webContents.debugger.sendCommand('Input.dispatchMouseEvent', { ...point, type, button: 'left', clickCount: 1 })
  }
  await waitFor(`!(${open})`)
  await click('#page-navigation-trigger')
  await waitFor(open)
  await key('Tab')
  await waitFor(`!(${open})`)

  await click('button[aria-label=打开终端]')
  await waitFor('Boolean(document.querySelector("[data-terminal-drawer]"))')
  assert.equal(await evaluate('Math.abs(document.querySelector("[data-terminal-drawer]").getBoundingClientRect().bottom - innerHeight) < 1'), true)
  await click('button[aria-label=关闭终端]')
  await click('#page-navigation-trigger')
  await waitFor(open)
  await evaluate('document.documentElement.dataset.theme = "light"')
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#page-navigation-menu")).color'), 'rgb(28, 28, 28)')
  await bounds()
  await capture('page-navigation-light')
  await evaluate('document.documentElement.dataset.theme = "dark"')
  await key('Escape')
  console.log('Navigation checks passed: all eight routes, retained Studio draft, keyboard/focus, native light dismiss, viewport bounds, theme tokens and bottom-aligned terminal')
}
