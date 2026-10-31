import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { Ipc } from '@shared/channels'
import { createAppWindow } from './windows'
import { getProject, listProjects } from './services/projects'

export async function runStudioCanvasUiTests(): Promise<void> {
  const mock = (channel: string, data: unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => ({ ok: true, data }))
  }
  mock(Ipc.envScan, null)
  mock(Ipc.updatesCheck, null)
  mock(Ipc.modelsCatalog, { models: [], adapters: [], bundles: [] })
  mock(Ipc.downloadsList, [])
  mock(Ipc.jobList, [])
  mock(Ipc.diagnosticsList, [])
  mock(Ipc.devicesList, [])
  mock(Ipc.onboardingStatus, { ready: true, steps: [], checkedAt: '' })
  mock(Ipc.launchQueueList, [])
  mock(Ipc.mossInferDownloadState, null)
  mock(Ipc.hostsList, [])

  const win = createAppWindow('studio', false)
  win.webContents.setBackgroundThrottling(false)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Studio window load timed out')), 15_000)
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  const evaluate = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script)
  const waitFor = async (script: string): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!(await evaluate(script))) {
      if (Date.now() >= deadline) throw new Error(`Studio UI timed out waiting for: ${script}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  try {
    await waitFor("Boolean(document.querySelector('.studio-workbench'))")
    assert.equal(await evaluate("document.body.innerText.includes('创建第一个可编辑 Canvas')"), true)
    assert.equal(await evaluate("document.body.innerText.includes('请点击选择一个 Canvas')"), true)

    await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.includes('新建内容'))?.click()")
    await waitFor("Boolean(document.querySelector('article[aria-label^=\"Canvas 1\"]'))")
    await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '新建内容')?.click()")
    await waitFor("Boolean(document.querySelector('article[aria-label^=\"Canvas 2\"]'))")

    await evaluate("document.querySelector('article[aria-label^=\"Canvas 1\"]')?.click()")
    const setPrompt = (value: string): Promise<unknown> => evaluate(`(() => {
      const input = document.querySelector('textarea[placeholder="描述画面、文字、风格与布局。"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    assert.equal(await setPrompt('first canvas prompt'), true)
    await evaluate("document.querySelector('article[aria-label^=\"Canvas 2\"]')?.click()")
    assert.equal(await setPrompt('second canvas prompt'), true)

    await new Promise((resolve) => setTimeout(resolve, 2200))
    const projectId = listProjects()[0]?.id
    assert.ok(projectId, 'Canvas autosave should create a Project')
    let project = getProject(projectId!)
    assert.equal(project?.canvases.length, 2)
    assert.equal(project?.canvases.find((canvas) => canvas.title === 'Canvas 1')?.prompt, 'first canvas prompt')
    assert.equal(project?.canvases.find((canvas) => canvas.title === 'Canvas 2')?.prompt, 'second canvas prompt')
    assert.equal(project?.selectedCanvasId, project?.canvases.find((canvas) => canvas.title === 'Canvas 2')?.id)

    await new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve())
      void win.webContents.reload()
    })
    await waitFor("[...document.querySelectorAll('button')].some((button) => button.textContent.includes('未命名 Project'))")
    await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.includes('未命名 Project'))?.click()")
    await waitFor("Boolean(document.querySelector('article[aria-label^=\"Canvas 1\"]'))")
    await waitFor("document.querySelector('textarea[placeholder=\"描述画面、文字、风格与布局。\"]')?.value === 'second canvas prompt'")
    project = getProject(projectId!)
    assert.equal(project?.canvases.length, 2)

    writeFileSync(join(app.getPath('userData'), 'studio-canvas-ui-result.json'), JSON.stringify({
      scenario: 'studio-canvas-ui',
      ok: true,
      projectId,
      canvases: project?.canvases.length,
      selectedCanvasId: project?.selectedCanvasId,
    }))
    setTimeout(() => app.exit(0), 50)
  } catch (error) {
    console.error(error)
    writeFileSync(join(app.getPath('userData'), 'studio-canvas-ui-result.json'), JSON.stringify({
      scenario: 'studio-canvas-ui',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    setTimeout(() => app.exit(1), 50)
  } finally {
    win.destroy()
  }
}
