/**
 * Launching and steering the E2E app from a spec.
 *
 *   const app = useApp()                       // in a describe: one Electron for the file
 *   const page = await app.open({ scenario: 'ready', route: '/studio' })
 *   await app.calls('settings:update')        // what the renderer sent the "main process"
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, inject } from 'vitest'
import type { Settings } from '@shared/types'
import type { ScenarioName } from '../../test/mocks/backend/scenarios'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as unknown as string

export type Theme = 'light' | 'dark'

export interface OpenOptions {
  scenario?: ScenarioName
  route?: string
  theme?: Settings['theme']
  platform?: string
  settings?: Partial<Settings>
  /** Wait for `__mock.start()` (call `app.start(page)` after preparing state). */
  defer?: boolean
  size?: { width: number; height: number }
}

export const SHOTS_DIR = resolve(process.env['E2E_SHOTS_DIR'] ?? join(tmpdir(), 'mossstudio-e2e-shots'))

export interface E2eApp {
  electron: ElectronApplication
  page: Page
  open(options?: OpenOptions): Promise<Page>
  start(): Promise<void>
  resize(width: number, height: number): Promise<void>
  calls<T = unknown>(channel: string): Promise<T[]>
  screenshot(name: string): Promise<string>
}

async function launch(): Promise<{ electron: ElectronApplication; page: Page }> {
  const appDir = inject('e2eAppDir')
  const env = { ...process.env } as Record<string, string>
  delete env['ELECTRON_RUN_AS_NODE']
  // Stay on the X display (xvfb) even inside a Wayland session, where the
  // compositor would place and resize the window on the real screen.
  delete env['WAYLAND_DISPLAY']
  const electron = await _electron.launch({
    executablePath: electronPath,
    args: [resolve(import.meta.dirname, '../electron/main.cjs'), `--e2e-app=${appDir}`, '--no-sandbox', ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])],
    env,
    timeout: 60_000,
  })
  const page = await electron.firstWindow()
  // A missing element should fail the step quickly with Playwright's message, not the test timeout.
  page.setDefaultTimeout(8_000)
  page.on('pageerror', (error) => { console.error(`[renderer] ${error.stack ?? error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[renderer console] ${message.text()}`)
  })
  return { electron, page }
}

export async function setWindowSize(electron: ElectronApplication, width: number, height: number): Promise<void> {
  await electron.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setMinimumSize(1, 1)
    win.setContentSize(size.width, size.height)
  }, { width, height })
}

/** One Electron app for the enclosing describe/file. */
export function useApp(): E2eApp {
  const handle = {} as E2eApp
  beforeAll(async () => {
    const { electron, page } = await launch()
    const appDir = inject('e2eAppDir')
    mkdirSync(SHOTS_DIR, { recursive: true })
    let current = { width: 1600, height: 1000 }
    Object.assign(handle, {
      electron,
      page,
      async resize(width: number, height: number) {
        current = { width, height }
        await setWindowSize(electron, width, height)
        await page.waitForFunction((size) => window.innerWidth === size.width && window.innerHeight === size.height, { width, height })
      },
      async open(options: OpenOptions = {}) {
        const size = options.size ?? { width: 1600, height: 1000 }
        if (size.width !== current.width || size.height !== current.height) await handle.resize(size.width, size.height)
        const query = new URLSearchParams()
        query.set('scenario', options.scenario ?? 'ready')
        if (options.theme) query.set('theme', options.theme)
        if (options.platform) query.set('platform', options.platform)
        if (options.settings) query.set('settings', JSON.stringify(options.settings))
        if (options.defer) query.set('defer', '1')
        const url = `${pathToFileURL(join(appDir, 'index.html')).href}?${query}#${options.route ?? '/studio'}`
        // A hash-only change would not reload; go through about:blank so every open is a fresh app.
        await page.goto('about:blank')
        await page.goto(url)
        await page.waitForFunction(() => Boolean(window.__mock))
        if (!options.defer) await waitForApp(page)
        return page
      },
      async start() {
        await page.evaluate(() => window.__mock.start())
        await waitForApp(page)
      },
      async calls<T>(channel: string) {
        return page.evaluate((name) => window.__mock.callsTo(name), channel) as Promise<T[]>
      },
      async screenshot(name: string) {
        const file = join(SHOTS_DIR, `${name}.png`)
        await settle(page)
        await page.screenshot({ path: file })
        return file
      },
    })
  })
  afterEach(async (context) => {
    if (context.task.result?.state !== 'fail' || !handle.page) return
    // Leave evidence: what the window showed and what the app said.
    const name = `FAILED-${context.task.name.replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 80)}`
    await handle.page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) }).catch(() => undefined)
    const said = await handle.page.evaluate(() => [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')]
      .map((element) => element.textContent?.trim()).filter(Boolean)).catch(() => [])
    console.error(`${name}: screenshot saved; live regions: ${JSON.stringify(said)}`)
  })
  afterAll(async () => {
    await handle.electron?.close()
  })
  return handle
}

/** The shell rendered and the store finished its first load. */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    // The setup and uninstall windows (data-standalone) never load settings.
    const loaded = window.__mock.calls.some((call) => call.channel === 'settings:get') || Boolean(document.querySelector('[data-standalone]'))
    return Boolean(root && root.children.length > 0 && loaded)
  })
  await settle(page)
}

/** Let React effects, promise chains and two frames run. */
export async function settle(page: Page, ms = 60): Promise<void> {
  await page.evaluate(async (delay) => {
    await new Promise((resolve) => setTimeout(resolve, delay))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, ms)
}
