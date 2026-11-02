import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { Events, Ipc } from '@shared/channels'
import type { Catalog, InstanceInfo } from '@shared/types'
import { getSettings } from './services/settings'
import { getCatalog } from './services/models'
import { createAppWindow } from './windows'

export async function runModelManagementUi(): Promise<void> {
  const output =
    process.env['CLOVER_MODEL_TEST_OUTPUT'] ?? join(app.getPath('userData'), 'screenshots')
  await mkdir(output, { recursive: true })
  const catalog: Catalog = structuredClone(await getCatalog(getSettings(), true))
  for (const model of catalog.models)
    if (['qwen35-encoder', 'flux2-vae-small', 'moss-pipeline'].includes(model.id)) {
      model.installed = true
      model.installedBytes = model.sizeBytes
      model.installState = 'ready'
    }
  const instance: InstanceInfo = {
    id: 'model-ui-fixture',
    name: 'MOSS · 本地工作室',
    source: 'OpenMOSS/MOSS-Image',
    branch: 'main',
    commit: '1'.repeat(40),
    shortCommit: '1111111',
    commitDate: '',
    subject: 'Model component preview',
    author: '',
    channel: 'stable',
    runtimeId: 'fixture',
    runtimeMode: 'shared',
    runtimeState: 'ready',
    placement: { kind: 'local' },
    models: ['qwen35-encoder'],
    adapters: [],
    createdAt: '',
    lastUsedAt: null,
    path: app.getPath('userData'),
    dirty: false,
    status: 'ok',
    modelBinding: { bundleId: 'moss-sft', ...catalog.bundles[0]!.components },
  }
  const mock = (channel: string, data: unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => ({ ok: true, data }))
  }
  mock(Ipc.modelsCatalog, catalog)
  mock(Ipc.instancesList, [instance])
  mock(Ipc.envScan, null)
  mock(Ipc.updatesCheck, null)
  mock(Ipc.devicesList, [])
  mock(Ipc.casesList, [])
  mock(Ipc.launchQueueList, [])
  mock(Ipc.onboardingStatus, { ready: true, steps: [], checkedAt: '' })
  mock(Ipc.engineStatus, { state: 'missing', path: null, gpus: [] })
  mock(Ipc.runtimeState, null)
  mock(Ipc.gitCommits, [])
  const win = createAppWindow('studio', false)
  win.webContents.setBackgroundThrottling(false)
  await new Promise<void>((done) => win.webContents.once('did-finish-load', () => done()))
  const execute = (script: string): Promise<any> => win.webContents.executeJavaScript(script)
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300))
  await execute("location.hash = '#/models'")
  for (let i = 0; i < 100; i++) {
    if (await execute('Boolean(document.querySelector(\'select[aria-label="推荐模型组合"]\'))'))
      break
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.equal(
    await execute("[...document.querySelectorAll('button')].some(b => b.textContent.includes('导入本地模型'))"),
    true,
  )
  assert.equal(
    await execute("[...document.querySelectorAll('nav button')].some(b => b.textContent.trim() === '全部')"),
    true,
  )
  const checks: unknown[] = []
  async function capture(name: string): Promise<void> {
    await settle()
    const geometry = await execute(`(() => {
      const main = document.querySelector('main');
      const overflow = [...document.querySelectorAll('button,select,input')].filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return s.display !== 'none' && r.width > 0 && (r.left < -1 || r.right > innerWidth + 1) }).map(e => e.getAttribute('aria-label') || e.textContent);
      return { width: innerWidth, height: innerHeight, horizontalOverflow: main && main.scrollWidth > main.clientWidth + 1, overflow };
    })()`)
    assert.equal(geometry.horizontalOverflow, false, JSON.stringify(geometry))
    assert.deepEqual(geometry.overflow, [], JSON.stringify(geometry))
    checks.push({ name, ...geometry })
    // Hidden windows can return the previous compositor frame on the first capture.
    win.webContents.invalidate()
    await win.webContents.capturePage(undefined, { stayAwake: true })
    await settle()
    await writeFile(join(output, `${name}.png`), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
  }
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [1024, 720],
  ]) {
    win.setContentSize(width!, height!)
    await capture(`models-${width}`)
  }
  win.setContentSize(1280, 800)
  for (const zoom of [1.25, 1.5]) {
    win.webContents.setZoomFactor(zoom)
    await capture(`models-scale-${zoom}`)
  }
  win.webContents.setZoomFactor(1)
  await execute(
    "[...document.querySelectorAll('nav button')].find(b => b.textContent.includes('Qwen'))?.click()",
  )
  await capture('models-qwen')
  await execute('document.querySelector(\'button[aria-label^="删除 Qwen"]\')?.click()')
  await capture('models-delete-protected')
  await execute(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '取消')?.click()",
  )
  await execute("location.hash = '#/instances/model-ui-fixture'")
  await settle()
  for (let i = 0; i < 50; i++) {
    if (await execute("Boolean(document.querySelector('.model-binding-panel'))")) break
    await new Promise((r) => setTimeout(r, 50))
  }
  await execute("(() => { const panel = document.querySelector('.model-binding-panel'); const main = document.querySelector('main'); if (panel && main) main.scrollTop += panel.getBoundingClientRect().top - main.getBoundingClientRect().top - 20 })()")
  await capture('instance-model-binding')
  await execute("location.hash = '#/models'")
  for (const [i, state] of ['verifying', 'paused', 'error'].entries())
    win.webContents.send(Events.download, {
      id: `model:fixture-${i}`,
      targetId: ['moss-sft-dit', 'qwen35-encoder', 'flux2-vae-small'][i],
      kind: 'model',
      label: ['MOSS-Image SFT', 'Qwen3.5 · 文本编码器', 'FLUX.2 VAE · Small'][i],
      state,
      filesTotal: 4,
      filesDone: 2,
      bytes: 1_700_000_000,
      totalBytes: 10_160_000_000,
      speedBps: 0,
      currentFile: 'transformer/diffusion_pytorch_model-00002-of-00003.safetensors',
      error: state === 'error' ? '网络连接中断，可以继续下载。' : undefined,
      updatedAt: new Date().toISOString(),
    })
  await capture('models-download-states')
  await writeFile(join(output, 'layout-checks.json'), JSON.stringify(checks, null, 2))
  console.log(
    JSON.stringify({
      scenario: 'model-management-ui',
      passed: true,
      output,
      screenshots: checks.length,
    }),
  )
  win.destroy()
}
