/**
 * The app frame: Activity panel (jobs with logs, notifications, problems),
 * legacy routes, the title bar's performance monitor and update button, and
 * 训练 appearing only when turned on.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp } from '../support/app'

const hash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash)
const GiB = 1024 ** 3

describe('activity panel', () => {
  const app = useApp()
  const panel = (page: Page) => page.getByRole('complementary', { name: '活动' })
  const rail = (page: Page) => page.getByRole('navigation', { name: '主导航' })

  it('opens from the rail and shows jobs with their logs and a working 取消', async () => {
    const page = await app.open({ scenario: 'ready', route: '/library', theme: 'dark', defer: true })
    await page.evaluate(() => {
      const { jobFixture, jobLogFixture } = window.__mock.fixtures
      window.__mock.state.jobs = [jobFixture({ id: 'job-old', state: 'succeeded', stage: 'ready', endedAt: '2026-11-01T00:00:00.000Z' })]
      window.__mock.state.jobLogs = { 'job-run': jobLogFixture('job-run', 3), 'job-old': jobLogFixture('job-old', 2) }
    })
    await app.start()
    await page.evaluate(() => {
      const job = window.__mock.fixtures.jobFixture({
        id: 'job-run',
        canvasTitle: '海边的灯塔',
        state: 'running',
        stage: 'denoise',
        progress: { stage: 'denoise', current: 10, total: 28, percent: 36 },
      })
      window.__mock.state.jobs = [job, ...window.__mock.state.jobs]
      window.__mock.emit(window.__mock.Events.job, job)
    })
    await rail(page).getByRole('button', { name: '活动' }).click()
    await expect.poll(() => panel(page).isVisible()).toBe(true)
    await expect.poll(() => panel(page).getByRole('progressbar', { name: '任务进度' }).isVisible()).toBe(true)
    await expect.poll(() => panel(page).getByText('已结束').isVisible()).toBe(true)
    // Named after its canvas, as on the Studio card.
    expect(await panel(page).locator('[data-job-row="job-run"]').textContent()).toContain('海边的灯塔')

    await panel(page).locator('[data-job-row="job-run"] button[aria-expanded]').click()
    await expect.poll(() => app.calls<{ id: string }>('jobs:logs').then((calls) => calls.some((call) => call.id === 'job-run'))).toBe(true)
    await expect.poll(() => panel(page).locator('[data-job-log]').textContent()).toContain('line 2')
    await page.evaluate(() =>
      window.__mock.emit(window.__mock.Events.jobLog, {
        jobId: 'job-run',
        seq: 3,
        at: '2026-11-01T00:00:00.000Z',
        stream: 'stdout',
        text: 'step 11/28',
      }),
    )
    await expect.poll(() => panel(page).locator('[data-job-log]').textContent()).toContain('step 11/28')
    await app.screenshot('activity-jobs-dark')

    await panel(page).locator('[data-job-row="job-run"]').getByRole('button', { name: '取消' }).click()
    await expect.poll(() => app.calls('jobs:cancel')).toEqual([{ id: 'job-run' }])

    await page.keyboard.press('Escape')
    await expect.poll(() => panel(page).count()).toBe(0)
  })

  it('marks notifications read when they are seen', async () => {
    const page = await app.open({ scenario: 'engineInstalling', route: '/studio', settings: { onboardingState: 'active' } })
    const button = rail(page).getByRole('button', { name: '活动' })
    const badge = button.locator('span.bg-accent')
    expect(await badge.count()).toBe(0)
    await page.evaluate(() => {
      const { fixtures, Events, state } = window.__mock
      state.engineReadiness = fixtures.engineReadyFixture()
      window.__mock.emit(Events.mossInferDownload, fixtures.engineDownloadFixture({ phase: 'done', percent: 100 }))
    })
    await expect.poll(() => badge.count()).toBe(1)
    await button.click()
    await panel(page).getByRole('tab', { name: /通知/ }).click()
    await expect.poll(() => panel(page).getByText('MossInfer 引擎已就绪').isVisible()).toBe(true)
    await expect.poll(() => page.evaluate(() => window.__store().notifications.every((item) => item.read))).toBe(true)
    await expect.poll(() => badge.count()).toBe(0)
  })

  it('offers only real fixes for problems, and they go somewhere', async () => {
    const page = await app.open({ scenario: 'jobFailure', route: '/studio', theme: 'light', defer: true })
    await page.evaluate(() => {
      const { diagnosticFixture, jobLogFixture } = window.__mock.fixtures
      window.__mock.state.diagnostics = [
        diagnosticFixture({
          jobId: 'job-failed',
          solutions: [
            { label: '查看日志', action: 'open_job_log' },
            { label: '检查引擎', action: 'repair_runtime' },
            { label: '自动重试', action: 'retry' },
          ],
        }),
      ]
      window.__mock.state.jobLogs = { 'job-failed': jobLogFixture('job-failed', 4) }
    })
    await app.start()
    await rail(page).getByRole('button', { name: '活动' }).click()
    await panel(page).getByRole('tab', { name: /问题/ }).click()
    await expect.poll(() => panel(page).getByText('显存不足').isVisible()).toBe(true)
    // No button without a fix behind it.
    expect(await panel(page).getByRole('button', { name: '自动重试' }).count()).toBe(0)
    // Fixes are ordinary buttons: a list of cards has no one main action.
    expect(await panel(page).locator('[data-problem] button.bg-ink').count()).toBe(0)
    await app.screenshot('activity-problems-light')

    await panel(page).getByRole('button', { name: '查看日志' }).click()
    await expect.poll(() => panel(page).getByRole('tab', { name: /任务/ }).getAttribute('aria-selected')).toBe('true')
    await expect.poll(() => panel(page).locator('[data-job-row="job-failed"] [data-job-log]').textContent()).toContain('line 3')

    await panel(page).getByRole('tab', { name: /问题/ }).click()
    await panel(page).getByRole('button', { name: '检查引擎' }).click()
    await expect.poll(() => hash(page)).toBe('#/settings/devices')
    await expect.poll(() => panel(page).count()).toBe(0)

    await rail(page).getByRole('button', { name: '活动' }).click()
    await panel(page).getByRole('tab', { name: /问题/ }).click()
    await panel(page).getByRole('button', { name: '忽略' }).click()
    await expect.poll(() => app.calls('diagnostics:dismiss')).toEqual([{ id: 'diag-1' }])
  })

  it('redirects legacy routes', async () => {
    for (const [from, to] of [
      ['/gallery', '/library'],
      ['/engines', '/settings/devices'],
      ['/devices', '/settings/devices'],
      ['/instances', '/settings/devices'],
    ] as const) {
      const page = await app.open({ route: from })
      await expect.poll(() => hash(page)).toBe(`#${to}`)
    }
    const page = await app.open({ scenario: 'jobFailure', route: '/diagnostics' })
    await expect.poll(() => hash(page)).toBe('#/studio')
    await expect.poll(() => panel(page).isVisible()).toBe(true)
    expect(await panel(page).getByRole('tab', { name: /问题/ }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('title bar', () => {
  const app = useApp()

  it('shows live GPU load, VRAM and tasks, with every GPU one click away', async () => {
    const page = await app.open({ scenario: 'ready', route: '/studio', theme: 'dark' })
    await page.evaluate(
      ([gib]) => {
        const { fixtures, Events } = window.__mock
        const devices = [fixtures.gpuDeviceFixture(), fixtures.GPU_RTX_3060()]
        const snapshot = fixtures.gpuTelemetryFixture(devices)
        snapshot.devices[0] = { ...snapshot.devices[0]!, utilizationPercent: 57, memoryUsedBytes: 9.5 * gib, runningTasks: 1 }
        snapshot.devices[1] = { ...snapshot.devices[1]!, utilizationPercent: 4, memoryUsedBytes: 1 * gib }
        window.__mock.emit(Events.gpuTelemetry, snapshot)
        const job = fixtures.jobFixture({ id: 'job-live', state: 'running', stage: 'denoise' })
        window.__mock.state.jobs = [job]
        window.__mock.emit(Events.job, job)
      },
      [GiB] as const,
    )
    const monitor = page.locator('[data-perf-monitor]')
    await expect.poll(() => monitor.getAttribute('aria-label')).toBe('性能：显卡负载 57%，显存 9.5 / 24.0 GB，1 个任务。点击查看每块显卡')
    await expect.poll(() => monitor.textContent()).toContain('57%')
    await monitor.click()
    const popover = page.getByRole('dialog', { name: '显卡状态' })
    await expect.poll(() => popover.getByText('NVIDIA GeForce RTX 3060').isVisible()).toBe(true)
    await expect.poll(() => popover.getByText('NVIDIA GeForce RTX 4090').isVisible()).toBe(true)
    await app.screenshot('titlebar-gpu-popover-dark')
    await popover.getByRole('button', { name: '设备与引擎设置' }).click()
    await expect.poll(() => hash(page)).toBe('#/settings/devices')
    await expect.poll(() => popover.count()).toBe(0)
  })

  it('says when there is no GPU', async () => {
    const page = await app.open({ scenario: 'noGpu', route: '/studio', settings: { onboardingState: 'dismissed' } })
    await expect.poll(() => page.locator('[data-perf-monitor]').textContent()).toContain('未检测到显卡')
  })

  it('offers an update only when one is available', async () => {
    let page = await app.open({ scenario: 'ready', route: '/studio' })
    expect(await page.locator('[data-update-chip]').count()).toBe(0)
    page = await app.open({ scenario: 'updateAvailable', route: '/studio', theme: 'light' })
    const chip = page.locator('[data-update-chip]')
    await expect.poll(() => chip.textContent()).toContain('新版本 1.1.0')
    await chip.click()
    await expect.poll(() => page.getByRole('dialog', { name: '更新' }).getByRole('button', { name: '下载更新' }).isVisible()).toBe(true)
  })
})

describe('training', () => {
  const app = useApp()

  it('appears only when turned on, and lists runs from training jobs', async () => {
    let page = await app.open({ scenario: 'ready', route: '/training' })
    expect(await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '训练' }).count()).toBe(0)
    await expect.poll(() => page.locator('[data-page="/training"]').count()).toBe(0)

    page = await app.open({ scenario: 'ready', route: '/training', theme: 'light', settings: { trainingEnabled: true }, defer: true })
    await page.evaluate(() => {
      const { jobFixture } = window.__mock.fixtures
      window.__mock.state.jobs = [
        jobFixture({
          id: 'train-1',
          kind: 'training',
          trainerRunName: '猫咪 LoRA',
          trainerAlgo: 'lora',
          state: 'running',
          stage: 'denoise',
          progress: { stage: 'denoise', current: 1200, total: 2000, percent: 60 },
          metrics: { step: 1200, loss: 0.0812 },
          startedAt: '2026-11-01T02:00:00.000Z',
        }),
        jobFixture({
          id: 'train-0',
          kind: 'training',
          trainerRunName: '风格 LoRA',
          trainerAlgo: 'lora',
          state: 'succeeded',
          stage: 'ready',
          progress: { stage: 'ready', current: 1000, total: 1000, percent: 100 },
          startedAt: '2026-11-01T01:00:00.000Z',
          endedAt: '2026-11-01T01:30:00.000Z',
        }),
        jobFixture({ id: 'gen-1', state: 'succeeded' }),
      ]
    })
    await app.start()
    await expect.poll(() => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '训练' }).isVisible()).toBe(true)
    await expect.poll(() => page.getByText('猫咪 LoRA').isVisible()).toBe(true)
    await expect.poll(() => page.getByText('风格 LoRA').isVisible()).toBe(true)
    await expect.poll(() => page.getByText('1,200 / 2,000').isVisible()).toBe(true)
    await expect.poll(() => page.getByText(/loss 0\.081/).isVisible()).toBe(true)
    await app.screenshot('training-runs-light')
  })
})
