/**
 * App updates: the title bar chip through every phase (available, downloading,
 * ready, busy then 空闲后自动重启, required), its popover, and 设置 › 通知与更新
 * (channel, 自动下载更新, 回到上一个版本, a copy that cannot update here).
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { UpdaterState } from '@shared/update'
import { useApp, type E2eApp, type Theme } from '../support/app'
import { expectVisualRules } from '../support/visual'

const chip = (page: Page) => page.locator('[data-update-chip]')
const popover = (page: Page) => page.getByRole('dialog', { name: '更新' })

/** Push an update state the way main does (Events.updateState), keeping the mock's state in step. */
async function push(page: Page, build: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(([name, rest]) => {
    const fixtures = window.__mock.fixtures as unknown as Record<string, (...a: unknown[]) => UpdaterState>
    const state = fixtures[name as string]!(...(rest as unknown[]))
    window.__mock.state.update = state
    window.__mock.emit(window.__mock.Events.updateState, state)
  }, [build, args] as const)
}

async function openWith(app: E2eApp, seed: (page: Page) => Promise<void>, options: { theme?: Theme; route?: string } = {}): Promise<Page> {
  const page = await app.open({ scenario: 'ready', route: options.route ?? '/studio', theme: options.theme ?? 'light', defer: true })
  await seed(page)
  await app.start()
  return page
}

describe('update chip', () => {
  const app = useApp()

  it('stays out of the way when there is nothing to do', async () => {
    const page = await app.open({ scenario: 'ready', route: '/studio' })
    expect(await chip(page).count()).toBe(0)
  })

  it('available → 下载更新 → downloading with a thin bar → ready', async () => {
    const page = await app.open({ scenario: 'updateAvailable', route: '/studio', theme: 'light' })
    await expect.poll(() => chip(page).textContent()).toBe('新版本 1.1.0')
    await chip(page).click()
    const panel = popover(page)
    await expect.poll(() => panel.getByText('当前 1.0.3 · 2026年10月30日发布 · 46 MB').isVisible()).toBe(true)
    expect(await panel.locator('h2').first().textContent()).toBe('MossStudio 1.1.0')
    // Release notes render as Markdown (a list item, not the raw "- ").
    expect(await panel.getByRole('listitem').filter({ hasText: '生成更快，显存占用更少' }).isVisible()).toBe(true)
    await expectVisualRules(page, 'update popover: available')

    await panel.getByRole('button', { name: '下载更新' }).click()
    await expect.poll(() => app.calls('update:download').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => chip(page).textContent()).toBe('正在下载更新')
    await push(page, 'updateDownloadingFixture', '1.1.0', 60)
    await expect.poll(() => chip(page).getAttribute('aria-label')).toBe('正在下载 MossStudio 1.1.0 更新，60%')
    expect(await chip(page).locator('[aria-hidden="true"] > span').evaluate((bar) => (bar as HTMLElement).style.width)).toBe('60%')
    await expect.poll(() => panel.getByRole('progressbar', { name: '更新进度' }).getAttribute('aria-valuenow')).toBe('60')
    await panel.getByRole('button', { name: '取消下载' }).click()
    await expect.poll(() => app.calls('update:cancel').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => chip(page).textContent()).toBe('新版本 1.1.0')

    await push(page, 'updateReadyFixture', '1.1.0')
    await expect.poll(() => chip(page).textContent()).toBe('重启以更新')
    expect(await chip(page).getAttribute('data-tone')).toBe('ready')
  })

  it('ready → 重启以更新 restarts right away when nothing is running', async () => {
    const page = await openWith(app, async (p) => {
      await p.evaluate(() => { window.__mock.state.update = window.__mock.fixtures.updateReadyFixture('1.1.0') })
    })
    await chip(page).click()
    await popover(page).getByRole('button', { name: '重启以更新' }).click()
    await expect.poll(() => app.calls('update:restart').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => chip(page).textContent()).toBe('正在重启…')
    expect(await app.calls('update:restart-when-idle')).toEqual([])
  })

  it('a restart the launcher cannot start says so, and nothing changes', async () => {
    const page = await openWith(app, async (p) => {
      await p.evaluate(() => {
        window.__mock.state.update = window.__mock.fixtures.updateReadyFixture('1.1.0')
        window.__mock.handle(window.__mock.Ipc.updateRestart, () => ({ status: 'failed', error: '启动程序没有响应' }))
      })
    })
    await chip(page).click()
    await popover(page).getByRole('button', { name: '重启以更新' }).click()
    await expect.poll(() => page.getByRole('status').filter({ hasText: '没能重启：启动程序没有响应。MossStudio 没有改动，可以稍后再试。' }).isVisible()).toBe(true)
    expect(await chip(page).textContent()).toBe('重启以更新')
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`busy: says what is running, then 空闲后自动重启 waits (${theme})`, async () => {
      const page = await openWith(app, async (p) => {
        await p.evaluate(() => {
          const { updateReadyFixture, jobFixture } = window.__mock.fixtures
          window.__mock.state.update = updateReadyFixture('1.1.0')
          window.__mock.state.jobs = [jobFixture({ id: 'job-live', state: 'running', stage: 'denoise' })]
        })
      }, { theme })
      await chip(page).click()
      await popover(page).getByRole('button', { name: '重启以更新' }).click()
      const panel = popover(page)
      await expect.poll(() => panel.getByText('1 个生成任务正在进行，现在重启会中断。').isVisible()).toBe(true)
      expect(await panel.getByRole('button', { name: '稍后' }).isVisible()).toBe(true)
      await app.screenshot(`update-popover-busy-${theme}`)
      await expectVisualRules(page, `update popover busy (${theme})`)
      await panel.getByRole('button', { name: '空闲后自动重启' }).click()
      await expect.poll(() => app.calls('update:restart-when-idle')).toEqual([{ enabled: true }])
      await expect.poll(() => chip(page).textContent()).toBe('空闲后重启')
      await expect.poll(() => panel.getByText('等1 个生成任务结束后，会自动重启以更新。').isVisible()).toBe(true)
      await panel.getByRole('button', { name: '取消自动重启' }).click()
      await expect.poll(() => app.calls('update:restart-when-idle').then((calls) => calls.at(-1))).toEqual({ enabled: false })
      await expect.poll(() => chip(page).textContent()).toBe('重启以更新')
    })
  }

  for (const theme of ['light', 'dark'] as const) {
    it(`after an automatic rollback: says so once, and 再试一次 downloads that version again (${theme})`, async () => {
      const page = await openWith(app, async (p) => {
        await p.evaluate(() => { window.__mock.state.update = window.__mock.fixtures.updateFailedFixture('1.1.0') })
      }, { theme })
      await expect.poll(() => chip(page).textContent()).toBe('新版本没能启动')
      expect(await chip(page).getAttribute('data-tone')).toBe('warn')
      // Opened on its own, once.
      const panel = popover(page)
      await expect.poll(() => panel.locator('h2').first().textContent()).toBe('1.1.0 没能正常启动')
      expect(await panel.getByText('如果当时是你自己关掉了它，可以放心再试一次。', { exact: false }).isVisible()).toBe(true)
      expect(await panel.getByText('更新内容').count()).toBe(0)
      await app.screenshot(`update-popover-failed-${theme}`)
      await expectVisualRules(page, `update popover failed (${theme})`)
      await panel.getByRole('button', { name: '再试一次' }).click()
      await expect.poll(() => app.calls('update:retry-failed').then((calls) => calls.length)).toBe(1)
      await expect.poll(() => chip(page).textContent()).toBe('正在下载更新')
    })
  }

  it('知道了 hides the rollback notice', async () => {
    const page = await openWith(app, async (p) => {
      await p.evaluate(() => { window.__mock.state.update = window.__mock.fixtures.updateFailedFixture('1.1.0') })
    })
    await popover(page).getByRole('button', { name: '知道了' }).click()
    await expect.poll(() => app.calls('update:dismiss-failed').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => chip(page).count()).toBe(0)
    expect(await popover(page).count()).toBe(0)
  })

  it('稍后 closes the popover and forgets the busy answer', async () => {
    const page = await openWith(app, async (p) => {
      await p.evaluate(() => {
        const { updateReadyFixture, downloadFixture } = window.__mock.fixtures
        window.__mock.state.update = updateReadyFixture('1.1.0')
        window.__mock.state.downloads = [downloadFixture({ state: 'running' })]
      })
    })
    await chip(page).click()
    await popover(page).getByRole('button', { name: '重启以更新' }).click()
    await expect.poll(() => popover(page).getByText('1 个模型下载正在进行，现在重启会中断。').isVisible()).toBe(true)
    await popover(page).getByRole('button', { name: '稍后' }).click()
    await expect.poll(() => popover(page).count()).toBe(0)
    await chip(page).click()
    expect(await popover(page).getByRole('button', { name: '重启以更新' }).isVisible()).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => popover(page).count()).toBe(0)
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`required: 必须更新 as a warning, with the reason in the popover (${theme})`, async () => {
      const page = await openWith(app, async (p) => {
        await p.evaluate(() => {
          window.__mock.state.update = window.__mock.fixtures.updateDownloadingFixture('1.1.0', 35, { required: true, minimumVersion: '1.1.0' })
        })
      }, { theme })
      await expect.poll(() => chip(page).textContent()).toBe('必须更新')
      expect(await chip(page).getAttribute('data-tone')).toBe('warn')
      await chip(page).click()
      await expect.poll(() => popover(page).getByText(/这个版本已停止支持生成/).isVisible()).toBe(true)
      await app.screenshot(`update-popover-required-${theme}`)
      await expectVisualRules(page, `update popover required (${theme})`)
      // The activity panel got the required-update notice too.
      expect(await page.evaluate(() => window.__store().notifications.some((item) => item.title === '必须更新'))).toBe(true)
    })
  }

  it('required: 生成 is disabled ahead of time, and its 更新 opens the popover', async () => {
    const page = await openWith(app, async (p) => {
      await p.evaluate(() => {
        window.__mock.state.update = window.__mock.fixtures.updateAvailableFixture('1.2.0', { required: true, minimumVersion: '1.2.0' })
      })
    })
    const blocker = page.getByRole('listitem').filter({ hasText: '必须更新到 1.2.0 才能继续生成' })
    await expect.poll(() => blocker.isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: /^生成/ }).isDisabled()).toBe(true)
    expect(await popover(page).count()).toBe(0)
    await blocker.getByRole('button', { name: '更新' }).click()
    await expect.poll(() => popover(page).getByText(/这个版本已停止支持生成/).isVisible()).toBe(true)
    // Once updated (no longer required) the blocker goes away.
    await push(page, 'updaterStateFixture')
    await expect.poll(() => blocker.count()).toBe(0)
  })

  it('required: a finished card cannot rerun either, and says why', async () => {
    const page = await openWith(app, async (p) => {
      await p.evaluate(() => {
        const { canvasFixture, projectFixture, jobFixture, updateAvailableFixture } = window.__mock.fixtures
        const outputs = [{ path: '/fixture/outputs/run-0.png', width: 1024, height: 1024, seed: 40 }]
        const source = canvasFixture({ id: 'c1', title: '画面 1', prompt: '阳光明媚的客厅', seed: 40 })
        const result = canvasFixture({
          id: 'c2', kind: 'result', title: '画面 1 · 结果', x: 1120, y: 0, prompt: '阳光明媚的客厅', seed: 40,
          jobId: 'job-done', jobState: 'succeeded', outputs, sourceCanvasId: 'c1',
        } as never)
        window.__mock.state.projects = [projectFixture({ id: 'p1', name: '海报', canvases: [source, result], selectedCanvasId: 'c1' })]
        window.__mock.state.jobs = [jobFixture({ id: 'job-done', state: 'succeeded', stage: 'ready', canvasId: 'c2', projectId: 'p1', outputs, endedAt: '2026-11-01T00:00:20.000Z' })]
        window.__mock.state.update = updateAvailableFixture('1.2.0', { required: true, minimumVersion: '1.2.0' })
      })
    })
    const rerun = page.locator('article[data-canvas-card="c2"]').getByRole('button', { name: /^重新生成/ }).first()
    await expect.poll(() => rerun.isDisabled()).toBe(true)
    expect(await rerun.getAttribute('title')).toBe('必须更新到 1.2.0 才能继续生成')
    await push(page, 'updaterStateFixture')
    await expect.poll(() => rerun.isEnabled()).toBe(true)
    expect(await app.calls('http:POST /api/engine-jobs')).toEqual([])
  })

  it('popover screenshots: ready (light, dark)', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await openWith(app, async (p) => {
        await p.evaluate(() => { window.__mock.state.update = window.__mock.fixtures.updateReadyFixture('1.1.0') })
      }, { theme })
      await chip(page).click()
      await expect.poll(() => popover(page).getByRole('button', { name: '重启以更新' }).isVisible()).toBe(true)
      await app.screenshot(`update-popover-${theme}`)
      await expectVisualRules(page, `update popover ready (${theme})`)
    }
  })
})

describe('设置 › 通知与更新', () => {
  const app = useApp()

  it('shows the version and last check; 检查更新 checks now', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/updates', theme: 'light' })
    await expect.poll(() => page.getByText('MossStudio 1.0.3').isVisible()).toBe(true)
    await expect.poll(() => page.locator('[data-update-status]').textContent()).toMatch(/^已经是最新版本 · 上次检查：/)
    await page.getByRole('button', { name: '检查更新' }).click()
    await expect.poll(() => app.calls('update:check').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => page.getByRole('status').filter({ hasText: '已经是最新版本' }).isVisible()).toBe(true)
  })

  it('switches channel and 自动下载更新 through the update runtime', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/updates', theme: 'light' })
    const channel = page.getByRole('group', { name: '更新渠道' })
    expect(await channel.getByRole('button', { name: '正式版' }).getAttribute('aria-pressed')).toBe('true')
    await channel.getByRole('button', { name: '测试版' }).click()
    await expect.poll(() => app.calls('update:set-channel')).toEqual([{ channel: 'beta' }])
    await expect.poll(() => channel.getByRole('button', { name: '测试版' }).getAttribute('aria-pressed')).toBe('true')
    const auto = page.getByRole('switch', { name: '自动下载更新' })
    expect(await auto.getAttribute('aria-checked')).toBe('true')
    await auto.click()
    await expect.poll(() => app.calls('update:set-auto-download')).toEqual([{ enabled: false }])
    await expect.poll(() => auto.getAttribute('aria-checked')).toBe('false')
    // These are update settings now, not app settings.
    expect(await app.calls('settings:update')).toEqual([])
  })

  it('回到上一个版本 asks first, then switches back', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/updates', theme: 'light', defer: true })
    await page.evaluate(() => {
      window.__mock.state.update = window.__mock.fixtures.updaterStateFixture({ previous: '1.0.2', canRollback: true })
    })
    await app.start()
    await page.getByRole('button', { name: '回到 1.0.2' }).click()
    const dialog = page.getByRole('dialog', { name: '回到 1.0.2？' })
    await expect.poll(() => dialog.isVisible()).toBe(true)
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect.poll(() => dialog.count()).toBe(0)
    expect(await app.calls('update:rollback')).toEqual([])
    await page.getByRole('button', { name: '回到 1.0.2' }).click()
    await page.getByRole('dialog', { name: '回到 1.0.2？' }).getByRole('button', { name: '回到上一个版本' }).click()
    await expect.poll(() => app.calls('update:rollback').then((calls) => calls.length)).toBe(1)
  })

  it('a version skipped by a rollback can be installed again', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/updates', theme: 'light', defer: true })
    await page.evaluate(() => {
      window.__mock.state.update = window.__mock.fixtures.updaterStateFixture({ current: '1.0.2', skippedVersion: '1.1.0' })
    })
    await app.start()
    await expect.poll(() => page.getByText('已跳过 1.1.0').isVisible()).toBe(true)
    await page.getByRole('button', { name: '安装 1.1.0' }).click()
    await expect.poll(() => app.calls('update:unskip').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => page.getByText('已跳过 1.1.0').count()).toBe(0)
  })

  it('a version rolled back after a failed start can be tried again from here', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/updates', theme: 'light', defer: true })
    await page.evaluate(() => {
      window.__mock.state.update = window.__mock.fixtures.updateFailedFixture('1.1.0', { failedNotice: false })
    })
    await app.start()
    await expect.poll(() => page.getByText('1.1.0 没能正常启动').isVisible()).toBe(true)
    expect(await chip(page).count()).toBe(0)
    await page.getByRole('main').getByRole('button', { name: '再试一次' }).click()
    await expect.poll(() => app.calls('update:retry-failed').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => page.getByText('1.1.0 没能正常启动').count()).toBe(0)
    await expect.poll(() => page.locator('[data-update-status]').textContent()).toContain('正在下载 1.1.0')
  })

  it('has no rollback row without a previous version', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/updates' })
    await expect.poll(() => page.getByText('自动下载更新').isVisible()).toBe(true)
    expect(await page.getByText('回到上一个版本').count()).toBe(0)
  })

  it('a ready update restarts from here, and asks in the popover when busy', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/updates', theme: 'light', defer: true })
    await page.evaluate(() => {
      const { updateReadyFixture, jobFixture } = window.__mock.fixtures
      window.__mock.state.update = updateReadyFixture('1.1.0')
      window.__mock.state.jobs = [jobFixture({ id: 'job-live', state: 'running' })]
    })
    await app.start()
    await expect.poll(() => page.locator('[data-update-status]').textContent()).toContain('1.1.0 已准备好，重启即可更新')
    await page.getByRole('main').getByRole('button', { name: '重启以更新' }).click()
    await expect.poll(() => popover(page).getByText('1 个生成任务正在进行，现在重启会中断。').isVisible()).toBe(true)
  })

  it('says why this copy cannot update here, with no update controls', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/updates', theme: 'light', defer: true })
    await page.evaluate(() => {
      window.__mock.state.update = window.__mock.fixtures.updaterStateFixture({
        supported: false, phase: 'unsupported', unsupportedReason: '这是便携版，但缺少启动程序，不能在这里自动更新。请到发布页下载新版本。',
      })
    })
    await app.start()
    await expect.poll(() => page.locator('[data-update-status]').textContent()).toBe('这是便携版，但缺少启动程序，不能在这里自动更新。请到发布页下载新版本。')
    for (const name of ['检查更新', '重启以更新']) expect(await page.getByRole('button', { name }).count()).toBe(0)
    expect(await page.getByRole('switch', { name: '自动下载更新' }).count()).toBe(0)
    expect(await page.getByRole('group', { name: '更新渠道' }).count()).toBe(0)
    expect(await chip(page).count()).toBe(0)
    await page.getByRole('button', { name: '查看', exact: true }).click()
    await expect.poll(() => app.calls('app:open-external')).toEqual([{ url: 'https://github.com/CloverIris/MossStudio/releases' }])
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`screenshot (${theme})`, async () => {
      const page = await app.open({ scenario: 'ready', route: '/settings/updates', theme, defer: true })
      await page.evaluate(() => {
        window.__mock.state.update = window.__mock.fixtures.updateAvailableFixture('1.1.0', { previous: '1.0.2', canRollback: true })
      })
      await app.start()
      await expect.poll(() => page.locator('[data-update-status]').textContent()).toContain('有新版本 1.1.0')
      expect(await page.getByRole('main').getByRole('button', { name: '下载更新' }).isVisible()).toBe(true)
      await app.screenshot(`settings-updates-${theme}`)
      await expectVisualRules(page, `settings updates (${theme})`)
    })
  }
})
