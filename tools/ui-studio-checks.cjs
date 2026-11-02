const assert = require('node:assert/strict')

module.exports = async function checkStudio({ evaluate, waitFor, webContents }) {
  const generate = `Array.from(document.querySelectorAll('button')).find(element => element.textContent.includes('开始生成')).click()`
  await waitFor(`Boolean(document.querySelector('#view-studio'))`)
  await evaluate(`document.querySelector('#view-studio').click()`)
  // A fresh fixture starts with an empty board, so create the first Canvas before
  // the sampler panel (and the model select it contains) exists.
  await waitFor('Boolean(document.querySelector("[data-studio-board-empty]"))')
  await evaluate('document.querySelector("[data-studio-board-empty]").click()')
  await waitFor('Boolean(document.querySelector(\'select[aria-label="模型"]\'))')
  // A new Canvas starts empty; give it a prompt so the primary action is enabled.
  const promptField = 'document.querySelector(\'textarea[aria-label="提示词"]\')'
  await evaluate(`Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(${promptField}, 'Fixture prompt'); ${promptField}.dispatchEvent(new Event('input', { bubbles: true }))`)
  await evaluate('document.documentElement.dataset.uiAnimation = "off"')
  await evaluate('document.querySelector("#studio-tab-agent").click()')
  const agent = 'document.querySelector(\'#studio-tool-agent textarea[aria-label="Agent 消息"]\')'
  await evaluate(`Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(${agent}, '保留工具草稿'); ${agent}.dispatchEvent(new Event('input', { bubbles: true }))`)
  await evaluate('document.querySelector("#studio-tab-analysis").click()')
  assert.equal(await evaluate('document.querySelector("#studio-tool-analysis").hidden'), false)
  assert.equal(await evaluate('document.querySelector("#studio-tool-analysis").closest("aside").getAttribute("aria-label")'), '创作工具')
  await evaluate('Array.from(document.querySelectorAll("#studio-tool-analysis button")).find(button => button.textContent.includes("选择图片并解析")).click()')
  await waitFor('document.querySelector("dialog[open] h2")?.textContent === "GBC 图像解析"')
  await evaluate('document.querySelector("dialog[open] header button").click()')
  await waitFor('!document.querySelector("dialog[open]")')
  await evaluate('document.querySelector("#studio-tab-agent").click()')
  assert.equal(await evaluate(`${agent}.value`), '保留工具草稿')
  await evaluate('document.querySelector("button[aria-label=收起右栏]").click()')
  await waitFor('Boolean(document.querySelector("button[aria-label=展开右栏]"))')
  await evaluate('document.querySelector("button[aria-label=展开右栏]").click()')
  assert.equal(await evaluate(`${agent}.value`), '保留工具草稿')
  await evaluate('document.querySelector("#studio-tab-agent").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }))')
  assert.equal(await evaluate('document.activeElement.id'), 'studio-tab-layout')
  assert.equal(await evaluate('document.querySelector("#studio-tool-layout").hidden'), false)
  const divider = 'document.querySelector(\'[role=separator][aria-label="左侧设置宽度"]\')'
  const width = Number(await evaluate(`${divider}.getAttribute('aria-valuenow')`))
  await evaluate(`${divider}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))`)
  assert.equal(Number(await evaluate(`${divider}.getAttribute('aria-valuenow')`)), width + 10)
  await evaluate(`${divider}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))`)
  await evaluate('document.querySelector("button[aria-label=收起左栏]").click()')
  await waitFor('Boolean(document.querySelector("button[aria-label=展开左栏]"))')
  await evaluate('document.querySelector("button[aria-label=展开左栏]").click()')
  await require('./ui-studio-motion-checks.cjs')({ evaluate, waitFor, webContents })
  assert.equal(await evaluate(`${agent}.value`), '保留工具草稿')
  // LoRA: the picker writes into the Canvas, the row edits strength, and the
  // resolved selection rides along in the engine payload.
  const pickLoRA = async () => {
    await evaluate('document.querySelector("[data-adapter-picker]").click()')
    await waitFor('document.querySelector("dialog[open] h2")?.textContent === "选择 LoRA"')
    await evaluate('document.querySelector(\'[data-adapter-option="fixture-lora"]\').click()')
    await evaluate('document.querySelector("dialog[open] header button").click()')
    await waitFor('!document.querySelector("dialog[open]")')
    await waitFor('Boolean(document.querySelector(\'[data-adapter-row="fixture-lora"]\'))')
  }
  await pickLoRA()
  await evaluate('document.querySelector(\'[data-adapter-row="fixture-lora"] button[aria-label^="移除"]\').click()')
  await waitFor('!document.querySelector(\'[data-adapter-row="fixture-lora"]\')')
  await pickLoRA()
  await evaluate(`const slider = document.querySelector('[data-adapter-row="fixture-lora"] input[type=range]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '0.8');
    slider.dispatchEvent(new Event('input', { bubbles: true }))`)
  assert.equal(await evaluate('document.querySelector(\'[data-adapter-row="fixture-lora"] input[type=range]\').value'), '0.8')
  await waitFor('document.querySelector("[data-studio-generate]")?.disabled === false')
  await evaluate(`document.querySelector('#studio-job').textContent = ''; ${generate}`)
  await waitFor(`Boolean(document.querySelector('#studio-job').textContent)`)
  const payload = JSON.parse(await evaluate(`document.querySelector('#studio-job').textContent`))
  assert.equal(payload.modelBinding.bundleId, 'fixture-bundle')
  assert.equal(payload.deviceId, 'cuda:0')
  assert.equal(payload.prompt, 'Fixture prompt')
  assert.deepEqual(payload.adapters, [{ id: 'fixture-lora', strength: 0.8 }])
  console.log('Studio checks passed: unified workspace, side analysis, keyboard tabs/dividers, retained tool drafts, model/device selection, LoRA add/remove/strength and instance-free engine payload')
}
