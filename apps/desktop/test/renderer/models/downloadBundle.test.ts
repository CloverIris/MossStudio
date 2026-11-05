import { describe, expect, it } from 'vitest'
import { Ipc } from '@shared/channels'
import { loadStore } from '../../helpers/renderer'

describe('store.downloadBundle', () => {
  it('queues every missing part of a whole model and tracks the tasks', async () => {
    const { backend, store } = await loadStore('engineInstalledModelMissing')
    await store().init()
    const tasks = await store().downloadBundle('moss-sft')
    expect(backend.callsTo(Ipc.modelBundleInstall)).toEqual([{ id: 'moss-sft' }])
    expect(tasks.length).toBeGreaterThan(0)
    for (const task of tasks) expect(store().downloads.some((item) => item.id === task.id)).toBe(true)
  })

  it('surfaces a backend refusal', async () => {
    const { backend, store } = await loadStore('ready')
    backend.fail(Ipc.modelBundleInstall, { code: 'E_DISK', message: '磁盘空间不足' })
    await expect(store().downloadBundle('moss-sft')).rejects.toThrow('磁盘空间不足')
  })
})
