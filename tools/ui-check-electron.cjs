const { createRequire } = require('node:module')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const desktopRequire = createRequire(join(__dirname, '../apps/desktop/package.json'))
const { app, BrowserWindow } = desktopRequire('electron')
const output = process.argv[2]
const checkMotion = require('./ui-motion-checks.cjs')
const checkMaterials = require('./ui-material-checks.cjs')

app.setPath('userData', join(output, 'profile'))
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 960, height: 640, webPreferences: { backgroundThrottling: false } })
  const scale = Number(process.env.CLOVER_UI_SCALE ?? 1)
  const capture = async (name) => {
    const directory = process.env.CLOVER_UI_SCREENSHOTS
    if (!directory) return
    mkdirSync(directory, { recursive: true })
    // Hidden windows can defer animation frames; snapshots use the settled state.
    await win.webContents.executeJavaScript('document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).forEach(animation => animation.finish())')
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await new Promise((resolve) => setTimeout(resolve, 220))
    const image = await win.webContents.capturePage()
    writeFileSync(join(directory, `${name}-${scale}.png`), image.toPNG())
  }
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error(`Renderer: ${details.message}`)
  })
  const evaluate = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code)
    } catch (error) {
      throw new Error(`Renderer evaluation failed: ${code}`, { cause: error })
    }
  }
  const waitFor = async (code) => {
    const deadline = Date.now() + 5000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        const state = await evaluate('({ dialogs: Array.from(document.querySelectorAll("dialog")).map(dialog => ({ open: dialog.open, state: dialog.dataset.motionState })), focus: document.activeElement.id, animations: document.getAnimations().length })')
        throw new Error(`Timed out: ${code}; ${JSON.stringify(state)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  try {
    await win.loadFile(join(output, 'index.html'))
    win.webContents.setZoomFactor(scale)
    if (process.env.CLOVER_UI_OOBE_ONLY === '1') {
      await require('./ui-oobe-checks.cjs')({ evaluate, waitFor, capture, webContents: win.webContents, win, key })
      app.exit(0)
      return
    }
    if (process.env.CLOVER_UI_SSH_ONLY === '1') {
      await require('./ui-ssh-checks.cjs')({ evaluate, waitFor, capture })
      app.exit(0)
      return
    }
    if (process.env.CLOVER_UI_STUDIO_ONLY === '1') {
      await require('./ui-studio-checks.cjs')({ evaluate, waitFor })
      app.exit(0)
      return
    }
    await waitFor('Boolean(document.querySelector("#open-modal"))')
    await checkMaterials({ evaluate, waitFor, webContents: win.webContents })
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#typography")).fontSize'), '12px')
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#button-typography")).fontSize'), '13px')
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#button-typography")).fontWeight'), '500')
    assert.equal(await evaluate('document.querySelector(".app-input").labels[0].textContent'), 'Shared input')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".app-input")).height'), '34px')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".app-input")).fontSize'), '13px')
    assert.equal(await evaluate('parseFloat(getComputedStyle(document.querySelector(".app-input")).borderTopWidth) > 0'), true)
    assert.equal(await evaluate('document.getElementById(document.querySelector(".app-input").getAttribute("aria-describedby")).textContent'), 'Field hint')
    win.webContents.debugger.attach('1.3')
    for (const [preference, system, reduced] of [
      ['system', 'reduce', true], ['on', 'reduce', false],
      ['off', 'no-preference', true], ['system', 'no-preference', false],
    ]) {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: system }],
      })
      await evaluate(`document.documentElement.dataset.uiAnimation = ${JSON.stringify(preference)}`)
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".app-input")).transitionDuration.split(",").every(value => parseFloat(value) === 0)'), reduced)
      assert.equal(await evaluate('parseFloat(getComputedStyle(document.querySelector(".motion-probe")).animationDuration) === 0'), reduced)
    }
    await evaluate('document.querySelector("[role=switch]").click()')
    await waitFor('document.querySelector("[role=switch]").getAttribute("aria-checked") === "true"')
    await evaluate('document.querySelector("#open-modal").focus(); document.querySelector("#open-modal").click()')
    await waitFor('document.querySelectorAll("dialog[open]").length === 1')
    assert.equal(await evaluate('document.querySelector("dialog").parentElement === document.body'), true)
    assert.equal(await evaluate('Math.abs(document.querySelector("dialog").getBoundingClientRect().width - innerWidth) < 1'), true)
    assert.equal(await evaluate('document.querySelector("dialog").getAttribute("aria-labelledby") === document.querySelector("dialog h2").id'), true)
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".app-dialog-panel")).borderRadius'), '10px')
    await capture('modal')
    assert.equal(await evaluate('document.querySelector("dialog select").labels[0].textContent'), 'Shared select')
    assert.equal(await evaluate('getComputedStyle(document.querySelector("dialog select")).fontSize'), '13px')
    assert.equal(await evaluate('getComputedStyle(document.querySelector("dialog select")).appearance'), 'base-select')
    assert.equal(await evaluate('getComputedStyle(document.querySelector("dialog select")).height'), '34px')
    assert.equal(await evaluate('document.querySelector("dialog option[value=disabled]").disabled'), true)
    await evaluate('document.querySelector("dialog select").value = "b"; document.querySelector("dialog select").dispatchEvent(new Event("change", { bubbles: true }))')
    await waitFor('document.querySelector("#selected-value").textContent === "b"')
    await evaluate('document.querySelector("#outside").focus()')
    assert.equal(await evaluate('document.querySelector("dialog").contains(document.activeElement)'), true)
    for (const modifiers of [[], ['shift']]) {
      for (let i = 0; i < 6; i++) {
        await key('Tab', modifiers)
        assert.equal(await evaluate('document.querySelector("dialog").contains(document.activeElement)'), true)
      }
    }
    await evaluate('document.querySelector("#open-sheet").focus(); document.querySelector("#open-sheet").click()')
    await waitFor('document.querySelectorAll("dialog[open]").length === 2')
    await key('Escape')
    await waitFor('document.querySelectorAll("dialog[open]").length === 1')
    assert.equal(await evaluate('document.activeElement.id'), 'open-sheet')
    await key('Escape')
    await waitFor('!document.querySelector("dialog[open]")')
    assert.equal(await evaluate('document.activeElement.id'), 'open-modal')
    await evaluate('document.querySelector("#open-modal").click()')
    await waitFor('Boolean(document.querySelector("dialog[open]"))')
    await evaluate('document.querySelector("#inside").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); document.querySelector("dialog").click()')
    assert.equal(await evaluate('Boolean(document.querySelector("dialog[open]"))'), true)
    await evaluate('const dialog = document.querySelector("dialog"); dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); dialog.click()')
    await waitFor('!document.querySelector("dialog[open]")')
    await evaluate('document.querySelector("#view-settings").click()')
    const hfInput = `document.querySelector('input[placeholder="https://hf-mirror.com"]')`
    await waitFor(`Boolean(${hfInput})`)
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".glass")).borderRadius'), '8px')
    assert.equal(await evaluate('document.querySelectorAll("[role=status]").length'), 0)
    await evaluate('document.querySelector("#ui-animation").value = "off"; document.querySelector("#ui-animation").dispatchEvent(new Event("change", { bubbles: true }))')
    await evaluate(`const input = ${hfInput}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "https://draft.example.com"); input.dispatchEvent(new Event("input", { bubbles: true }))`)
    await waitFor('document.body.textContent.includes("有未保存的更改")')
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[role=status]")).borderRadius'), '8px')
    await capture('settings')
    await evaluate('document.querySelector("#toggle-sidebar").click()')
    await waitFor('JSON.parse(document.querySelector("#saved-settings").textContent).sidebarCollapsed')
    assert.equal(await evaluate(`${hfInput}.value`), 'https://draft.example.com')
    await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "恢复默认").click()')
    assert.equal(await evaluate(`${hfInput}.value`), 'https://draft.example.com')
    await evaluate('Array.from(document.querySelectorAll("header button")).find(button => button.textContent.trim() === "保存").click()')
    await waitFor('JSON.parse(document.querySelector("#saved-settings").textContent).hfEndpoint === "https://draft.example.com"')
    assert.equal(await evaluate('document.documentElement.dataset.uiAnimation'), 'off')
    await waitFor('!document.querySelector("[role=status]")')
    assert.equal(await evaluate('JSON.parse(document.querySelector("#saved-settings").textContent).sidebarCollapsed'), true)
    await capture('home')
    await checkMotion({ evaluate, waitFor, webContents: win.webContents, capture })
    await require('./ui-studio-checks.cjs')({ evaluate, waitFor })
    await require('./ui-ssh-checks.cjs')({ evaluate, waitFor, capture })
    await require('./ui-oobe-checks.cjs')({ evaluate, waitFor, capture, webContents: win.webContents, win, key })
    console.log(`UI checks passed at ${scale * 100}%: typography, shared controls, modal focus/top layer, nested Escape, backdrop gesture, settings draft/save, motion preferences, surface radii`)
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
