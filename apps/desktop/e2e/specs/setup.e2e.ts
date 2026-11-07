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

  it('prepares engine and model in one go, continues in the background, then finishes', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/studio', theme: 'light' })
    // Nothing works until the computer is prepared, so the app starts here.
    await expect.poll(() => hash(page)).toBe('#/setup')
    await expect.poll(() => page.getByRole('heading', { name: '准备好你的电脑' }).isVisible()).toBe(true)

    await page.getByRole('button', { name: '开始准备' }).click()
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
    const steps = page.getByRole('list', { name: '准备步骤' })
    await expect.poll(() => steps.getByRole('progressbar').count()).toBeGreaterThan(0)
    await expect.poll(() => steps.getByText('40%').count()).toBeGreaterThan(0)
    await app.screenshot('setup-progress-light')

    // 在后台继续 → 创作, which says what is still being prepared.
    await page.getByRole('button', { name: '在后台继续' }).click()

    await expect.poll(() => hash(page)).toBe('#/studio')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'active' })
    const blockers = page.locator('li').filter({ hasText: /引擎|模型/ })
    await expect.poll(() => page.getByText('引擎正在安装 · 40%', { exact: true }).isVisible()).toBe(true)
    // 输入 gives the same reason as the footer, not "no engine".
    await expect.poll(() => page.getByText('引擎正在安装 · 40%，就绪后才能添加图片').isVisible()).toBe(true)
    await expect.poll(() => blockers.filter({ hasText: '还没有可用的模型' }).count()).toBe(1)
    await app.screenshot('studio-preparing-light')
    // 查看 goes back to the page that shows the whole preparation.
    await blockers.filter({ hasText: '引擎正在安装' }).getByRole('button', { name: '查看' }).click()
    await expect.poll(() => hash(page)).toBe('#/setup')
    await page.getByRole('button', { name: '在后台继续' }).click()
    await expect.poll(() => hash(page)).toBe('#/studio')

    // Everything finishes while the user is away.
    await page.evaluate(() => {
      const { fixtures, Events, state } = window.__mock
      state.engineReadiness = fixtures.engineReadyFixture()
      state.engineVersions = [fixtures.engineVersionFixture()]
      window.__mock.emit(Events.mossInferDownload, fixtures.engineDownloadFixture({ phase: 'done', bytes: 900_000_000, percent: 100 }))
      for (const task of [...state.downloads]) window.__mock.playDownload(task)
    })
    await expect.poll(() => page.getByText('引擎正在安装 · 40%').count()).toBe(0)
    await expect.poll(() => blockers.filter({ hasText: '还没有可用的模型' }).count()).toBe(0)

    // Back on 准备, 开始创作 completes onboarding.
    await page.evaluate(() => {
      window.location.hash = '#/setup'
    })
    await expect.poll(() => page.getByRole('heading', { name: '一切就绪' }).isVisible()).toBe(true)
    await app.screenshot('setup-done-light')
    await page.getByRole('button', { name: '开始创作' }).click()
    await expect.poll(() => hash(page)).toBe('#/studio')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'completed' })
  })

  it('after a restart mid-install, starts the model download without waiting for the engine', async () => {
    const page = await app.open({ scenario: 'engineInstalling', route: '/setup', theme: 'dark' })
    const steps = page.getByRole('list', { name: '准备步骤' })
    await expect.poll(() => steps.getByText('50%').count()).toBeGreaterThan(0)
    // The engine is still downloading, so 开始创作 is not available yet, but the model can start now.
    await page.getByRole('button', { name: '同时下载模型' }).click()
    await expect.poll(() => app.calls('models:download').then((calls) => calls.length)).toBeGreaterThan(0)
    // Starting the model must not start a second engine install.
    expect(await app.calls('mossinfer:download')).toHaveLength(0)
  })

  it('explains a missing GPU and re-checks on request', async () => {
    const page = await app.open({ scenario: 'noGpu', route: '/setup', theme: 'dark' })
    await expect.poll(() => page.getByText('在这台电脑上没有找到能运行引擎的显卡', { exact: false }).isVisible()).toBe(true)
    // Nothing can start while blocked: 开始准备 is gone and 重新检测 is the main action.
    expect(await page.getByRole('button', { name: '开始准备' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '重新检测' }).isEnabled()).toBe(true)
    // Remote hosts are off: point at where to turn them on, nothing more.
    await expect.poll(() => page.getByRole('button', { name: '去开启远程主机' }).isVisible()).toBe(true)

    // The driver gets fixed; 重新检测 finds the GPU and setup can start.
    await page.evaluate(() => {
      const { fixtures, state } = window.__mock
      state.gpuInventory = fixtures.gpuInventoryFixture()
      state.devices = [fixtures.launchDeviceFixture()]
      state.engineMachine = fixtures.machineFixture('nvidia')
    })
    await page.getByRole('button', { name: '重新检测' }).click()
    await expect.poll(() => app.calls('gpu:inventory-refresh').then((calls) => calls.length)).toBeGreaterThan(0)
    // The machine is probed again too (AMD / Intel GPUs come from there).
    await expect
      .poll(() => app.calls<{ refresh?: boolean }>('engine:plan').then((calls) => calls.filter((call) => call?.refresh).length))
      .toBeGreaterThan(1)
    await expect.poll(() => page.getByRole('button', { name: '开始准备' }).isEnabled()).toBe(true)
    await expect.poll(() => page.getByText('在这台电脑上没有找到能运行引擎的显卡', { exact: false }).count()).toBe(0)
  })

  it('已有模型文件？ uses a local folder instead of the 25 GB download', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/setup', defer: true })
    await page.evaluate(() => {
      window.__mock.state.localModelFolder = {
        path: '/workspace/Models/MOSS-Image/sft',
        name: 'MOSS-Image SFT（sft）',
        bundleId: 'moss-sft',
      }
    })
    await app.start()
    const steps = page.getByRole('list', { name: '准备步骤' })
    await page.getByRole('button', { name: '已有模型文件？使用本地文件夹' }).click()
    await expect.poll(() => app.calls('models:import-folder').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => page.getByText(/已在原位置使用 MOSS-Image SFT（sft），不用再下载模型/).isVisible()).toBe(true)
    await expect.poll(() => steps.getByText(/已就绪/).count()).toBeGreaterThan(0)
    // The quiet action leaves once the model is there.
    expect(await page.getByRole('button', { name: '已有模型文件？使用本地文件夹' }).count()).toBe(0)
    await page.getByRole('button', { name: '开始准备' }).click()
    await expect.poll(() => app.calls('mossinfer:download').then((calls) => calls.length)).toBe(1)
    expect(await app.calls('models:download')).toEqual([])
  })

  it('a folder that is not a usable MOSS-Image keeps the download, and says why', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/setup', defer: true })
    await page.evaluate(() => {
      window.__mock.state.localModelFolder = { path: '/data/my-finetune', name: 'my-finetune', bundleId: 'none' }
    })
    await app.start()
    await page.getByRole('button', { name: '已有模型文件？使用本地文件夹' }).click()
    await expect.poll(() => page.getByText(/不是可以直接使用的 MOSS-Image 模型/).isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: '已有模型文件？使用本地文件夹' }).count()).toBe(1)
  })

  it('sends a GPU-less user to turn on remote hosts', async () => {
    const page = await app.open({ scenario: 'noGpu', route: '/setup' })
    await page.getByRole('button', { name: '去开启远程主机' }).click()
    await expect.poll(() => hash(page)).toBe('#/settings/features')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'active' })
  })

  it('skips setup when asked and never comes back on its own', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/setup' })
    await page.getByRole('button', { name: '跳过' }).click()
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
