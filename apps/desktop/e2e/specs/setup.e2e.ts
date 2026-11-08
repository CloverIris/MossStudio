/**
 * First run (/setup) and the readiness line in 创作 while things are missing.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { DownloadTask, MossInferDownloadState } from '@shared/types'
import { useApp } from '../support/app'

const hash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash)

describe('first run', () => {
  const app = useApp()

  it('one decision to start, one progress with the time left, the board usable meanwhile, then done on its own', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/studio', theme: 'light' })
    // Nothing works until the computer is prepared, so the app starts here.
    await expect.poll(() => hash(page)).toBe('#/setup')
    await expect.poll(() => page.getByRole('heading', { name: '准备开始创作' }).isVisible()).toBe(true)
    // What it takes, in one line, and where it goes.
    const summary = page.locator('[data-setup-summary]')
    await expect.poll(() => summary.innerText()).toContain('下载约 26 GB')
    expect(await summary.innerText()).toContain('保存到 /fixture/data/models')
    // The GPU is one quiet line; nothing about engines on the way in.
    expect(await page.locator('[data-setup-gpu]').textContent()).toBe('NVIDIA GeForce RTX 4090 · 24 GB')
    expect(await page.getByText(/引擎/).count()).toBe(0)
    await app.screenshot('setup-first-run-light')

    await page.getByRole('button', { name: '开始下载' }).click()
    await expect.poll(() => app.calls('mossinfer:download').then((calls) => calls.length)).toBe(1)
    const bundle = await page.evaluate(() => {
      const recommended = window.__mock.state.catalog.bundles.find((item) => item.recommended)!
      return [...Object.values(recommended.components), recommended.support]
    })
    await expect
      .poll(() => app.calls<{ kind: string; id: string }>('models:download').then((calls) => calls.map((call) => call.id).sort()))
      .toEqual([...bundle].sort())

    // Progress arrives as events from the main process.
    await page.evaluate(() => {
      const { fixtures, Events, state } = window.__mock
      const engine: MossInferDownloadState = fixtures.engineDownloadFixture({
        phase: 'downloading',
        bytes: 360_000_000,
        percent: 40,
        speedBps: 20_000_000,
      })
      window.__mock.emit(Events.mossInferDownload, engine)
      for (const task of state.downloads) {
        window.__mock.emit(Events.download, {
          ...task,
          state: 'running',
          bytes: Math.floor(task.totalBytes / 4),
          speedBps: 30_000_000,
        } satisfies DownloadTask)
      }
    })
    await expect.poll(() => page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
    // One bar for everything, with the time left in words; the two parts small underneath.
    const progress = page.locator('[data-setup-progress]')
    expect(await progress.getByRole('progressbar').count()).toBe(1)
    await expect.poll(() => progress.innerText()).toMatch(/\d+%[\s\S]*还要约 \d+ 分钟/)
    expect(await progress.getByRole('list', { name: '正在下载' }).getByRole('listitem').allInnerTexts()).toEqual([
      expect.stringContaining('运行组件'),
      expect.stringContaining('MOSS-Image SFT'),
    ])
    await app.screenshot('setup-progress-light')

    // 先去看看 → 创作: the title bar carries the download, 生成 fills up and says why it is off.
    await page.getByRole('button', { name: '先去看看' }).click()
    await expect.poll(() => hash(page)).toBe('#/studio')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'active' })
    const chip = page.locator('[data-preparation-chip]')
    await expect.poll(() => chip.innerText()).toMatch(/准备中 \d+%/)
    const generate = page.locator('[data-studio-generate]')
    await expect.poll(() => generate.innerText()).toMatch(/下载完成后就能生成 · \d+%/)
    expect(await generate.isDisabled()).toBe(true)
    // The download's own reasons step aside: 生成 says it.
    const blockers = page.locator('li').filter({ hasText: /引擎正在安装|还没有可用的模型|还没有下载完/ })
    expect(await blockers.count()).toBe(0)
    // The card's ＋ still gives the reason on its disabled inputs.
    await page.locator('article[data-canvas-card]').first().hover()
    await page.locator('[data-input-adder] button').first().click()
    await expect
      .poll(() => page.getByRole('menuitem', { name: /^起始图/ }).getAttribute('title'))
      .toBe('引擎正在安装 · 40%，就绪后才能把图片接进来')
    await page.keyboard.press('Escape')
    await app.screenshot('studio-preparing-light')
    // The chip goes back to the page that shows the whole preparation.
    await chip.click()
    await expect.poll(() => hash(page)).toBe('#/setup')
    await page.getByRole('button', { name: '先去看看' }).click()
    await expect.poll(() => hash(page)).toBe('#/studio')

    // Everything finishes while the user is away: setup completes and a toast says so.
    await page.evaluate(() => {
      const { fixtures, Events, state } = window.__mock
      state.engineReadiness = fixtures.engineReadyFixture()
      state.engineVersions = [fixtures.engineVersionFixture()]
      window.__mock.emit(Events.mossInferDownload, fixtures.engineDownloadFixture({ phase: 'done', bytes: 900_000_000, percent: 100 }))
      for (const task of [...state.downloads]) window.__mock.playDownload(task)
    })
    await expect.poll(() => chip.count()).toBe(0)
    await expect.poll(() => page.getByText('模型准备好了，可以生成了').isVisible()).toBe(true)
    await expect
      .poll(() => app.calls<{ onboardingState?: string }>('settings:update').then((calls) => calls.at(-1)))
      .toEqual({ onboardingState: 'completed' })
    await expect.poll(() => generate.innerText()).not.toContain('下载完成后')
  })

  it('finishing on 准备 goes straight to the board', async () => {
    const page = await app.open({ scenario: 'engineInstalling', route: '/setup' })
    await expect.poll(() => page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
    await page.evaluate(() => {
      const { fixtures, Events, state } = window.__mock
      state.engineReadiness = fixtures.engineReadyFixture()
      state.engineVersions = [fixtures.engineVersionFixture()]
      window.__mock.emit(Events.mossInferDownload, fixtures.engineDownloadFixture({ phase: 'done', bytes: 900_000_000, percent: 100 }))
      for (const task of [...state.downloads]) window.__mock.playDownload(task)
    })
    await expect.poll(() => hash(page)).toBe('#/studio')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'completed' })
    await expect.poll(() => page.getByText('模型准备好了，可以生成了').isVisible()).toBe(true)
  })

  it('after a restart mid-install, carries on with the model download by itself', async () => {
    const page = await app.open({ scenario: 'engineInstalling', route: '/setup', theme: 'dark' })
    await expect.poll(() => page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
    await expect.poll(() => app.calls('models:download').then((calls) => calls.length)).toBeGreaterThan(0)
    // Starting the model must not start a second engine install.
    expect(await app.calls('mossinfer:download')).toHaveLength(0)
    await app.screenshot('setup-installing-dark')
  })

  it('without a usable GPU: another computer or 重新检测, as two choices', async () => {
    const page = await app.open({ scenario: 'noGpu', route: '/setup', theme: 'dark' })
    await expect.poll(() => page.getByRole('heading', { name: '这台电脑跑不了模型' }).isVisible()).toBe(true)
    // Nothing can start while blocked.
    expect(await page.getByRole('button', { name: '开始下载' }).count()).toBe(0)
    await app.screenshot('setup-no-gpu-dark')

    // The driver gets fixed; 重新检测 finds the GPU and setup can start.
    await page.evaluate(() => {
      const { fixtures, state } = window.__mock
      state.gpuInventory = fixtures.gpuInventoryFixture()
      state.devices = [fixtures.launchDeviceFixture()]
      state.engineMachine = fixtures.machineFixture('nvidia')
    })
    await page.getByRole('button', { name: /重新检测/ }).click()
    await expect.poll(() => app.calls('gpu:inventory-refresh').then((calls) => calls.length)).toBeGreaterThan(0)
    // The machine is probed again too (AMD / Intel GPUs come from there).
    await expect
      .poll(() => app.calls<{ refresh?: boolean }>('engine:plan').then((calls) => calls.filter((call) => call?.refresh).length))
      .toBeGreaterThan(1)
    await expect.poll(() => page.getByRole('button', { name: '开始下载' }).isEnabled()).toBe(true)
    expect(await page.getByRole('heading', { name: '这台电脑跑不了模型' }).count()).toBe(0)
  })

  it('用另一台电脑 turns on remote hosts and adds one right there', async () => {
    const page = await app.open({ scenario: 'noGpu', route: '/setup' })
    await page.getByRole('button', { name: /用另一台电脑/ }).click()
    await expect
      .poll(() => app.calls<{ remoteHostsEnabled?: boolean }>('settings:update').then((calls) => calls.at(-1)))
      .toEqual({ remoteHostsEnabled: true })
    const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' })
    await expect.poll(() => dialog.isVisible()).toBe(true)
    await dialog.getByLabel('地址', { exact: true }).fill('gpu.lan')
    await dialog.getByLabel('用户名', { exact: true }).fill('moss')
    await dialog.getByRole('button', { name: '保存并测试' }).click()
    await expect.poll(() => app.calls('hosts:save').then((calls) => calls.length)).toBe(1)
    // 设备 prepares it from there: connection, engine, then the model.
    await expect.poll(() => hash(page)).toBe('#/settings/devices')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'active' })
  })

  it('已有模型文件… uses a local folder instead of the 25 GB download', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/setup', defer: true })
    await page.evaluate(() => {
      window.__mock.state.localModelFolder = {
        path: '/workspace/Models/MOSS-Image/sft',
        name: 'MOSS-Image SFT（sft）',
        bundleId: 'moss-sft',
      }
    })
    await app.start()
    await page.getByRole('button', { name: '已有模型文件…' }).click()
    await expect.poll(() => app.calls('models:import-folder').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => page.getByText(/已在原位置使用 MOSS-Image SFT（sft），不用再下载模型/).isVisible()).toBe(true)
    // The quiet action leaves once the model is there, and only the runtime is left to download.
    await expect.poll(() => page.getByRole('button', { name: '已有模型文件…' }).count()).toBe(0)
    await expect.poll(() => page.locator('[data-setup-summary]').innerText()).toMatch(/下载约 \d+ MB/)
    await page.getByRole('button', { name: '开始下载' }).click()
    await expect.poll(() => app.calls('mossinfer:download').then((calls) => calls.length)).toBe(1)
    expect(await app.calls('models:download')).toEqual([])
  })

  it('a folder that is not a usable MOSS-Image keeps the download, and says why', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/setup', defer: true })
    await page.evaluate(() => {
      window.__mock.state.localModelFolder = { path: '/data/my-finetune', name: 'my-finetune', bundleId: 'none' }
    })
    await app.start()
    await page.getByRole('button', { name: '已有模型文件…' }).click()
    await expect.poll(() => page.getByText(/不是可以直接使用的 MOSS-Image 模型/).isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: '已有模型文件…' }).count()).toBe(1)
  })

  it('稍后 leaves setup and never comes back on its own', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/setup' })
    await page.getByRole('button', { name: '稍后' }).click()
    await expect.poll(() => hash(page)).toBe('#/studio')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'dismissed' })
    await expect.poll(() => page.getByText('引擎未就绪', { exact: true }).isVisible()).toBe(true)
    // The readiness line's action goes where the engine is managed now that setup was dismissed.
    await page.locator('li', { hasText: '引擎未就绪' }).getByRole('button', { name: '去设置' }).click()
    await expect.poll(() => hash(page)).toBe('#/settings/devices')
  })
})

describe('readiness in 创作', () => {
  const app = useApp()

  it('says what is missing with a link to 模型, and nothing else in the way', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/studio' })
    await page.locator('[data-project-switcher]').waitFor()
    await expect.poll(() => page.locator('li').filter({ hasText: '还没有可用的模型' }).count()).toBe(1)
    expect(await page.locator('[data-studio-generate]').isDisabled()).toBe(true)
    await page.getByRole('button', { name: '去下载' }).click()
    await expect.poll(() => hash(page)).toBe('#/models')
  })

  it('has no placeholder buttons anywhere', async () => {
    const routes = [
      '/studio',
      '/library',
      '/models',
      '/settings/general',
      '/settings/devices',
      '/settings/storage',
      '/settings/network',
      '/settings/features',
      '/settings/updates',
      '/settings/about',
      '/training',
    ]
    for (const route of routes) {
      const page = await app.open({
        scenario: 'ready',
        route,
        settings: { trainingEnabled: true, remoteHostsEnabled: true, lanWebEnabled: true },
      })
      const text = await page.evaluate(() => document.body.innerText)
      for (const stub of ['后续版本', '即将推出', '敬请期待', 'TODO', 'Coming soon', '未实现']) {
        expect(text, `${route} shows "${stub}"`).not.toContain(stub)
      }
    }
  })
})
