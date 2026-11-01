import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { Events, Ipc } from '@shared/channels'
import type { JobRecord } from '@shared/types'
import { createAppWindow } from './windows'
import { getProject, listProjects, saveProject } from './services/projects'

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
  mock(Ipc.engineStatus, { state: 'missing', path: null, gpus: [] })
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

    const sourceCanvas = project?.canvases.find((canvas) => canvas.title === 'Canvas 1')
    assert.ok(sourceCanvas, 'source Canvas should exist before testing generation controls')
    const activeJobId = 'e2e-canvas-generation'
    project = saveProject({
      id: projectId!,
      name: project!.name,
      canvases: project!.canvases.map((canvas) => canvas.id === sourceCanvas!.id
        ? { ...canvas, jobId: activeJobId, jobState: 'starting' }
        : canvas),
      selectedCanvasId: sourceCanvas!.id,
    })
    await new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve())
      void win.webContents.reload()
    })
    await waitFor("[...document.querySelectorAll('button')].some((button) => button.textContent.includes('未命名 Project'))")
    await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.includes('未命名 Project'))?.click()")
    await waitFor("document.querySelector('article[aria-label^=\"Canvas 1\"]')")
    const generateDisabled = (): Promise<unknown> => evaluate("document.querySelector('[data-studio-generate]')?.disabled")
    assert.equal(await generateDisabled(), true, 'generation action should be disabled while the Canvas job is active')

    const job = (
      state: JobRecord['state'],
      jobId = activeJobId,
      canvasId = sourceCanvas!.id,
    ): JobRecord => ({
      id: jobId,
      instanceId: 'engine',
      instanceName: 'E2E MossInfer',
      projectId: projectId!,
      canvasId,
      kind: 'inference',
      mode: 'runner',
      engine: 'mossinfer',
      state,
      stage: 'denoise',
      params: {
        prompt: 'canvas button state test',
        negativePrompt: '',
        width: 512,
        height: 512,
        steps: 4,
        cfg: 3,
        seed: 1,
        profile: 'dmd8',
      },
      progress: { stage: 'denoise', current: 1, total: 4, percent: 25 },
      startedAt: new Date().toISOString(),
    })
    const sendJob = (
      state: JobRecord['state'],
      jobId = activeJobId,
      canvasId = sourceCanvas!.id,
    ): void => {
      win.webContents.send(Events.job, job(state, jobId, canvasId))
    }

    sendJob('failed')
    await waitFor("document.querySelector('[data-studio-generate]')?.disabled === false")
    assert.equal(await generateDisabled(), false, 'generation action should be restored after failure')

    sendJob('running')
    await waitFor("document.querySelector('[data-studio-generate]')?.disabled === true")
    sendJob('canceled')
    await waitFor("document.querySelector('[data-studio-generate]')?.disabled === false")
    assert.equal(await generateDisabled(), false, 'generation action should be restored after cancellation')

    const rerunJobId = 'e2e-canvas-rerun'
    const rerunCanvasId = 'e2e-canvas-rerun-result'
    project = saveProject({
      id: projectId!,
      name: project!.name,
      canvases: project!.canvases.map((canvas) =>
        canvas.id === sourceCanvas!.id ? { ...canvas, jobState: 'succeeded' as const } : canvas,
      ).concat(
        {
          ...sourceCanvas!,
          id: 'e2e-canvas-rerun-middle',
          kind: 'result',
          title: 'E2E rerun middle',
          sourceCanvasId: sourceCanvas!.id,
          jobState: 'succeeded',
          outputs: [],
          error: undefined,
        },
        {
          ...sourceCanvas!,
          id: rerunCanvasId,
          kind: 'result',
          title: 'E2E rerun',
          sourceCanvasId: 'e2e-canvas-rerun-middle',
          jobId: rerunJobId,
          jobState: 'running',
          outputs: [],
          error: undefined,
        },
      ),
      selectedCanvasId: sourceCanvas!.id,
    })
    await new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve())
      void win.webContents.reload()
    })
    await waitFor("[...document.querySelectorAll('button')].some((button) => button.textContent.includes('未命名 Project'))")
    await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.includes('未命名 Project'))?.click()")
    await waitFor("document.querySelector('[data-studio-generate]')?.disabled === true")
    assert.equal(
      await evaluate("[...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '重跑 Canvas 1')?.disabled"),
      true,
      'source Canvas rerun action should be disabled while a nested result job is active',
    )
    sendJob('canceled', rerunJobId, rerunCanvasId)
    await waitFor("document.querySelector('[data-studio-generate]')?.disabled === false")
    assert.equal(await generateDisabled(), false, 'source Canvas action should restore when a rerun is canceled')

    writeFileSync(join(app.getPath('userData'), 'studio-canvas-ui-result.json'), JSON.stringify({
      scenario: 'studio-canvas-ui',
      ok: true,
      projectId,
      canvases: project?.canvases.length,
      selectedCanvasId: project?.selectedCanvasId,
      generationControl: {
        disabledWhileActive: true,
        restoredAfterFailure: true,
        restoredAfterCancel: true,
        sourceDisabledDuringRerun: true,
        sourceRerunButtonDisabledForNestedJob: true,
        sourceRestoredAfterRerunCancel: true,
      },
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
