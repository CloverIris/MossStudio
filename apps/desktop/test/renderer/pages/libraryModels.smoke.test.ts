import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Ipc } from '@shared/channels'
import { galleryItemFixture } from '../../mocks/backend'
import { flush, loadStore } from '../../helpers/renderer'

// Render the real pages against the mock backend to catch runtime errors.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

async function render(page: 'library' | 'models', route: string, scenarioPatch: Parameters<typeof loadStore>[0] = 'ready') {
  const { backend, store } = await loadStore(scenarioPatch)
  vi.stubGlobal('IntersectionObserver', class { observe(): void {} disconnect(): void {} })
  await store().init()
  const { ToastProvider } = await import('@renderer/components/ui')
  const Page = page === 'library' ? (await import('@renderer/pages/Library')).LibraryPage : (await import('@renderer/pages/Models')).ModelsPage
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [route] }, createElement(Page))))
  })
  await act(async () => { await flush(5) })
  return { backend, store, container: container! }
}

describe('Library page', () => {
  it('lists images grouped by day and opens the detail panel', async () => {
    const { backend, container } = await render('library', '/library')
    expect(container.textContent).toContain('作品')
    expect(container.textContent).toContain(`${backend.state.gallery.length} 张`)
    const thumbs = container.querySelectorAll('[data-library-item]')
    expect(thumbs.length).toBe(backend.state.gallery.length)
    await act(async () => { (thumbs[0] as HTMLButtonElement).click() })
    await act(async () => { await flush(5) })
    expect(container.querySelector('aside[aria-label="作品详情"]')).not.toBeNull()
    expect(container.textContent).toContain('在创作中复用')
    expect(container.textContent).toContain('prompt 0')
  })

  it('merges new results at the top without closing the open image', async () => {
    const { Events } = await import('@shared/channels')
    const { backend, container } = await render('library', '/library')
    const before = container.querySelectorAll('[data-library-item]').length
    await act(async () => { (container.querySelectorAll('[data-library-item]')[1] as HTMLButtonElement).click() })
    await act(async () => { await flush(5) })
    backend.state.gallery = [galleryItemFixture(99, { mtime: Date.now() }), ...backend.state.gallery]
    await act(async () => { backend.emit(Events.galleryChanged, { jobId: 'j' }) })
    await act(async () => { await flush(5) })
    expect(container.querySelectorAll('[data-library-item]').length).toBe(before + 1)
    expect(container.querySelector('[aria-pressed="true"]')?.getAttribute('data-library-item')).toBe(backend.state.gallery[2]!.path)
    expect(container.querySelector('aside[aria-label="作品详情"]')).not.toBeNull()
  })

  it('shows the empty state in the page', async () => {
    const { scenario } = await import('../../mocks/backend')
    const { container } = await render('library', '/library', scenario('ready', { gallery: [] }))
    expect(container.textContent).toContain('还没有作品')
  })

  it('shows a load error in the page with a retry', async () => {
    const { scenario } = await import('../../mocks/backend')
    const state = scenario('ready', { gallery: [galleryItemFixture(0)] })
    const { backend, store } = await loadStore(state)
    backend.fail(Ipc.galleryList, { code: 'E_IO', message: '目录不可读' })
    void store
    const { ToastProvider } = await import('@renderer/components/ui')
    const { LibraryPage } = await import('@renderer/pages/Library')
    vi.stubGlobal('IntersectionObserver', class { observe(): void {} disconnect(): void {} })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(LibraryPage))))
    })
    await act(async () => { await flush(5) })
    expect(container.textContent).toContain('作品读取失败')
    expect(container.textContent).toContain('目录不可读')
  })
})

describe('Models page', () => {
  it('shows the recommended model as a whole with one action, and the other models', async () => {
    const { container } = await render('models', '/models', 'engineInstalledModelMissing')
    expect(container.textContent).toContain('MOSS-Image SFT')
    expect(container.textContent).toContain('推荐模型')
    expect(container.textContent).toContain('其他模型')
    expect(container.textContent).toMatch(/未下载|还差/)
    expect(container.textContent).not.toContain('实例详情')
    expect(container.textContent).not.toContain('本机')
  })

  it('queues the whole model from the primary action', async () => {
    const { backend, container } = await render('models', '/models', 'engineInstalledModelMissing')
    const primary = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '下载' && button.closest('[data-oobe="model"]'))
    expect(primary).toBeDefined()
    await act(async () => { primary!.click() })
    await act(async () => { await flush(5) })
    expect(backend.callsTo(Ipc.modelBundleInstall)).toEqual([{ id: 'moss-sft' }])
  })

  it('opens on a deep-linked model and shows the remote picker only when remote hosts are on', async () => {
    const { scenario, settingsFixture } = await import('../../mocks/backend')
    const off = await render('models', '/models?bundle=moss-base&component=all', 'remoteHost')
    expect(off.container.querySelector('[data-oobe="model"]')?.textContent).toContain('MOSS-Image Base')
    expect(off.container.querySelector('[aria-label="模型所在的电脑"]')).toBeNull()
    act(() => root?.unmount())
    container?.remove()

    const on = await render('models', '/models', scenario('remoteHost', { settings: settingsFixture({ onboardingState: 'completed', remoteHostsEnabled: true }) }))
    expect(on.container.querySelector('[aria-label="模型所在的电脑"]')).not.toBeNull()
  })

  it('deletes a whole model on an SSH host in one planned call, never by folder', async () => {
    const { scenario, settingsFixture, sshHostFixture } = await import('../../mocks/backend')
    const host = sshHostFixture()
    const state = scenario('remoteHost', { settings: settingsFixture({ onboardingState: 'completed', remoteHostsEnabled: true }) })
    const { backend, store } = await loadStore(state)
    vi.stubGlobal('IntersectionObserver', class { observe(): void {} disconnect(): void {} })
    const sft = ['moss-sft-dit', 'qwen35-encoder', 'flux2-vae-small', 'moss-pipeline']
    backend.handle(Ipc.modelsRemoteInventory, () => ({
      root: '/r', files: 4, adapters: [],
      models: backend.state.catalog.models.map((model) => ({ id: model.id, installed: sft.includes(model.id), path: sft.includes(model.id) ? '/r/snap' : undefined })),
    }))
    await store().init()
    const { ToastProvider } = await import('@renderer/components/ui')
    const { ModelsPage } = await import('@renderer/pages/Models')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [`/models?hostId=${host.id}`] }, createElement(ModelsPage))))
    })
    await act(async () => { await flush(8) })
    const featured = container.querySelector('[data-oobe="model"]')!
    expect(featured.textContent).toContain('可以使用')
    const remove = [...featured.querySelectorAll('button')].find((button) => button.textContent?.includes('删除'))!
    await act(async () => { remove.click() })
    await act(async () => { await flush(3) })
    const confirm = [...document.querySelectorAll('dialog button')].find((button) => button.textContent === '删除') as HTMLButtonElement
    expect(confirm).toBeDefined()
    await act(async () => { confirm.click() })
    await act(async () => { await flush(5) })
    expect(backend.callsTo(Ipc.modelsRemoteDelete)).toEqual([{ hostId: host.id, ids: sft }])
    expect(backend.callsTo(Ipc.remoteResourceRemove)).toEqual([])
  })
})
