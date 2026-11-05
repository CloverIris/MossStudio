/**
 * 设置: every section by URL, changes save without a Save button, the theme
 * switch, and 功能 toggles that add or remove whole areas of the app.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp } from '../support/app'

const SECTIONS = [
  ['general', '通用'],
  ['devices', '设备与引擎'],
  ['storage', '存储'],
  ['network', '网络'],
  ['features', '功能'],
  ['updates', '通知与更新'],
  ['about', '关于'],
] as const

const hash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash)
const theme = (page: Page): Promise<string | undefined> => page.evaluate(() => document.documentElement.dataset.theme)

describe('settings', () => {
  const app = useApp()

  it('opens every section from its URL, and old section names land on the new ones', async () => {
    for (const [id, label] of SECTIONS) {
      const page = await app.open({ route: `/settings/${id}` })
      await expect.poll(() => page.getByRole('heading', { level: 1, name: label }).isVisible()).toBe(true)
      const current = page.getByRole('navigation', { name: '设置分区' }).locator('[aria-current="page"]')
      expect(await current.textContent()).toBe(label)
      expect(await page.getByRole('button', { name: /^保存$/ }).count()).toBe(0)
    }
    for (const [alias, target] of [['/settings', '/settings/general'], ['/settings/engines', '/settings/devices'], ['/settings/lan', '/settings/features']] as const) {
      const page = await app.open({ route: alias })
      await expect.poll(() => hash(page)).toBe(`#${target}`)
    }
  })

  it('switches theme immediately and saves it', async () => {
    const page = await app.open({ route: '/settings/general', theme: 'light' })
    expect(await theme(page)).toBe('light')
    const picker = page.getByRole('group', { name: '主题' })
    await picker.getByRole('button', { name: '深色' }).click()
    await expect.poll(() => theme(page)).toBe('dark')
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ theme: 'dark' })
    await picker.getByRole('button', { name: '浅色' }).click()
    await expect.poll(() => theme(page)).toBe('light')

    // 跟随系统 follows the OS preference.
    await page.emulateMedia({ colorScheme: 'dark' })
    await picker.getByRole('button', { name: '跟随系统' }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ theme: 'system' })
    await expect.poll(() => theme(page)).toBe('dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => theme(page)).toBe('light')
    await page.emulateMedia({ colorScheme: null })
  })

  it('turning 训练 on adds it to the rail; off removes it', async () => {
    const page = await app.open({ route: '/settings/features' })
    const rail = page.getByRole('navigation', { name: '主导航' })
    expect(await rail.getByRole('button', { name: '训练' }).count()).toBe(0)
    await page.getByRole('switch', { name: '训练' }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ trainingEnabled: true })
    await expect.poll(() => rail.getByRole('button', { name: '训练' }).isVisible()).toBe(true)
    await rail.getByRole('button', { name: '训练' }).click()
    await expect.poll(() => hash(page)).toBe('#/training')

    await page.evaluate(() => { window.location.hash = '#/settings/features' })
    await page.getByRole('switch', { name: '训练' }).click()
    await expect.poll(() => rail.getByRole('button', { name: '训练' }).count()).toBe(0)
    // Its route is gone too: an old link falls back to 创作.
    await page.evaluate(() => { window.location.hash = '#/training' })
    await expect.poll(() => page.locator('[data-page="/studio"]:not(.hidden)').count()).toBe(1)
  })

  it('turning 远程主机 on shows remote machines in 设备与引擎 and the 模型 location switcher', async () => {
    const page = await app.open({ scenario: 'remoteHost', route: '/settings/devices' })
    await expect.poll(() => page.getByText('未开启').isVisible()).toBe(true)
    expect(await page.getByText('Linux GPU').count()).toBe(0)
    await page.getByRole('button', { name: '在功能中开启' }).click()
    await expect.poll(() => hash(page)).toBe('#/settings/features')

    await page.getByRole('switch', { name: '远程主机' }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ remoteHostsEnabled: true })
    await page.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '设备与引擎' }).click()
    await expect.poll(() => page.getByText('Linux GPU').first().isVisible()).toBe(true)
    await expect.poll(() => page.getByRole('button', { name: /添加 SSH 主机/ }).isVisible()).toBe(true)

    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '模型' }).click()
    await expect.poll(() => page.getByRole('group', { name: '模型所在的电脑' }).isVisible()).toBe(true)

    // Off again: every trace disappears.
    await page.evaluate(() => { window.location.hash = '#/settings/features' })
    await page.getByRole('switch', { name: '远程主机' }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ remoteHostsEnabled: false })
    await page.evaluate(() => { window.location.hash = '#/models' })
    await expect.poll(() => page.getByRole('group', { name: '模型所在的电脑' }).count()).toBe(0)
    await page.evaluate(() => { window.location.hash = '#/settings/devices' })
    await expect.poll(() => page.getByText('Linux GPU').count()).toBe(0)
  })

  it('局域网访问 shows its address only when on', async () => {
    const page = await app.open({ route: '/settings/features', theme: 'light' })
    expect(await page.getByRole('heading', { name: '局域网访问' }).count()).toBe(0)
    await page.getByRole('switch', { name: '局域网访问' }).click()
    await expect.poll(() => page.getByText('http://192.168.1.20:7860/?token=fixture').isVisible()).toBe(true)
    await app.screenshot('settings-features-lan-light')
  })

  it('reports a failed save instead of pretending', async () => {
    const page = await app.open({ route: '/settings/general', theme: 'light' })
    await page.evaluate(() => window.__mock.fail('settings:update', { code: 'E_WRITE', message: '设置文件无法写入' }))
    await page.getByRole('group', { name: '主题' }).getByRole('button', { name: '深色' }).click()
    await expect.poll(() => page.getByText(/设置文件无法写入/).isVisible()).toBe(true)
  })
})
