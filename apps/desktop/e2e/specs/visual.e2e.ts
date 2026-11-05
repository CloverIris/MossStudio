/**
 * Every page and key state, in both themes: the visual rules hold (no borders,
 * only theme tokens, readable text, no sideways overflow) and a screenshot is
 * written to E2E_SHOTS_DIR as <page>-<state>-<theme>.png.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { settle, useApp, type E2eApp, type OpenOptions } from '../support/app'
import { audit, clippedText, expectVisualRules } from '../support/visual'

interface Stop {
  page: string
  state: string
  open: OpenOptions
  /** Edit the mock state before the app starts (opens with defer). */
  seed?: (page: Page) => Promise<void>
  /** Bring the page into the state worth checking. */
  prepare?: (page: Page) => Promise<void>
}

const ALL_FEATURES = { trainingEnabled: true, remoteHostsEnabled: true, lanWebEnabled: true }

/** A project whose canvas has a description, two regions and a finished run with four outputs. */
async function seedStudio(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { canvasFixture, projectFixture, jobFixture } = window.__mock.fixtures
    const outputs = [0, 1, 2, 3].map((index) => ({ path: `/fixture/outputs/run-${index}.png`, width: 1024, height: 1024, seed: 40 + index }))
    const layers = [
      { id: 'r1', kind: 'object', caption: '一只橘猫', bbox: [80, 120, 560, 640], visible: true },
      { id: 'r2', kind: 'text', caption: '标题', text: '夏日', bbox: [600, 80, 960, 300], visible: true },
    ]
    const source = canvasFixture({ id: 'c1', title: '画面 1', prompt: '阳光明媚的客厅', summary: { caption: '阳光明媚的客厅', meta: [], canvas: 'single' }, layers: layers as never, seed: 40 })
    const result = canvasFixture({
      id: 'c2', kind: 'result', title: '画面 1 · 结果', x: 1120, y: 0, prompt: '阳光明媚的客厅', summary: { caption: '阳光明媚的客厅', meta: [], canvas: 'single' },
      layers: layers as never, seed: 40, jobId: 'job-done', jobState: 'succeeded', outputs, sourceCanvasId: 'c1',
    } as never)
    window.__mock.state.projects = [projectFixture({ id: 'p1', name: '海报', canvases: [source, result], selectedCanvasId: 'c1' })]
    window.__mock.state.jobs = [jobFixture({ id: 'job-done', state: 'succeeded', stage: 'ready', canvasId: 'c2', projectId: 'p1', outputs, endedAt: '2026-11-01T00:00:20.000Z' })]
  })
}

async function seedJobs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { jobFixture, jobLogFixture } = window.__mock.fixtures
    window.__mock.state.jobs = [
      jobFixture({ id: 'job-run', state: 'running', stage: 'denoise', progress: { stage: 'denoise', current: 10, total: 28, percent: 36 } }),
      jobFixture({ id: 'job-old', state: 'succeeded', stage: 'ready', endedAt: '2026-11-01T00:00:00.000Z' }),
    ]
    window.__mock.state.jobLogs = { 'job-run': jobLogFixture('job-run', 6) }
  })
}

const openActivity = (tab: string) => async (page: Page): Promise<void> => {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '活动' }).click()
  await page.getByRole('complementary', { name: '活动' }).getByRole('tab', { name: new RegExp(tab) }).click()
}

const STOPS: Stop[] = [
  { page: 'setup', state: 'first-run', open: { scenario: 'firstRun', route: '/setup' } },
  { page: 'setup', state: 'no-gpu', open: { scenario: 'noGpu', route: '/setup' } },
  { page: 'setup', state: 'installing', open: { scenario: 'engineInstalling', route: '/setup' } },
  { page: 'studio', state: 'empty', open: { scenario: 'ready', route: '/studio' } },
  { page: 'studio', state: 'model-missing', open: { scenario: 'engineInstalledModelMissing', route: '/studio' } },
  {
    page: 'studio', state: 'regions-and-outputs', open: { scenario: 'ready', route: '/studio' }, seed: seedStudio,
    prepare: async (page) => { await page.locator('[data-region-id="r1"]').first().click() },
  },
  {
    page: 'studio', state: 'viewer', open: { scenario: 'ready', route: '/studio' }, seed: seedStudio,
    prepare: async (page) => { await page.locator('article[data-canvas-card="c2"] footer').getByRole('button', { name: '第 2 张' }).click() },
  },
  {
    page: 'studio', state: 'assistant', open: { scenario: 'ready', route: '/studio' },
    prepare: async (page) => { await page.getByRole('button', { name: '助手', exact: true }).click() },
  },
  {
    page: 'studio', state: 'project-menu', open: { scenario: 'ready', route: '/studio' }, seed: seedStudio,
    prepare: async (page) => { await page.locator('[data-project-switcher]').click() },
  },
  { page: 'library', state: 'list', open: { scenario: 'ready', route: '/library' } },
  {
    page: 'library', state: 'detail', open: { scenario: 'ready', route: '/library' },
    prepare: async (page) => { await page.locator('[data-library-item]').first().click() },
  },
  { page: 'library', state: 'empty', open: { scenario: 'firstRun', route: '/library', settings: { onboardingState: 'completed' } } },
  { page: 'models', state: 'ready', open: { scenario: 'ready', route: '/models' } },
  { page: 'models', state: 'missing', open: { scenario: 'engineInstalledModelMissing', route: '/models' } },
  { page: 'models', state: 'partial', open: { scenario: 'modelPartiallyDownloaded', route: '/models' } },
  {
    page: 'models', state: 'lora', open: { scenario: 'ready', route: '/models' },
    prepare: async (page) => { await page.getByRole('tab', { name: 'LoRA' }).click() },
  },
  {
    page: 'models', state: 'advanced', open: { scenario: 'ready', route: '/models' },
    prepare: async (page) => {
      await page.getByRole('button', { name: /高级/ }).click()
      await page.getByText('单独的部件', { exact: true }).scrollIntoViewIfNeeded()
    },
  },
  { page: 'models', state: 'remote', open: { scenario: 'remoteHost', route: '/models', settings: { remoteHostsEnabled: true } } },
  { page: 'training', state: 'enabled', open: { scenario: 'ready', route: '/training', settings: { trainingEnabled: true } } },
  { page: 'settings', state: 'general', open: { scenario: 'ready', route: '/settings/general' } },
  { page: 'settings', state: 'devices', open: { scenario: 'ready', route: '/settings/devices' } },
  {
    page: 'settings', state: 'devices-advanced', open: { scenario: 'ready', route: '/settings/devices' },
    prepare: async (page) => { await page.getByRole('button', { name: /高级/ }).click() },
  },
  { page: 'settings', state: 'devices-remote', open: { scenario: 'remoteHost', route: '/settings/devices', settings: ALL_FEATURES } },
  { page: 'settings', state: 'storage', open: { scenario: 'ready', route: '/settings/storage' } },
  { page: 'settings', state: 'network', open: { scenario: 'ready', route: '/settings/network' } },
  { page: 'settings', state: 'features', open: { scenario: 'ready', route: '/settings/features', settings: ALL_FEATURES } },
  { page: 'settings', state: 'updates', open: { scenario: 'updateAvailable', route: '/settings/updates' } },
  { page: 'settings', state: 'about', open: { scenario: 'ready', route: '/settings/about' } },
  {
    page: 'activity', state: 'jobs', open: { scenario: 'ready', route: '/studio' }, seed: seedJobs,
    prepare: async (page) => {
      await openActivity('任务')(page)
      await page.locator('[data-job-row="job-run"] button[aria-expanded]').click()
    },
  },
  { page: 'activity', state: 'problems', open: { scenario: 'jobFailure', route: '/studio' }, prepare: openActivity('问题') },
  {
    page: 'titlebar', state: 'gpu', open: { scenario: 'ready', route: '/library' },
    prepare: async (page) => { await page.locator('[data-perf-monitor]').click() },
  },
]

async function visit(app: E2eApp, stop: Stop, options: Partial<OpenOptions>): Promise<Page> {
  const page = await app.open({ ...stop.open, ...options, defer: Boolean(stop.seed) })
  if (stop.seed) {
    await stop.seed(page)
    await app.start()
  }
  if (stop.prepare) await stop.prepare(page)
  await settle(page, 150)
  return page
}

for (const theme of ['light', 'dark'] as const) {
  describe(`visual rules (${theme})`, () => {
    const app = useApp()
    for (const stop of STOPS) {
      it(`${stop.page} · ${stop.state}`, async () => {
        const page = await visit(app, stop, { theme })
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
        await app.screenshot(`${stop.page}-${stop.state}-${theme}`)
        const clipped = await clippedText(page)
        if (clipped.length) console.warn(`${stop.page}-${stop.state}-${theme}: text cut off without an ellipsis\n  ${clipped.join('\n  ')}`)
        // Every channel the page used is one the main process answers.
        expect(await page.evaluate(() => [...new Set(window.__mock.backend.unhandled)])).toEqual([])
        await expectVisualRules(page, `${stop.page} · ${stop.state} · ${theme}`)
      })
    }
  })
}

describe('no horizontal overflow at the window sizes we support', () => {
  const app = useApp()
  for (const size of [{ width: 1280, height: 760 }, { width: 1600, height: 1000 }]) {
    for (const stop of STOPS) {
      it(`${size.width}×${size.height} ${stop.page} · ${stop.state}`, async () => {
        const page = await visit(app, stop, { theme: 'dark', size })
        const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, width: window.innerWidth }))
        expect(overflow.doc).toBeLessThanOrEqual(overflow.width)
        expect(overflow.body).toBeLessThanOrEqual(overflow.width)
        if (size.width === 1280) await app.screenshot(`${stop.page}-${stop.state}-dark-1280x760`)
        expect((await audit(page)).filter((item) => item.rule === 'overflow')).toEqual([])
      })
    }
  }
})

describe('the audit itself', () => {
  const app = useApp()

  it('catches each kind of violation it is meant to catch', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/about', theme: 'dark' })
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'audit-probe'
      host.style.cssText = 'position:fixed;left:0;top:0;width:900px;background:var(--surface);z-index:999'
      host.innerHTML = `
        <div id="p-border" style="border:1px solid rgb(255 255 255 / 0.1);height:10px"></div>
        <div id="p-ring" style="box-shadow:0 0 0 1px rgb(255 255 255 / 0.08);height:10px"></div>
        <hr id="p-hr" style="border:0;height:1px;background:var(--well)">
        <span id="p-sky" style="color:rgb(125 211 252)">old sky text</span>
        <div id="p-overlay" style="background:rgb(255 255 255 / 0.03);height:10px"></div>
        <span id="p-contrast" style="color:var(--ink-2);background:var(--ink)">hard to read</span>
        <span id="p-out" style="position:fixed;left:1500px;top:0;white-space:nowrap;color:var(--ink)">sticks out of the window on purpose</span>`
      document.body.appendChild(host)
    })
    const found = await audit(page)
    const by = (rule: string, id: string) => found.some((item) => item.rule === rule && item.element.includes(`#${id}`))
    expect(by('border', 'p-border')).toBe(true)
    expect(by('border', 'p-ring')).toBe(true)
    expect(by('hr', 'p-hr')).toBe(true)
    expect(by('palette', 'p-sky')).toBe(true)
    expect(by('palette', 'p-overlay')).toBe(true)
    expect(by('contrast', 'p-contrast')).toBe(true)
    expect(by('overflow', 'p-out')).toBe(true)
    // ...and nothing else on the page.
    expect(found.filter((item) => !item.element.includes('#p-'))).toEqual([])
  })
})
