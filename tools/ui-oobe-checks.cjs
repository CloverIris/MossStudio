const assert = require('node:assert/strict')

module.exports = async function checkOobe({ evaluate, waitFor, capture, webContents, key }) {
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const finish = () => evaluate('document.querySelector(".app-oobe-panel")?.getAnimations().forEach(animation => animation.finish())')
  const state = () => evaluate('JSON.parse(document.querySelector("#saved-settings").textContent).onboardingState')
  const ready = () => waitFor('document.querySelectorAll("[data-oobe-step]").length === 3 && document.querySelector(".app-oobe footer button:last-child").getAttribute("aria-busy") === "false"')
  const selectHost = async (id) => {
    await evaluate(`(() => { const select = document.querySelector('[aria-label="引导准备位置"]'); select.value = ${JSON.stringify(id)}; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await waitFor(`JSON.parse(document.querySelector('#saved-settings').textContent).onboardingHostId === ${JSON.stringify(id)}`)
    await ready()
  }
  const bounds = async () => {
    const result = await evaluate(`(() => {
      const panel = document.querySelector('.app-oobe-panel').getBoundingClientRect();
      const footer = document.querySelector('.app-oobe footer')?.getBoundingClientRect();
      return { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom, width: innerWidth, height: innerHeight, footerBottom: footer?.bottom };
    })()`)
    assert.ok(result.left >= -1 && result.right <= result.width + 1 && result.top >= -1 && result.bottom <= result.height + 1, JSON.stringify(result))
    if (result.footerBottom) assert.ok(result.footerBottom <= result.height + 1, JSON.stringify(result))
    assert.equal(await evaluate('parseFloat(getComputedStyle(document.querySelector(".app-oobe-panel")).borderTopWidth)'), 0, 'The guide must have no outer border in its opening or docked states')
    assert.equal(await evaluate('[...document.querySelectorAll(".app-oobe, .app-oobe-panel")].every(element => getComputedStyle(element).outlineStyle === "none")'), true, 'Dialog focus must not draw an outer frame')
    return result
  }

  await click('#view-oobe')
  await waitFor('document.querySelector(".app-oobe")?.dataset.screen === "welcome"')
  assert.equal(await evaluate('document.querySelector(".app-oobe").matches(":modal")'), true)
  assert.equal(await evaluate('document.querySelector(".app-oobe").textContent.includes("Python")'), false, 'The welcome screen must not guide Python installation')
  await finish()
  await bounds()
  await capture('oobe-welcome')
  await click('#oobe-fail-save')
  await click('.app-oobe footer button:last-child')
  await waitFor('document.body.textContent.includes("Fixture save failed")')
  assert.equal(await state(), 'pending')
  assert.equal(await evaluate('document.querySelector(".app-oobe").dataset.screen'), 'welcome')
  await click('.app-oobe footer button:last-child')
  await waitFor('document.querySelector(".app-oobe")?.dataset.screen === "overview"')
  await ready()
  await finish()
  assert.equal(await state(), 'active')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-oobe-step=python]"))'), false)
  assert.equal(await evaluate('document.querySelector(".app-oobe footer button:last-child").textContent'), '1/3')
  assert.equal(await evaluate('document.querySelector(".app-oobe footer button:last-child").disabled'), true, 'Completion must remain disabled until every requirement is ready')
  await click('.app-oobe footer button:last-child')
  assert.equal(await state(), 'active')
  assert.equal(await evaluate('document.querySelector(".app-oobe").dataset.screen'), 'overview')
  await bounds()
  await capture('oobe-overview')
  const before = await evaluate('document.querySelector(".app-oobe-panel").getBoundingClientRect().left')
  const shellTop = await evaluate('document.querySelector(".app-shell > header").getBoundingClientRect().top')
  await click('[data-oobe-step="model"] button')
  await waitFor('document.querySelector(".app-oobe")?.dataset.screen === "checklist"')
  // Read the intermediate frame before protocol/style checks can outlast the
  // docking animation's hidden-window cleanup timer.
  const midpoint = await evaluate(`(() => {
    const panel = document.querySelector('.app-oobe-panel');
    const animation = panel.getAnimations()[0];
    if (!animation) return null;
    animation.pause(); animation.currentTime = 180;
    return panel.getBoundingClientRect().left;
  })()`)
  assert.notEqual(midpoint, null, 'Docking must animate the existing panel')
  await finish()
  assert.equal(await evaluate('document.querySelector(".app-oobe").matches(":modal")'), false)
  assert.equal(await evaluate('document.querySelector(".app-oobe").getAttribute("aria-modal")'), 'false')
  assert.equal(await evaluate('parseFloat(getComputedStyle(document.querySelector(".app-oobe-panel")).borderTopWidth)'), 0, 'The docked checklist must not have an outer border')
  if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3')
  await webContents.debugger.sendCommand('DOM.enable')
  await webContents.debugger.sendCommand('CSS.enable')
  const { root } = await webContents.debugger.sendCommand('DOM.getDocument')
  for (const selector of ['.app-oobe', '.app-oobe-panel', '[data-oobe-toggle]']) {
    const { nodeId } = await webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })
    await webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] })
    assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).outlineStyle`), 'none', 'Opening or focusing the checklist must not draw a frame')
    await webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
  }
  await waitFor('document.querySelector("#oobe-route").textContent.includes("component=all")')
  assert.ok(await evaluate('document.querySelector("#oobe-route").textContent.startsWith("/models?")'))
  assert.equal(await evaluate(`document.querySelector('select[aria-label="推荐模型组合"]').value`), 'fixture-bundle')
  assert.ok(await evaluate('[...document.querySelectorAll("nav button")].some(button => button.textContent.trim() === "全部" && button.className.includes("border-accent-400"))'))
  const after = await bounds()
  assert.ok(midpoint > before && midpoint < after.left, `Expected intermediate position: ${before}, ${midpoint}, ${after.left}`)
  assert.ok(Math.abs(after.height - after.bottom - 48) < 1)
  assert.ok(Math.abs(after.width - after.right - 12) < 1)
  await ready()
  assert.equal(await evaluate('document.querySelector(".app-oobe footer button:last-child").textContent'), '1/3')
  assert.equal(await evaluate('document.querySelector(".app-oobe footer button:last-child").disabled'), true)
  await waitFor('document.querySelectorAll("[data-oobe-highlighted]").length === 2')
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  assert.ok(Math.abs(await evaluate('document.querySelector(".app-shell > header").getBoundingClientRect().top') - shellTop) < 1, 'Guidance scrolling must leave the app titlebar in place')
  assert.ok(await evaluate('document.querySelector(".oobe-spotlight-description").textContent.includes("补齐组件")'))
  assert.equal(await evaluate('document.querySelectorAll(".oobe-spotlight-hint").length'), 2, 'The bundle and component tabs must each have an explanation')
  assert.ok(await evaluate('[...document.querySelectorAll(".oobe-spotlight-description")].some(hint => hint.textContent.includes("MOSS 模型、Qwen 编码器、VAE"))'))
  assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-oobe-spotlight]")).pointerEvents'), 'none')
  assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-oobe-step=model] button")).boxShadow'), 'none', 'The preparation checklist must retain its normal button styling')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-oobe-hint-title="推荐组合"]')).outlineStyle`), 'solid')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('nav[aria-label="组件分类"]')).outlineStyle`), 'solid')
  assert.equal(await evaluate(`document.querySelector('select[aria-label="推荐模型组合"]').hasAttribute('data-oobe-highlighted')`), false, 'The recommended combination must have one group outline')
  assert.equal(await evaluate('document.querySelectorAll("button[data-oobe-highlighted]").length'), 0)
  assert.equal(await evaluate('document.querySelectorAll(".oobe-spotlight-ring").length'), 0, 'Highlight borders must belong to the real controls, not floating SVG rectangles')
  assert.equal(await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="推荐模型组合"]');
    const rect = select.getBoundingClientRect();
    return document.elementFromPoint(rect.left + 6, rect.top + rect.height / 2) === select;
  })()`), true, 'The spotlight must leave the real control clickable')
  const modelTop = await evaluate(`document.querySelector('[data-oobe-hint-title="推荐组合"]').getBoundingClientRect().top`)
  const scrollResult = await evaluate(`(() => {
    const group = document.querySelector('[data-oobe-hint-title="推荐组合"]');
    const anchor = document.querySelector('[data-oobe-hint-anchor]');
    const hint = document.querySelector('.oobe-spotlight-hint');
    const beforeAnchor = anchor.getBoundingClientRect().top;
    const beforeHint = hint.getBoundingClientRect().top;
    document.querySelector('#oobe-page-scroll').scrollTop -= 40;
    const style = getComputedStyle(group);
    return {
      outlined: group.hasAttribute('data-oobe-highlighted') && style.outlineStyle === 'solid' && style.boxShadow !== 'none',
      positionAnchor: getComputedStyle(hint).positionAnchor,
      anchorName: anchor.dataset.oobeHintAnchor,
      hintTop: beforeHint,
      anchorTop: beforeAnchor,
      anchorDelta: anchor.getBoundingClientRect().top - beforeAnchor,
    };
  })()`)
  assert.equal(scrollResult.outlined, true, 'The native outline must stay attached synchronously during scrolling')
  assert.equal(scrollResult.positionAnchor, scrollResult.anchorName)
  assert.ok(scrollResult.anchorDelta > 0)
  // Native anchor scroll adjustments are applied during the browser's paint
  // lifecycle rather than synchronously inside the JavaScript scroll setter.
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const followResult = await evaluate(`(() => {
    const hint = document.querySelector('.oobe-spotlight-hint');
    const anchor = document.querySelector('[data-oobe-hint-anchor]');
    return { hintDelta: hint.getBoundingClientRect().top - ${scrollResult.hintTop}, anchorDelta: anchor.getBoundingClientRect().top - ${scrollResult.anchorTop}, area: getComputedStyle(hint).positionArea };
  })()`)
  assert.ok(Math.abs(followResult.hintDelta - followResult.anchorDelta) < 1, `The hint must follow its anchor on the next paint: ${JSON.stringify(followResult)}`)
  await waitFor(`document.querySelector('[data-oobe-hint-title="推荐组合"]').getBoundingClientRect().top > ${modelTop}`)
  await waitFor(`(() => {
    const group = document.querySelector('[data-oobe-hint-title="推荐组合"]');
    const rect = group.getBoundingClientRect();
    const outline = parseFloat(getComputedStyle(group).outlineWidth);
    return [...document.querySelectorAll('.oobe-spotlight-mask mask rect[fill="black"]')].some(hole => Math.abs(Number(hole.getAttribute('y')) - (rect.top - outline)) < 1);
  })()`)
  await capture('oobe-checklist')
  await click('[data-oobe-hint-title="推荐组合"]')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-oobe-spotlight]"))'), true, 'Clicking group background must leave the explanations available')
  await evaluate(`(() => {
    const tabs = document.querySelector('nav[aria-label="组件分类"]');
    const page = document.querySelector('#oobe-page-scroll');
    page.scrollTop += tabs.getBoundingClientRect().top - page.getBoundingClientRect().top - 16;
  })()`)
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const tabsHint = await evaluate(`(() => {
    const tabs = document.querySelector('nav[aria-label="组件分类"]');
    const hint = [...document.querySelectorAll('.oobe-spotlight-hint')].find(item => getComputedStyle(item).positionAnchor === tabs.dataset.oobeHintAnchor);
    const rect = hint.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: innerWidth, height: innerHeight, text: hint.textContent };
  })()`)
  assert.ok(tabsHint.top >= 0 && tabsHint.bottom <= tabsHint.height && tabsHint.left >= 0 && tabsHint.right <= tabsHint.width, `The component tab explanation must be visible after scrolling: ${JSON.stringify(tabsHint)}`)
  assert.ok(tabsHint.text.includes('MOSS 模型、Qwen 编码器、VAE'))
  await capture('oobe-component-tabs')
  await click('nav[aria-label="组件分类"] button:nth-child(3)')
  await waitFor('!document.querySelector("[data-oobe-spotlight]")')
  assert.ok(await evaluate('document.querySelector(\'nav[aria-label="组件分类"] button:nth-child(3)\').className.includes("border-accent-400")'), 'The clicked tab must still activate')
  assert.equal(await evaluate('document.querySelector(".app-oobe").dataset.collapsed'), 'false')
  assert.equal(await evaluate('document.querySelectorAll("[data-oobe-highlighted], [data-oobe-hint-anchor]").length'), 0)
  await click('[data-oobe-step=model] button')
  await waitFor('document.querySelectorAll(".oobe-spotlight-hint").length === 2')
  await click('[data-oobe-hint-title="推荐组合"] button')
  await waitFor('!document.querySelector("[data-oobe-spotlight]")')
  await waitFor('document.body.textContent.includes("缺失组件已加入下载队列")')
  assert.equal(await evaluate('document.querySelector(".app-oobe").dataset.collapsed'), 'false', 'Starting a download must keep the checklist expanded')
  await click('[data-oobe-step=model] button')
  await waitFor('document.querySelectorAll(".oobe-spotlight-hint").length === 2')
  await click('#oobe-download')
  await waitFor('document.querySelector("[data-oobe-step=model]").dataset.status === "running"')
  assert.equal(await evaluate('document.querySelectorAll("[data-oobe-step=model]").length'), 1)
  const expanded = await bounds()
  await click('[data-oobe-toggle]')
  await waitFor('document.querySelector(".app-oobe").dataset.collapsed === "true"')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-oobe-spotlight]"))'), false)
  assert.equal(await evaluate('document.querySelectorAll("[data-oobe-highlighted]").length'), 0, 'Collapsing the guide must restore the controls')
  assert.equal(await evaluate('document.querySelectorAll("[data-oobe-hint-anchor]").length'), 0)
  const collapseMidpoint = await evaluate(`(() => {
    const panel = document.querySelector('.app-oobe-panel');
    const animation = panel.getAnimations().find(item => item.transitionProperty === 'max-height');
    if (!animation) return null;
    animation.pause(); animation.currentTime = 180;
    const rect = panel.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  })()`)
  assert.notEqual(collapseMidpoint, null, 'Collapsing must animate downward')
  await finish()
  await waitFor('document.querySelector(".app-oobe-panel").getBoundingClientRect().height <= 48')
  const collapsed = await evaluate('({ top: document.querySelector(".app-oobe-panel").getBoundingClientRect().top, bottom: document.querySelector(".app-oobe-panel").getBoundingClientRect().bottom })')
  assert.ok(collapseMidpoint.top > expanded.top && collapseMidpoint.top < collapsed.top)
  assert.ok(Math.abs(collapseMidpoint.bottom - expanded.bottom) < 1)
  assert.ok(Math.abs(collapsed.bottom - expanded.bottom) < 1)
  assert.equal(await evaluate('document.querySelector("#oobe-content").inert'), true)
  assert.equal(await evaluate(`document.querySelector('[aria-label="展开准备清单"]').getAttribute('aria-expanded')`), 'false')
  await capture('oobe-collapsed')
  await click('[data-oobe-toggle]')
  await waitFor('document.querySelector(".app-oobe").dataset.collapsed === "false"')
  await finish()
  assert.equal(await evaluate('document.querySelector("#oobe-content").inert'), false)
  await ready()
  await click('[aria-label="重新检查准备清单"]')
  await ready()
  assert.equal(await evaluate('document.querySelector(".app-oobe").dataset.collapsed'), 'false')
  await click('#remount-oobe')
  await waitFor('document.querySelector(".app-oobe")?.dataset.screen === "checklist"')
  await ready()
  await selectHost('fixture-remote')
  await click('#oobe-ready')
  await ready()
  assert.equal(await evaluate('document.querySelectorAll("[data-oobe-step][data-status=ok]").length'), 1)
  await click('[data-oobe-step=engine] button')
  await waitFor('document.querySelector("#oobe-route").textContent === "/engines?hostId=fixture-remote"')
  await selectHost('local')
  await waitFor('document.querySelectorAll("[data-oobe-step][data-status=ok]").length === 3')
  await ready()
  assert.equal(await evaluate('document.querySelector(".app-oobe footer button:last-child").textContent'), '完成')
  assert.equal(await evaluate('document.querySelector(".app-oobe footer button:last-child").disabled'), false)
  assert.equal(await evaluate('JSON.parse(document.querySelector("#saved-settings").textContent).pythonPath'), null, 'Completing setup must not require Python installation')
  await capture('oobe-complete')
  await click('.app-oobe footer button:last-child')
  await waitFor('!document.querySelector(".app-oobe")')
  assert.equal(await state(), 'completed')
  assert.equal(await evaluate('document.querySelectorAll("[data-oobe-highlighted]").length'), 0)
  assert.equal(await evaluate('Boolean(document.querySelector("[data-oobe-spotlight]"))'), false)
  await click('#remount-oobe')
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  assert.equal(await evaluate('Boolean(document.querySelector(".app-oobe"))'), false)

  // Both an explicit preference and the system's reduced-motion setting bypass FLIP.
  if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3')
  for (const [preference, reduced] of [['off', false], ['system', true]]) {
    await evaluate(`window.clover.invoke('settings:update', { uiAnimation: ${JSON.stringify(preference)} })`)
    await webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] })
    await evaluate(`document.documentElement.dataset.uiAnimation = ${JSON.stringify(preference)}`)
    await click('[aria-label="新手引导"]')
    await waitFor('document.querySelector(".app-oobe")?.dataset.screen === "overview"')
    await ready()
    await click('[aria-label="固定到右下角"]')
    await waitFor('document.querySelector(".app-oobe")?.dataset.screen === "checklist"')
    assert.equal(await evaluate('document.querySelector(".app-oobe-panel").getAnimations().length'), 0)
    await bounds()
    await click('[aria-label="收起准备清单"]')
    await waitFor('document.querySelector(".app-oobe-panel").getBoundingClientRect().height <= 48')
    assert.equal(await evaluate('document.querySelector(".app-oobe-panel").getAnimations().length'), 0)
    await click('[aria-label="展开准备清单"]')
    await ready()
    await click('.app-oobe footer div button:first-child')
    await waitFor('!document.querySelector(".app-oobe")')
    assert.equal(await state(), 'dismissed')
  }
  await click('#view-oobe')
  await waitFor('document.querySelector(".app-oobe")?.dataset.screen === "welcome"')
  await key('Escape')
  await waitFor('!document.querySelector(".app-oobe")')
  assert.equal(await state(), 'dismissed')
  await click('#remount-oobe')
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  assert.equal(await evaluate('Boolean(document.querySelector(".app-oobe"))'), false)

  // Exercise the actual engine/device pages and their native modal top layers.
  await click('#view-oobe')
  await waitFor('document.querySelector(".app-oobe")?.dataset.screen === "welcome"')
  await click('.app-oobe footer button:last-child')
  await ready()
  await click('[aria-label="固定到右下角"]')
  await waitFor('document.querySelector(".app-oobe")?.dataset.screen === "checklist"')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-oobe-spotlight]"))'), false, 'Viewing only the checklist must not add a mask or hint')
  await click('[aria-label="展开引导详情"]')
  await ready()
  await click('[data-oobe-step=engine] button')
  await waitFor('document.querySelector(".oobe-spotlight-description")?.textContent.includes("选择渠道和包类型")')
  await waitFor('document.querySelectorAll("[data-oobe-highlighted]").length === 1')
  assert.equal(await evaluate('document.querySelector("[data-oobe-highlighted]").tagName'), 'BUTTON')
  assert.ok(await evaluate('document.querySelector("[data-oobe-highlighted]").textContent.includes("下载/更新引擎")'))
  await capture('oobe-engine-highlight')
  await click('button[data-oobe=engine][data-oobe-hint]')
  await waitFor('Boolean(document.querySelector(".app-dialog[open]")) && !document.querySelector("[data-oobe-spotlight]")')
  assert.equal(await evaluate('document.querySelectorAll("[data-oobe-highlighted], [data-oobe-hint-anchor]").length'), 0, 'Activating the engine download must dismiss the overlay before the CUDA dialog')
  assert.equal(await evaluate('document.querySelector(".app-oobe").dataset.collapsed'), 'false')
  await capture('oobe-cuda-highlight')
  await click('.app-dialog[open] [aria-label="关闭"]')
  await waitFor('!document.querySelector(".app-dialog[open]")')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-oobe-spotlight]"))'), false, 'Closing the action dialog must not undo automatic dismissal')
  await click('#oobe-needs-device')
  await ready()
  assert.equal(await evaluate('document.querySelector(".app-oobe footer button:last-child").textContent'), '0/3')
  assert.equal(await evaluate('document.querySelector(".app-oobe footer button:last-child").disabled'), true)
  await click('[data-oobe-step=device] button')
  await waitFor('document.querySelector(".oobe-spotlight-description")?.textContent.includes("添加一台")')
  await click('button[data-oobe=device][data-oobe-hint]')
  await waitFor('Boolean(document.querySelector(".app-dialog[open]")) && !document.querySelector("[data-oobe-spotlight]")')
  assert.equal(await evaluate('document.querySelectorAll("[data-oobe-highlighted], .oobe-spotlight-hint").length'), 0, 'The SSH form must not receive guidance highlights or hints')
  await capture('oobe-ssh-highlight')
  await click('.app-dialog[open] [aria-label="关闭"]')
  await waitFor('!document.querySelector(".app-dialog[open]")')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-oobe-spotlight]"))'), false)
  await click('[data-oobe-step=device] button')
  await waitFor('document.querySelector("[data-oobe-spotlight]")?.parentElement === document.body')
  await click('[aria-label="暂时隐藏引导高亮"]')
  await waitFor('!document.querySelector("[data-oobe-spotlight]")')
  assert.equal(await evaluate('document.querySelector(".app-oobe").dataset.collapsed'), 'false', 'Closing the highlight must leave the checklist expanded')
  assert.equal(await evaluate('document.querySelector("#oobe-content").inert'), false)
  assert.equal(await evaluate('document.querySelectorAll("[data-oobe-highlighted]").length'), 0)
  await click('[data-oobe-toggle]')
  await finish()
  await click('[data-oobe-toggle]')
  await finish()
  await ready()
  assert.equal(await evaluate('Boolean(document.querySelector("[data-oobe-spotlight]"))'), false, 'Expanding the checklist must not undo a highlight dismissal')
  await click('[data-oobe-step=device] button')
  await waitFor('Boolean(document.querySelector("[data-oobe-spotlight]"))')
  await click('.app-oobe footer div button:first-child')
  await waitFor('!document.querySelector(".app-oobe") && !document.querySelector("[data-oobe-spotlight]")')
  console.log('OOBE checks passed: grouped models, docking/collapse, persistence, grouped model highlights with separate anchored hints, synchronous scroll following, automatic action dismissal, engine download-only highlighting, CUDA/SSH modal behavior, independent dismissal, cleanup')
}
