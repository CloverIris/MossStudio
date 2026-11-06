/**
 * What the app detected and which engine each GPU gets: first run (/setup)
 * and 设置 › 设备, on the machines of test/mocks/backend/machines.ts.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp } from '../support/app'

const hash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash)

describe('engine detection', () => {
  const app = useApp()

  it('first run on an NVIDIA GPU: one line, the CUDA 13 package and its size', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/setup', theme: 'light' })
    const gpus = page.getByRole('list', { name: '检测到的显卡' })
    await expect.poll(() => gpus.getByText('NVIDIA GeForce RTX 4090').isVisible()).toBe(true)
    await expect.poll(() => gpus.getByText('CUDA 13 引擎 · 352 MB').isVisible()).toBe(true)
    await expect
      .poll(() => app.calls<{ refresh?: boolean }>('engine:plan').then((calls) => calls.some((call) => call?.refresh === true)))
      .toBe(true)
    await page.getByRole('button', { name: '开始准备' }).click()
    // Main installs whatever the plan says this computer needs.
    await expect.poll(() => app.calls<Record<string, unknown>>('mossinfer:download')).toEqual([{ channel: 'stable' }])
  })

  it('an old NVIDIA driver gets CUDA 12 and a quiet tip to update', async () => {
    const page = await app.open({ scenario: 'machineOldDriver', route: '/setup' })
    const gpus = page.getByRole('list', { name: '检测到的显卡' })
    await expect.poll(() => gpus.getByText('CUDA 12 引擎 · 492 MB').isVisible()).toBe(true)
    await expect.poll(() => gpus.getByText(/R580/).isVisible()).toBe(true)
  })

  it('Turing on Windows with R580 gets the SM75 build; Volta on Linux the SM70 one', async () => {
    let page = await app.open({ scenario: 'machineTuring', route: '/setup' })
    await expect.poll(() => page.getByRole('list', { name: '检测到的显卡' }).getByText('CUDA 13 引擎 · 356 MB').isVisible()).toBe(true)
    page = await app.open({ scenario: 'machineVolta', route: '/setup' })
    await expect.poll(() => page.getByRole('list', { name: '检测到的显卡' }).getByText('CUDA 12 引擎 · 530 MB').isVisible()).toBe(true)
  })

  it('AMD without ROCm: compatibility mode explained, ROCm suggested; with ROCm: AMD native', async () => {
    let page = await app.open({ scenario: 'machineAmd', route: '/setup', theme: 'dark' })
    const gpus = page.getByRole('list', { name: '检测到的显卡' })
    await expect.poll(() => gpus.getByText('兼容模式 · 1.2 MB').isVisible()).toBe(true)
    await expect.poll(() => gpus.getByText(/只能文生图/).isVisible()).toBe(true)
    await expect.poll(() => gpus.getByText('安装 ROCm 7 可获得更快的原生支持。').isVisible()).toBe(true)
    await expect.poll(() => page.getByRole('button', { name: '开始准备' }).isEnabled()).toBe(true)
    await app.screenshot('setup-amd-dark')
    page = await app.open({ scenario: 'machineAmdRocm', route: '/setup' })
    await expect.poll(() => page.getByRole('list', { name: '检测到的显卡' }).getByText('AMD 原生 · 1.1 MB').isVisible()).toBe(true)
  })

  it('Intel Arc: compatibility mode', async () => {
    const page = await app.open({ scenario: 'machineIntel', route: '/setup' })
    await expect.poll(() => page.getByRole('list', { name: '检测到的显卡' }).getByText('兼容模式 · 599 KB').isVisible()).toBe(true)
  })

  it('several GPUs: one line each, a shared package counted once', async () => {
    const page = await app.open({ scenario: 'machineMultiGpu', route: '/setup', theme: 'light' })
    const lines = page.getByRole('list', { name: '检测到的显卡' }).getByRole('listitem')
    await expect.poll(() => lines.count()).toBe(3)
    await expect
      .poll(() => lines.allInnerTexts())
      .toEqual([
        expect.stringContaining('CUDA 13 引擎 · 368 MB'),
        expect.stringContaining('CUDA 12 引擎 · 530 MB'),
        expect.stringContaining('兼容模式 · 1.2 MB'),
      ])
    await expect.poll(() => page.getByText(/3 个引擎包，共/).isVisible()).toBe(true)
    await app.screenshot('setup-multi-gpu-light')
  })

  it('macOS: says the engine does not run here and points to 远程主机', async () => {
    const page = await app.open({ scenario: 'machineMac', route: '/setup' })
    await expect.poll(() => page.getByText('这台 Mac 不能在本机运行推理引擎。').isVisible()).toBe(true)
    await expect.poll(() => page.getByRole('button', { name: '开始准备' }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: '重新检测' }).count()).toBe(0)
    await page.getByRole('button', { name: '去开启远程主机' }).click()
    await expect.poll(() => hash(page)).toBe('#/settings/features')
  })

  it('设置 › 设备 shows the engine each GPU runs, and 高级 lets one GPU use another package', async () => {
    const page = await app.open({ scenario: 'machineMultiGpu', route: '/settings/devices', theme: 'light', defer: true })
    await page.evaluate(() => {
      const { state, fixtures } = window.__mock
      const versions = ['stable-v2.2.0-cu13', 'stable-v2.2.0-cu12-sm70', 'stable-v2.2.0-vulkan']
      state.settings = { ...state.settings, onboardingState: 'completed' }
      state.engineVersions = versions.map((name) => fixtures.engineVersionFixture({ id: name, name, path: `/e/${name}` }))
      const ids = state.engineMachine.gpus.map((gpu) => gpu.id)
      state.engineReadiness = fixtures.engineReadyFixture({
        devices: [
          { deviceUuid: ids[0]!, name: 'NVIDIA GeForce RTX 4090', packageId: 'cu13', path: '/e/cu13' },
          { deviceUuid: ids[1]!, name: 'NVIDIA GeForce RTX 2080 Ti', packageId: 'cu12-sm70', path: '/e/sm70' },
          { deviceUuid: ids[2]!, name: 'AMD Radeon RX 7900 XTX', packageId: 'vulkan', path: '/e/vk' },
        ],
      })
    })
    await app.start()
    await expect.poll(() => page.getByText(/引擎：兼容模式 · 只能文生图/).isVisible()).toBe(true)
    await expect
      .poll(() =>
        page
          .getByText(/引擎：CUDA 13/)
          .first()
          .isVisible(),
      )
      .toBe(true)
    await page.getByRole('button', { name: /高级/ }).first().click()
    const picker = page.getByRole('combobox', { name: 'NVIDIA GeForce RTX 4090 使用的引擎' })
    // Only packages that run on this GPU are offered.
    await expect
      .poll(() => picker.locator('option').allInnerTexts())
      .toEqual([
        '自动',
        'CUDA 13 · 自带运行库',
        'CUDA 13 · 系统运行库',
        'CUDA 12 · 自带运行库',
        'CUDA 12 · 系统运行库',
        '兼容模式（Vulkan）',
      ])
    // The Vulkan GPU has no memory mode / tier pickers, only a quiet line; the CUDA GPUs keep theirs.
    await expect.poll(() => page.getByText('兼容模式引擎使用固定设置').isVisible()).toBe(true)
    expect(await page.getByRole('combobox', { name: 'AMD Radeon RX 7900 XTX 显存模式' }).count()).toBe(0)
    expect(await page.getByRole('combobox', { name: 'AMD Radeon RX 7900 XTX 性能档位' }).count()).toBe(0)
    expect(await page.getByRole('combobox', { name: 'NVIDIA GeForce RTX 4090 显存模式' }).count()).toBe(1)
    await picker.selectOption({ label: '兼容模式（Vulkan）' })
    await expect
      .poll(() =>
        app
          .calls<{ engineDeviceOverrides?: Record<string, string> }>('settings:update')
          .then((calls) => calls.at(-1)?.engineDeviceOverrides),
      )
      .toEqual({ 'GPU-00000000-1111-2222-3333-444444444444': 'vulkan' })
    await app.screenshot('settings-devices-engines-light')
  })
})
