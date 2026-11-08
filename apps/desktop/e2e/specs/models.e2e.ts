/**
 * 模型: every engine-certified model under 推荐模型 with the best one for this
 * computer featured (one entry, one action), download progress, LoRA,
 * 自己组合 for parts and the person's own files, and the location switcher
 * only with 远程主机.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp } from '../support/app'

describe('models', () => {
  const app = useApp()
  const featured = (page: Page) => page.locator('[data-oobe="model"]')

  it('downloads the recommended model with one action and shows its progress', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/models', theme: 'light' })
    const card = featured(page)
    await expect.poll(() => page.getByRole('heading', { name: '推荐模型' }).isVisible()).toBe(true)
    // An RTX 4090 has VRAM to spare: the official model is the best pick.
    await expect.poll(() => card.getByText('最适合这台电脑').isVisible()).toBe(true)
    await expect.poll(() => card.getByRole('heading', { name: 'MOSS-Image SFT' }).isVisible()).toBe(true)
    // One entry, one action; the parts it is made of are not listed here.
    expect(await card.getByRole('button').count()).toBe(1)
    await card.getByRole('button', { name: '下载' }).click()
    await expect.poll(() => app.calls('models:install-bundle')).toEqual([{ id: 'moss-sft' }])
    expect(await page.evaluate(() => window.__mock.state.downloads.length)).toBe(4)

    await page.evaluate(() => {
      for (const task of window.__mock.state.downloads) {
        window.__mock.emit(window.__mock.Events.download, {
          ...task,
          state: 'running',
          bytes: Math.floor(task.totalBytes / 2),
          speedBps: 40_000_000,
        })
      }
    })
    await expect.poll(() => card.getByText(/下载中 \d+%/).isVisible()).toBe(true)
    await expect.poll(() => card.getByRole('progressbar').isVisible()).toBe(true)
    expect(await card.getByRole('button', { name: '暂停' }).isVisible()).toBe(true)
    await app.screenshot('models-downloading-light')

    await page.evaluate(() => {
      for (const task of [...window.__mock.state.downloads]) window.__mock.playDownload(task)
    })
    await expect.poll(() => card.getByText('可以使用').isVisible()).toBe(true)
    await expect.poll(() => card.getByRole('button', { name: '去创作' }).isVisible()).toBe(true)
  })

  it('lists every certified model under 推荐模型 and the unverified ones under 其他模型', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/models', theme: 'light' })
    const section = (title: string) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    const recommended = section('推荐模型')
    await expect.poll(() => recommended.isVisible()).toBe(true)
    for (const name of [
      'MOSS-Image SFT',
      'MOSS-Image Base',
      'SFT · INT8',
      'SFT · NVFP4',
      'SFT · INT4',
      'SFT Turbo · INT8 8 步',
      'Base · INT8',
    ]) {
      expect(await recommended.getByText(name, { exact: true }).count()).toBe(1)
    }
    expect(await recommended.getByText('显存占用约减四成，速度约快 2.5 倍，日常首选。', { exact: false }).count()).toBe(1)
    const others = section('其他模型')
    expect(await others.getByText('引擎没有验证过', { exact: false }).count()).toBeGreaterThan(0)
    expect(await others.getByText('SFT · FP16-fixed', { exact: true }).count()).toBe(1)
    expect(await recommended.getByText('SFT · FP16-fixed', { exact: true }).count()).toBe(0)
    await app.screenshot('models-certified-light')

    // NVFP4 runs only on RTX 50: this RTX 4090 says why and offers no download.
    const nvfp4 = recommended
      .getByText('SFT · NVFP4', { exact: true })
      .locator('xpath=ancestor::*[.//button or .//span[text()="用不了"]][1]')
    await expect.poll(() => nvfp4.getByText('只能在 RTX 50 系列显卡上运行').isVisible()).toBe(true)
    expect(await nvfp4.getByText('用不了', { exact: true }).isVisible()).toBe(true)
    expect(await nvfp4.getByRole('button', { name: '下载' }).count()).toBe(0)

    // A single-file model downloads its four files in one action.
    const int8 = recommended.getByText('SFT · INT8', { exact: true }).locator('xpath=ancestor::*[.//button][1]')
    await int8.getByRole('button', { name: '下载' }).click()
    await expect.poll(() => app.calls('models:install-bundle')).toEqual([{ id: 'moss-sft-int8' }])
    expect(await page.evaluate(() => window.__mock.state.downloads.map((task) => task.targetId))).toEqual([
      'moss-sft-comfy-int8_convrot',
      'qwen35-comfy-int8_convrot',
      'flux2-vae-comfy-small',
      'moss-runtime-config',
    ])
  })

  it('features the official SFT on an RTX 50 card with VRAM to spare, NVFP4 listed below it', async () => {
    const page = await app.open({ scenario: 'modelMissingRtx50', route: '/models', theme: 'dark' })
    const card = featured(page)
    await expect.poll(() => card.getByRole('heading', { name: 'MOSS-Image SFT' }).isVisible()).toBe(true)
    expect(await card.getByText('最适合这台电脑').isVisible()).toBe(true)
    expect(await card.getByText(/RTX 5090 显存充足/).isVisible()).toBe(true)
    // NVFP4 runs here, so it is offered with a download, just not featured.
    const nvfp4 = page.getByText('SFT · NVFP4', { exact: true }).locator('xpath=ancestor::*[.//button or .//span[text()="用不了"]][1]')
    await expect.poll(() => nvfp4.getByRole('button', { name: '下载' }).isVisible()).toBe(true)
    expect(await nvfp4.getByText('用不了', { exact: true }).count()).toBe(0)
    await card.getByRole('button', { name: '下载' }).click()
    await expect.poll(() => app.calls('models:install-bundle')).toEqual([{ id: 'moss-sft' }])
    await app.screenshot('models-rtx50-dark')
  })

  it('offers only the official models when the GPU runs 兼容模式', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/models', defer: true })
    await page.evaluate(() => {
      const gpu = window.__mock.state.gpuInventory.devices[0]!
      window.__mock.state.engineReadiness = {
        ...window.__mock.state.engineReadiness,
        devices: [{ deviceUuid: gpu.uuid, name: gpu.name, packageId: 'vulkan', path: null }],
      }
    })
    await app.start()
    const card = featured(page)
    await expect.poll(() => card.getByRole('heading', { name: 'MOSS-Image SFT' }).isVisible()).toBe(true)
    expect(await card.getByText('上的引擎只能运行官方模型', { exact: false }).isVisible()).toBe(true)
    const int8 = page.getByText('SFT · INT8', { exact: true }).locator('xpath=ancestor::*[.//span[text()="用不了"]][1]')
    await expect.poll(() => int8.getByText('上的引擎只能运行官方模型', { exact: false }).isVisible()).toBe(true)
    expect(await int8.getByRole('button', { name: '下载' }).count()).toBe(0)
  })

  it('pauses and resumes a download', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/models' })
    const card = featured(page)
    await card.getByRole('button', { name: '下载' }).click()
    await page.evaluate(() => {
      for (const task of window.__mock.state.downloads) {
        window.__mock.emit(window.__mock.Events.download, {
          ...task,
          state: 'running',
          bytes: Math.floor(task.totalBytes / 3),
          speedBps: 1,
        })
      }
    })
    await card.getByRole('button', { name: '暂停' }).click()
    await expect.poll(() => app.calls<{ taskId: string }>('models:pause').then((calls) => calls.length)).toBeGreaterThan(0)
  })

  it('lists LoRA on its own tab and downloads one', async () => {
    const page = await app.open({ scenario: 'ready', route: '/models', theme: 'light' })
    await page.getByRole('tab', { name: 'LoRA' }).click()
    const adapter = await page.evaluate(() => window.__mock.state.catalog.adapters[0]!)
    await expect.poll(() => page.getByText(adapter.name).first().isVisible()).toBe(true)
    await app.screenshot('models-lora-light')
    await page.getByText(adapter.name).first().locator('xpath=ancestor::*[.//button][1]').getByRole('button', { name: '下载' }).click()
    await expect.poll(() => app.calls('models:download')).toEqual([{ kind: 'adapter', id: adapter.id }])
  })

  const openCombine = async (page: Page, item: string) => {
    await page.getByRole('button', { name: '自己组合' }).click()
    await page.getByRole('menuitem', { name: item }).click()
  }
  const dialog = (page: Page) => page.locator('[data-combination-dialog]')
  /** A saved combination's row title: its name, then the 我的组合 tag. */
  const comboTitle = (page: Page, name: string) => page.getByText(`${name}我的组合`, { exact: true })

  it('builds a model from parts, downloading only what is missing', async () => {
    const page = await app.open({ scenario: 'ready', route: '/models', theme: 'light' })
    await openCombine(page, '挑选要下载的部件')
    const parts = dialog(page)
    await expect.poll(() => parts.isVisible()).toBe(true)
    // It starts from the recommended model, which is here: nothing to download.
    expect(await parts.getByLabel('主模型').inputValue()).toBe('moss-sft-dit')
    await expect.poll(() => page.locator('[data-combination-need]').textContent()).toBe('不用再下载')
    await parts.getByLabel('主模型').selectOption({ label: 'MOSS-Image SFT · INT8 · 5.4 GB' })
    await parts.getByLabel('文本编码器').selectOption({ label: 'Qwen3.5 · W4A8 · 7.3 GB' })
    // The two single files and the 20 MB of configs they need.
    await expect.poll(() => page.locator('[data-combination-need]').textContent()).toBe('还要下载 12.8 GB')
    expect(await parts.getByLabel('名字').inputValue()).toBe('SFT · INT8 + Qwen3.5 · W4A8')
    await app.screenshot('models-combine-light')
    await page.getByRole('button', { name: '下载并保存' }).click()
    await expect
      .poll(() => app.calls('models:save-combination'))
      .toEqual([
        {
          name: 'SFT · INT8 + Qwen3.5 · W4A8',
          components: { dit: 'moss-sft-comfy-int8_convrot', textEncoder: 'qwen35-comfy-w4a8_gptq', vae: 'flux2-vae-small' },
        },
      ])
    await expect.poll(() => app.calls('models:install-bundle')).toEqual([{ id: 'combo-1' }])
    const tasks = await page.evaluate(() => window.__mock.state.downloads.map((task) => task.targetId).sort())
    expect(tasks).toEqual(['moss-runtime-config', 'moss-sft-comfy-int8_convrot', 'qwen35-comfy-w4a8_gptq'])
    await expect.poll(() => comboTitle(page, 'SFT · INT8 + Qwen3.5 · W4A8').isVisible()).toBe(true)
  })

  it('fills the slots from the model files in a folder on this computer', async () => {
    const page = await app.open({ scenario: 'ready', route: '/models', theme: 'dark', defer: true })
    await page.evaluate(() => {
      window.__mock.state.localModelFiles = [
        { path: '/data/ComfyUI/models/diffusion_models/moss_image_sft_int8.safetensors', role: 'dit' },
        { path: '/data/ComfyUI/models/text_encoders/qwen3.5_int8.safetensors', role: 'text_encoder' },
      ]
    })
    await app.start()
    await openCombine(page, '用电脑上的模型文件…')
    const parts = dialog(page)
    await expect.poll(() => parts.isVisible()).toBe(true)
    expect(await parts.getByLabel('主模型').inputValue()).toBe('local-scan-0')
    expect(await parts.getByLabel('文本编码器').inputValue()).toBe('local-scan-1')
    // Nothing found for the VAE: it takes the one already downloaded.
    expect(await parts.getByLabel('VAE').inputValue()).toBe('flux2-vae-small')
    expect(await parts.getByLabel('名字').inputValue()).toBe('moss_image_sft_int8 + qwen3.5_int8')
    await expect.poll(() => page.locator('[data-combination-need]').textContent()).toBe('还要下载 20 MB')
    await app.screenshot('models-combine-own-files-dark')
    await page.getByRole('button', { name: '下载并保存' }).click()
    await expect
      .poll(() => app.calls<{ components: unknown }>('models:save-combination').then((calls) => calls[0]?.components))
      .toEqual({
        dit: 'local-scan-0',
        textEncoder: 'local-scan-1',
        vae: 'flux2-vae-small',
      })
  })

  it('adds a complete model folder where it is (no copy), and says so', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/models', theme: 'light', defer: true })
    await page.evaluate(() => {
      window.__mock.state.localModelFolder = {
        path: '/workspace/Models/MOSS-Image/sft',
        name: 'MOSS-Image SFT（sft）',
        bundleId: 'moss-sft',
      }
    })
    await app.start()
    await openCombine(page, '用电脑上的模型文件…')
    await expect.poll(() => app.calls('models:use-folder').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => page.getByText('已在原位置使用 MOSS-Image SFT（sft）').isVisible()).toBe(true)
    await expect.poll(() => featured(page).getByText('可以使用').isVisible()).toBe(true)
    expect(await dialog(page).count()).toBe(0)
  })

  it('deletes a saved combination, keeping the files other models use', async () => {
    const page = await app.open({ scenario: 'ready', route: '/models' })
    await openCombine(page, '挑选要下载的部件')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const name = 'SFT · BF16 + Qwen3.5 · BF16'
    await expect.poll(() => comboTitle(page, name).isVisible()).toBe(true)
    await page.getByRole('button', { name: `删除 ${name}` }).click()
    await expect.poll(() => page.getByText('只删除这个组合，它用到的文件都会保留。').isVisible()).toBe(true)
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click()
    await expect.poll(() => app.calls('models:delete-combination')).toEqual([{ id: 'combo-1' }])
    expect(await app.calls('models:delete')).toEqual([])
    await expect.poll(() => comboTitle(page, name).count()).toBe(0)
  })

  it('keeps folders and unused downloads under 高级, with no parts list', async () => {
    const page = await app.open({ scenario: 'ready', route: '/models', theme: 'light', defer: true })
    await page.evaluate(() => {
      const catalog = window.__mock.state.catalog
      window.__mock.state.catalog = {
        ...catalog,
        models: catalog.models.map((model) =>
          // The W4A8 encoder: no catalog model uses it (the INT8 one belongs to the certified INT8 models).
          model.id === 'qwen35-comfy-w4a8_gptq'
            ? { ...model, installed: true, installState: 'ready', installedBytes: model.sizeBytes }
            : model,
        ),
      }
    })
    await app.start()
    await page.getByRole('button', { name: /高级/ }).click()
    expect(await page.getByText('单独的部件').count()).toBe(0)
    const unused = page.locator('[data-unused-files]')
    await unused.scrollIntoViewIfNeeded()
    await expect.poll(() => unused.getByText('1 个文件 · 7.3 GB').isVisible()).toBe(true)
    await unused.scrollIntoViewIfNeeded()
    await app.screenshot('models-advanced-light')
    await unused.getByRole('button', { name: '全部删除' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click()
    await expect.poll(() => app.calls('models:delete')).toEqual([{ kind: 'model', id: 'qwen35-comfy-w4a8_gptq' }])
    await expect.poll(() => unused.count()).toBe(0)
  })

  it('shows where models live only when 远程主机 is on', async () => {
    let page = await app.open({ scenario: 'remoteHost', route: '/models' })
    await page.getByRole('heading', { name: '模型' }).first().waitFor()
    expect(await page.getByRole('group', { name: '模型所在的电脑' }).count()).toBe(0)
    expect(await app.calls('hosts:list')).toEqual([])

    page = await app.open({ scenario: 'remoteHost', route: '/models', theme: 'dark', settings: { remoteHostsEnabled: true } })
    const picker = page.getByRole('group', { name: '模型所在的电脑' })
    await expect.poll(() => picker.isVisible()).toBe(true)
    await picker.getByRole('button', { name: 'Linux GPU' }).click()
    await expect.poll(() => app.calls<{ hostId: string }>('models:remote-inventory').then((calls) => calls.at(-1)?.hostId)).toBe('ssh-gpu')
    await expect.poll(() => page.getByText(/模型保存在 Linux GPU 上/).isVisible()).toBe(true)
    // Single files load only on this computer: offered there, not on the SSH host.
    await expect.poll(() => page.getByText('只能在这台电脑上使用，其他电脑请用官方模型').first().isVisible()).toBe(true)
    const int8 = page.getByText('SFT · INT8', { exact: true }).locator('xpath=ancestor::*[.//span[text()="用不了"]][1]')
    expect(await int8.getByRole('button', { name: '下载' }).count()).toBe(0)
    await app.screenshot('models-remote-dark')
  })
})
