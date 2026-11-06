/**
 * The setup window (#/install) and the uninstall window (#/uninstall) against the
 * mock install backend (test/mocks/backend/install.ts), at the real 640×480 size:
 * first install, old-install import, every folder problem, later installs with no
 * questions, the downgrade question, a failure with 重试, macOS 数据位置 and
 * 推出安装盘, uninstall with and without data, and 设置 › 关于 › 卸载.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { SetupLocationCheck } from '@shared/setup'
import { useApp, type E2eApp, type Theme } from '../support/app'
import { expectVisualRules } from '../support/visual'

const SIZE = { width: 640, height: 480 }
const ROOT = 'C:\\Users\\张 三\\AppData\\Local\\Programs\\MossStudio'

type InstallSeed = (page: Page) => Promise<void>

async function openSetup(app: E2eApp, seed: InstallSeed, options: { route?: '/install' | '/uninstall'; theme?: Theme; platform?: string } = {}): Promise<Page> {
  await app.page.emulateMedia({ colorScheme: options.theme ?? 'light' })
  const page = await app.open({ route: options.route ?? '/install', size: SIZE, defer: true, platform: options.platform })
  await seed(page)
  await app.start()
  return page
}

/** Seed `state.install` from a named setup scenario, holding the run so a test can play it. */
const scenario = (name: string, patch: Record<string, unknown> = {}): InstallSeed => async (page) => {
  await page.evaluate(([setupName, extra]) => {
    const { installStateFixture, setupScenario } = window.__mock.installFixtures
    window.__mock.state.install = installStateFixture({ setup: setupScenario(setupName as never), outcome: 'hold', ...(extra as object) })
  }, [name, patch] as const)
}

const screen = (page: Page): Promise<string | null> => page.locator('[data-setup-screen]').getAttribute('data-setup-screen')
const install = (page: Page) => page.evaluate(() => window.__mock.state.install)
const installButton = (page: Page) => page.getByRole('button', { name: '安装', exact: true })

async function emitProgress(page: Page, phase: string, percent: number): Promise<void> {
  await page.evaluate(([step, value]) => {
    const total = window.__mock.state.install.setup.requiredBytes
    window.__mock.emit(window.__mock.Events.installProgress, { phase: step, percent: value, copiedBytes: Math.round((total * (value as number)) / 100), totalBytes: total })
  }, [phase, percent] as const)
}

async function emitDone(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { setup } = window.__mock.state.install
    const result = { root: setup.location.path, dataRoot: `${setup.location.path}\\data`, version: setup.version, appPath: `${setup.location.path}\\app-${setup.version}`, warnings: [] }
    window.__mock.state.install.setup = { ...setup, phase: 'done', result }
    window.__mock.emit(window.__mock.Events.installDone, result)
  })
}

/** Make `path` check with a problem; the next 更改… picks it. */
async function pickProblem(page: Page, path: string, check: Partial<SetupLocationCheck>): Promise<void> {
  await page.evaluate(([folder, patch]) => {
    const { locationCheckFixture } = window.__mock.installFixtures
    window.__mock.state.install.checks[folder as string] = locationCheckFixture({ path: folder as string, ...(patch as object) })
    window.__mock.state.install.folderChoice = { purpose: 'install', path: folder as string }
  }, [path, check] as const)
  await page.getByRole('region', { name: '安装位置' }).getByRole('button', { name: '更改…' }).click()
}

describe('setup window: first install', () => {
  const app = useApp()

  it('asks where, then shows progress, then opens the installed app', async () => {
    const page = await openSetup(app, scenario('first'))
    expect(await screen(page)).toBe('choose')
    expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe('安装 MossStudio')
    const location = page.getByRole('region', { name: '安装位置' })
    expect(await location.locator('[data-path]').textContent()).toBe(ROOT)
    expect(await location.getByText('需要 412 MB · 可用 120 GB').isVisible()).toBe(true)
    // Nothing found on the machine: no old-install card, no 数据位置 (Windows).
    expect(await page.locator('[data-legacy-card]').count()).toBe(0)
    expect(await page.getByRole('button', { name: /数据位置/ }).count()).toBe(0)
    // One primary action, the close button in our own frame.
    expect(await installButton(page).isEnabled()).toBe(true)
    expect(await page.getByRole('button', { name: '关闭' }).isEnabled()).toBe(true)

    await installButton(page).click()
    await expect.poll(() => install(page).then((state) => state.starts)).toEqual([{ root: ROOT }])
    await expect.poll(() => screen(page)).toBe('progress')
    expect(await page.getByRole('button', { name: '关闭' }).isDisabled()).toBe(true)
    await emitProgress(page, 'copy', 45)
    await expect.poll(() => page.getByRole('status').getByText('正在复制文件…').isVisible()).toBe(true)
    expect(await page.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('45')
    await emitProgress(page, 'integrate', 96)
    await expect.poll(() => page.getByRole('status').getByText('正在创建快捷方式…').isVisible()).toBe(true)
    await emitDone(page)
    await expect.poll(() => screen(page)).toBe('done')
    expect(await page.getByText('正在打开 MossStudio…').isVisible()).toBe(true)
    // Done opens the installed app by itself.
    await expect.poll(() => install(page).then((state) => state.launched), { timeout: 4000 }).toEqual({ eject: false })
  })

  it('plays a whole install from the mock and lands on done', async () => {
    const page = await openSetup(app, scenario('first', { outcome: 'success' }))
    await installButton(page).click()
    await expect.poll(() => screen(page)).toBe('done')
  })
})

describe('setup window: old 1.0.x install', () => {
  const app = useApp()

  it('offers 继续使用这些数据（不复制） by default, with the size', async () => {
    const page = await openSetup(app, scenario('legacy'))
    const card = page.locator('[data-legacy-card]')
    expect(await card.getByText('发现旧版 MossStudio 1.0.3').isVisible()).toBe(true)
    expect(await card.getByText(/位于 D:\\Apps\\MossStudio，里面有你的作品、模型和设置，共 38 GB。/).isVisible()).toBe(true)
    // reuse keeps using the old data\: the note must say NOT to delete the old folder.
    const note = await card.locator('[data-legacy-warning="reuse"]').textContent()
    expect(note).toContain('会从“设置 › 应用”的列表里消失')
    expect(note).toContain('请不要删除这个文件夹')
    expect(note).not.toContain('可以手动删除')
    const reuse = card.getByRole('radio', { name: /继续使用这些数据（不复制）/ })
    expect(await reuse.getAttribute('aria-checked')).toBe('true')
    await installButton(page).click()
    await expect.poll(() => install(page).then((state) => state.starts)).toEqual([{ root: 'D:\\MossStudio', legacy: { root: 'D:\\Apps\\MossStudio', mode: 'reuse' } }])
  })

  it('重新开始 starts fresh and leaves the old data alone', async () => {
    const page = await openSetup(app, scenario('legacy'))
    await page.getByRole('radio', { name: /重新开始/ }).click()
    expect(await page.getByRole('radio', { name: /重新开始/ }).getAttribute('aria-checked')).toBe('true')
    const note = await page.locator('[data-legacy-warning="fresh"]').textContent()
    expect(note).toContain('不再需要时可以手动删除这个文件夹')
    expect(note).not.toContain('请不要删除')
    await installButton(page).click()
    await expect.poll(() => install(page).then((state) => state.starts[0]?.legacy)).toEqual({ root: 'D:\\Apps\\MossStudio', mode: 'fresh' })
  })

  it('installing into the old folder converts it in place, with no choice to make', async () => {
    const page = await openSetup(app, scenario('legacyInPlace'))
    const card = page.locator('[data-legacy-card]')
    expect(await card.getByText(/旧的程序文件会被替换，作品、模型和设置原地保留/).isVisible()).toBe(true)
    expect(await card.getByRole('radio').count()).toBe(0)
    expect(await card.locator('[data-legacy-warning]').count()).toBe(0)
  })

  it('has no 设置 › 应用 takeover note where there is nothing to take over (Linux), but still says not to delete reused data', async () => {
    const page = await openSetup(app, async (p) => {
      await scenario('legacy')(p)
      await p.evaluate(() => {
        const { setup } = window.__mock.state.install
        const fixtures = window.__mock.installFixtures
        window.__mock.state.install.setup = { ...setup, legacy: fixtures.legacyInstallFixture({ ...setup.legacy!, warnings: fixtures.legacyWarningsFixture(setup.legacy!.root, 'linux') }) }
      })
    })
    const note = await page.locator('[data-legacy-warning="reuse"]').textContent()
    expect(note).not.toContain('设置 › 应用')
    expect(note).toContain('请不要删除这个文件夹')
  })

  it('finds an old install the user points to (高级)', async () => {
    const page = await openSetup(app, async (p) => {
      await scenario('first')(p)
      await p.evaluate(() => {
        const { legacyInstallFixture } = window.__mock.installFixtures
        window.__mock.state.install.legacyAt['E:\\旧版\\MossStudio'] = legacyInstallFixture({ root: 'E:\\旧版\\MossStudio', dataDir: 'E:\\旧版\\MossStudio\\data', dataBytes: 2 * 1024 ** 3, source: 'picked' })
        window.__mock.state.install.folderChoice = { purpose: 'legacy', path: 'E:\\空文件夹' }
      })
    })
    await page.getByRole('button', { name: /高级/ }).click()
    await page.getByRole('button', { name: '选择文件夹…' }).click()
    await expect.poll(() => page.getByRole('alert').filter({ hasText: '这个文件夹里没有旧版 MossStudio' }).isVisible()).toBe(true)
    await page.evaluate(() => { window.__mock.state.install.folderChoice = { purpose: 'legacy', path: 'E:\\旧版\\MossStudio' } })
    await page.getByRole('button', { name: '选择文件夹…' }).click()
    await expect.poll(() => page.locator('[data-legacy-card]').getByText(/共 2\.0 GB/).isVisible()).toBe(true)
    await installButton(page).click()
    await expect.poll(() => install(page).then((state) => state.starts[0]?.legacy)).toEqual({ root: 'E:\\旧版\\MossStudio', mode: 'reuse' })
  })
})

describe('setup window: data kept by an uninstall', () => {
  const app = useApp()

  it('offers to keep using it, by default, when installing somewhere else', async () => {
    const page = await openSetup(app, scenario('keptData'))
    const card = page.locator('[data-legacy-card]')
    expect(await card.getAttribute('aria-label')).toBe('保留的数据')
    expect(await card.getByText('发现上次保留的数据').isVisible()).toBe(true)
    expect(await card.getByText(`卸载 MossStudio 1.9.0 时留下的作品、模型和设置，位于 ${ROOT}\\data，共 12 GB。`).isVisible()).toBe(true)
    const reuse = card.getByRole('radio', { name: /继续使用这些数据（不复制）/ })
    expect(await reuse.getAttribute('aria-checked')).toBe('true')
    const note = await card.locator('[data-legacy-warning="reuse"]').textContent()
    expect(note).toContain('请不要删除这个文件夹')
    expect(note).not.toContain('设置 › 应用')
    await installButton(page).click()
    await expect.poll(() => install(page).then((state) => state.starts)).toEqual([{ root: 'D:\\MossStudio', legacy: { root: ROOT, mode: 'reuse' } }])
  })

  it('重新开始 leaves the kept data where it is', async () => {
    const page = await openSetup(app, scenario('keptData'))
    await page.getByRole('radio', { name: /重新开始/ }).click()
    expect(await page.locator('[data-legacy-warning="fresh"]').textContent()).toBe(`这些数据仍留在 ${ROOT}\\data，不会被删除；不再需要时可以手动删除这个文件夹。`)
    await installButton(page).click()
    await expect.poll(() => install(page).then((state) => state.starts[0]?.legacy)).toEqual({ root: ROOT, mode: 'fresh' })
  })

  it('installing into the folder it was left in just keeps using it, with no choice to make', async () => {
    const page = await openSetup(app, scenario('keptDataInPlace'))
    const card = page.locator('[data-legacy-card]')
    expect(await card.getByText('装在原来的文件夹里：会继续使用这些作品、模型和设置。').isVisible()).toBe(true)
    expect(await card.getByRole('radio').count()).toBe(0)
    expect(await page.locator('[data-folder-note]').count()).toBe(0)
    expect(await installButton(page).isEnabled()).toBe(true)
  })

  it('a chosen folder that holds kept data is accepted, and says it will be used', async () => {
    const page = await openSetup(app, scenario('first'))
    await pickProblem(page, 'E:\\MossStudio', { kind: 'data' })
    await expect.poll(() => page.locator('[data-folder-note]').textContent()).toBe('这个文件夹里有上次卸载时保留的作品、模型和设置，装好后会继续使用它们。')
    expect(await page.getByRole('alert').count()).toBe(0)
    await installButton(page).click()
    await expect.poll(() => install(page).then((state) => state.starts)).toEqual([{ root: 'E:\\MossStudio' }])
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`screenshot: kept data found (${theme})`, async () => {
      const page = await openSetup(app, scenario('keptData'), { theme })
      await expect.poll(() => page.locator('[data-legacy-card]').isVisible()).toBe(true)
      await app.screenshot(`setup-kept-data-${theme}`)
      await expectVisualRules(page, `setup kept data (${theme})`)
    })
  }
})

describe('setup window: folder problems', () => {
  const app = useApp()

  it('a non-empty folder offers <chosen>\\MossStudio instead', async () => {
    const page = await openSetup(app, scenario('first'))
    await pickProblem(page, 'D:\\Data', { ok: false, kind: 'occupied', problem: { code: 'E_NOT_EMPTY', message: '这个文件夹里已经有其他文件。' }, suggestion: 'D:\\Data\\MossStudio' })
    const alert = page.getByRole('alert')
    await expect.poll(() => alert.getByText(/已经有别的文件/).isVisible()).toBe(true)
    expect(await installButton(page).isDisabled()).toBe(true)
    await alert.getByRole('button', { name: '改用 D:\\Data\\MossStudio' }).click()
    await expect.poll(() => page.getByRole('region', { name: '安装位置' }).locator('[data-path]').textContent()).toBe('D:\\Data\\MossStudio')
    expect(await app.calls('install:validate')).toEqual([{ path: 'D:\\Data\\MossStudio', purpose: 'install' }])
    await expect.poll(() => installButton(page).isEnabled()).toBe(true)
    expect(await page.getByRole('alert').count()).toBe(0)
  })

  for (const [name, check, text] of [
    ['no write access', { ok: false, problem: { code: 'E_NOT_WRITABLE', message: '没有写入这个文件夹的权限。' } }, '没有权限写入这个文件夹。请换一个位置，例如你自己的用户文件夹。'],
    ['not enough space', { ok: false, freeBytes: 100 * 1024 ** 2, problem: { code: 'E_NO_SPACE', message: '磁盘空间不足。' } }, '这个磁盘的空间不够：需要 412 MB，只剩 100 MB。请清理一些空间，或换一个磁盘。'],
    ['a system folder', { ok: false, problem: { code: 'E_SYSTEM_DIR', message: '这是系统文件夹，不能安装到这里。' } }, '不能装在系统文件夹或磁盘根目录，请换一个位置。'],
    ['a drive root', { ok: false, problem: { code: 'E_DRIVE_ROOT', message: '不能直接装在磁盘根目录。' }, suggestion: 'E:\\MossStudio' }, '不能装在系统文件夹或磁盘根目录。'],
  ] as const) {
    it(`refuses ${name} and says what to do`, async () => {
      const page = await openSetup(app, scenario('first'))
      await pickProblem(page, 'E:\\', check as Partial<SetupLocationCheck>)
      await expect.poll(() => page.getByRole('alert').textContent()).toContain(text)
      expect(await installButton(page).isDisabled()).toBe(true)
      if ('suggestion' in check) expect(await page.getByRole('button', { name: '改用 E:\\MossStudio' }).isVisible()).toBe(true)
    })
  }

  it('says so right away when the default location has no space', async () => {
    const page = await openSetup(app, scenario('noSpace'))
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('只剩 100 MB')
    expect(await installButton(page).isDisabled()).toBe(true)
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`screenshot: a folder problem (${theme})`, async () => {
      const page = await openSetup(app, scenario('first'), { theme })
      await pickProblem(page, 'D:\\Data', { ok: false, kind: 'occupied', problem: { code: 'E_NOT_EMPTY', message: '' }, suggestion: 'D:\\Data\\MossStudio' })
      await expect.poll(() => page.getByRole('alert').isVisible()).toBe(true)
      await app.screenshot(`install-folder-problem-${theme}`)
      await expectVisualRules(page, `install folder problem (${theme})`)
    })
  }
})

describe('setup window: later installs', () => {
  const app = useApp()

  for (const kind of ['update', 'repair'] as const) {
    it(`${kind}: no questions, straight to progress`, async () => {
      const page = await openSetup(app, scenario(kind))
      await expect.poll(() => install(page).then((state) => state.starts)).toEqual([{ root: ROOT }])
      expect(await screen(page)).toBe('progress')
      expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe(kind === 'update' ? '正在安装 MossStudio 2.0.0' : '正在修复 MossStudio')
      expect(await installButton(page).count()).toBe(0)
      expect(await page.getByRole('region', { name: '安装位置' }).count()).toBe(0)
    })
  }

  it('downgrade: asks once; 保留 closes without changing anything', async () => {
    const page = await openSetup(app, scenario('downgrade'))
    expect(await screen(page)).toBe('downgrade')
    expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe('换成较早的 2.0.0？')
    expect(await page.getByText(/已经装有更新的 MossStudio 2\.1\.0/).isVisible()).toBe(true)
    await page.getByRole('button', { name: '保留 2.1.0' }).click()
    await expect.poll(() => install(page).then((state) => state.quit)).toBe(true)
    expect((await install(page)).starts).toEqual([])
  })

  it('downgrade: 换成 installs with the confirmation', async () => {
    const page = await openSetup(app, scenario('downgrade'))
    await page.getByRole('button', { name: '换成 2.0.0' }).click()
    await expect.poll(() => install(page).then((state) => state.starts)).toEqual([{ root: ROOT, allowDowngrade: true }])
    await expect.poll(() => screen(page)).toBe('progress')
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`screenshot: progress (${theme})`, async () => {
      const page = await openSetup(app, scenario('update'), { theme })
      await emitProgress(page, 'copy', 62)
      await expect.poll(() => page.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('62')
      await app.screenshot(`install-progress-${theme}`)
      await expectVisualRules(page, `install progress (${theme})`)
    })
  }
})

describe('setup window: failure and macOS', () => {
  const app = useApp()

  it('a failed install says why, and 重试 runs it again', async () => {
    const page = await openSetup(app, scenario('first', { outcome: 'failure' }))
    await installButton(page).click()
    await expect.poll(() => screen(page)).toBe('failed')
    expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe('安装没有完成')
    expect(await page.getByRole('alert').textContent()).toContain('app-2.0.0 正在使用。请先退出 MossStudio，再继续安装。')
    await page.getByRole('button', { name: '查看日志' }).click()
    await expect.poll(() => app.calls('install:open-log')).toEqual([{ log: 'setup' }])
    await app.screenshot('install-failed-light')
    await expectVisualRules(page, 'install failed')
    await page.evaluate(() => { window.__mock.state.install.outcome = 'success' })
    await page.getByRole('button', { name: '重试' }).click()
    await expect.poll(() => screen(page)).toBe('done')
    expect((await install(page)).starts).toHaveLength(2)
  })

  it('a start the main process refuses also lands on the failure screen', async () => {
    const page = await openSetup(app, async (p) => {
      await scenario('first')(p)
      await p.evaluate(() => { window.__mock.fail(window.__mock.Ipc.installStart, { code: 'E_COPY', message: '复制文件时出错：磁盘已满。' }, { times: 1 }) })
    })
    await installButton(page).click()
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('复制文件时出错：磁盘已满。')
  })

  it('macOS: 数据位置 under 高级, our close button gives way to the traffic lights, 推出安装盘 after opening', async () => {
    const page = await openSetup(app, scenario('macDmg', { outcome: 'success' }), { platform: 'darwin' })
    expect(await page.getByRole('button', { name: '关闭' }).count()).toBe(0)
    expect(await page.getByRole('region', { name: '数据位置' }).count()).toBe(0)
    await page.getByRole('button', { name: /高级/ }).click()
    const data = page.getByRole('region', { name: '数据位置' })
    expect(await data.locator('[data-path]').textContent()).toBe('/Users/zhang/Library/Application Support/MossStudio')
    await page.evaluate(() => { window.__mock.state.install.folderChoice = { purpose: 'data', path: '/Volumes/作品/MossStudio' } })
    await data.getByRole('button', { name: '更改…' }).click()
    await expect.poll(() => data.locator('[data-path]').textContent()).toBe('/Volumes/作品/MossStudio')
    await installButton(page).click()
    await expect.poll(() => install(page).then((state) => state.starts)).toEqual([{ root: '/Applications', dataRoot: '/Volumes/作品/MossStudio' }])
    await expect.poll(() => screen(page)).toBe('done')
    const eject = page.getByRole('checkbox', { name: '打开后推出安装盘' })
    expect(await eject.getAttribute('aria-checked')).toBe('true')
    // Waits for the click instead of opening by itself.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect((await install(page)).launched).toBeNull()
    await page.getByRole('button', { name: '打开 MossStudio' }).click()
    await expect.poll(() => install(page).then((state) => state.launched)).toEqual({ eject: true })
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`screenshot: first install with an old install found (${theme})`, async () => {
      const page = await openSetup(app, scenario('legacy'), { theme })
      await expect.poll(() => page.locator('[data-legacy-card]').isVisible()).toBe(true)
      await app.screenshot(`install-${theme}`)
      await expectVisualRules(page, `install (${theme})`)
    })
  }
})

describe('uninstall window', () => {
  const app = useApp()
  const seed = (patch: Record<string, unknown> = {}): InstallSeed => async (page) => {
    await page.evaluate((extra) => {
      const { installStateFixture, uninstallInfoFixture } = window.__mock.installFixtures
      window.__mock.state.install = installStateFixture({ uninstall: uninstallInfoFixture(extra as object) })
    }, patch)
  }
  const uninstall = (page: Page) => page.getByRole('button', { name: '卸载', exact: true })

  it('keeps the data unless asked, then uninstalls', async () => {
    const page = await openSetup(app, seed(), { route: '/uninstall' })
    expect(await page.locator('[data-uninstall-screen]').getAttribute('data-uninstall-screen')).toBe('confirm')
    expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe('卸载 MossStudio')
    const data = page.getByRole('checkbox', { name: '同时删除我的数据（作品、模型、设置）' })
    expect(await data.getAttribute('aria-checked')).toBe('false')
    expect(await page.getByText(/共 38 GB，位于 C:\\Users\\张 三/).isVisible()).toBe(true)
    expect(await page.getByText('你的作品、模型和设置会保留。', { exact: false }).isVisible()).toBe(true)
    await uninstall(page).click()
    await expect.poll(() => install(page).then((state) => state.uninstallStarted)).toEqual({ removeData: false })
    await expect.poll(() => page.locator('[data-uninstall-screen]').getAttribute('data-uninstall-screen')).toBe('progress')
    expect(await page.getByRole('button', { name: '关闭' }).isDisabled()).toBe(true)
  })

  it('removes the data too when ticked, after saying it cannot be undone', async () => {
    const page = await openSetup(app, seed(), { route: '/uninstall' })
    await page.getByRole('checkbox', { name: '同时删除我的数据（作品、模型、设置）' }).click()
    await expect.poll(() => page.getByText('作品、模型和设置会被永久删除，无法恢复。需要的话请先备份。').isVisible()).toBe(true)
    await uninstall(page).click()
    await expect.poll(() => install(page).then((state) => state.uninstallStarted)).toEqual({ removeData: true })
  })

  it('取消 closes without uninstalling; a refused start can be retried', async () => {
    let page = await openSetup(app, seed(), { route: '/uninstall' })
    await page.getByRole('button', { name: '取消' }).click()
    await expect.poll(() => install(page).then((state) => state.quit)).toBe(true)
    expect((await install(page)).uninstallStarted).toBeNull()

    page = await openSetup(app, async (p) => {
      await seed()(p)
      await p.evaluate(() => { window.__mock.fail(window.__mock.Ipc.uninstallStart, { code: 'E_PLAN', message: '没能写入卸载计划。' }, { times: 1 }) })
    }, { route: '/uninstall' })
    await uninstall(page).click()
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('没能写入卸载计划。')
    await page.getByRole('button', { name: '重试' }).click()
    await expect.poll(() => install(page).then((state) => state.uninstallStarted)).toEqual({ removeData: false })
  })

  it('says when MossStudio is still open, and 重试 works once it has been closed', async () => {
    const page = await openSetup(app, seed({ running: true }), { route: '/uninstall' })
    expect(await page.locator('[data-app-running]').textContent()).toContain('请在它弹出的对话框里关闭它')
    await uninstall(page).click()
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('MossStudio 正在运行')
    expect((await install(page)).uninstallStarted).toBeNull()
    await page.evaluate(() => { window.__mock.state.install.uninstall = { ...window.__mock.state.install.uninstall, running: false } })
    await page.getByRole('button', { name: '重试' }).click()
    await expect.poll(() => install(page).then((state) => state.uninstallStarted)).toEqual({ removeData: false })
  })

  it('setup over a running install fails with the reason, and 重试 goes through once it is closed', async () => {
    const page = await openSetup(app, async (p) => {
      await p.evaluate(() => {
        const { installStateFixture, setupScenario } = window.__mock.installFixtures
        window.__mock.state.install = installStateFixture({ setup: setupScenario('update'), appRunning: true })
      })
    }, { route: '/install' })
    await expect.poll(() => screen(page)).toBe('failed')
    expect(await page.getByRole('alert').textContent()).toContain('MossStudio 正在运行')
    await page.evaluate(() => { window.__mock.state.install.appRunning = false })
    await page.getByRole('button', { name: '重试' }).click()
    await expect.poll(() => screen(page)).toBe('done')
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`screenshot (${theme})`, async () => {
      const page = await openSetup(app, seed(), { route: '/uninstall', theme })
      await page.getByRole('checkbox', { name: '同时删除我的数据（作品、模型、设置）' }).click()
      await app.screenshot(`uninstall-${theme}`)
      await expectVisualRules(page, `uninstall (${theme})`)
    })
  }
})

describe('设置 › 关于 › 卸载', () => {
  const app = useApp()

  async function about(platform: string, patch: Record<string, unknown> | null): Promise<Page> {
    await app.page.emulateMedia({ colorScheme: 'light' })
    const page = await app.open({ route: '/settings/about', platform, theme: 'light', defer: true })
    await page.evaluate(([os, extra]) => {
      const { installStateFixture, uninstallInfoFixture } = window.__mock.installFixtures
      window.__mock.state.install = installStateFixture({ uninstall: uninstallInfoFixture({ platform: os as never, ...(extra as object) }) })
      if (extra === null) window.__mock.fail(window.__mock.Ipc.uninstallInfo, { code: 'E_NOT_INSTALLED', message: '不是安装版' })
    }, [platform, patch] as const)
    await app.start()
    return page
  }

  it('Linux: asks the same question in a dialog and uninstalls', async () => {
    const page = await about('linux', {})
    await page.getByRole('button', { name: '卸载…' }).click()
    const dialog = page.getByRole('dialog', { name: '卸载 MossStudio' })
    await expect.poll(() => dialog.isVisible()).toBe(true)
    const data = dialog.getByRole('checkbox', { name: '同时删除我的数据（作品、模型、设置）' })
    expect(await data.getAttribute('aria-checked')).toBe('false')
    await data.click()
    await app.screenshot('settings-about-uninstall-light')
    await dialog.getByRole('button', { name: '卸载', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__mock.state.install.uninstallStarted)).toEqual({ removeData: true })
  })

  it('macOS: moves to the Trash', async () => {
    const page = await about('darwin', { method: 'trash' })
    await page.getByRole('button', { name: '卸载…' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: '卸载 MossStudio' }).getByText(/MossStudio 会被移到废纸篓/).isVisible()).toBe(true)
  })

  it('Windows: uninstalls from here too', async () => {
    const page = await about('win32', {})
    await page.getByRole('button', { name: '卸载…' }).click()
    const dialog = page.getByRole('dialog', { name: '卸载 MossStudio' })
    await dialog.getByRole('button', { name: '卸载', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__mock.state.install.uninstallStarted)).toEqual({ removeData: false })
  })

  it('portable: says to delete the folder; dev: no row at all', async () => {
    let page = await about('linux', { portable: true })
    await expect.poll(() => page.getByText(/这是便携版/).isVisible()).toBe(true)
    page = await about('linux', null)
    await expect.poll(() => page.getByText('QQ 交流群').isVisible()).toBe(true)
    expect(await page.getByText('卸载 MossStudio').count()).toBe(0)
  })
})
