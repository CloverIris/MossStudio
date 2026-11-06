import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'

const requestEngineOnce = vi.hoisted(() => vi.fn())
const requestRunningEngine = vi.hoisted(() => vi.fn())
/** The moss-server inspect asks: engineInstalls.localServerPath (the first GPU's own CUDA install). */
const localServerPath = vi.hoisted(() => vi.fn())
const emit = vi.hoisted(() => vi.fn())
vi.mock('@main/lib/probeEngine', () => ({ requestEngineOnce }))
vi.mock('@main/services/mossInfer', () => ({ requestRunningEngine }))
vi.mock('@main/services/engineInstalls', () => ({ localServerPath }))
vi.mock('@main/lib/events', () => ({ emit }))

const dataRoot = useTempDataRoot()
const models = useTempDir('mossstudio-control-')

let registry: typeof import('@main/services/controlAdapters')

const hello = (capabilities: Record<string, boolean> = { inspect: true }) => ({ protocol: 2, capabilities, values: {}, raw: {} })

/** What moss-server 2.2's inspect answers for a control adapter (main.cpp inspect_json). */
const controlReport = (path: string) => ({
  path,
  kind: 'control_adapter',
  loadable: true,
  file_bytes: 1234,
  tensors: 300,
  note: '',
  control_kinds: ['depth', 'canny', 'pose'],
  base_model: 'moss-image',
  adapter_types: ['lora'],
  lora_rank: 64,
  lora_adapters: 120,
  lora_unknown_keys: 0,
})

function file(name: string): string {
  const path = join(models(), name)
  writeFileSync(path, 'weights')
  return path
}

beforeEach(async () => {
  vi.resetModules()
  requestEngineOnce.mockReset()
  requestRunningEngine.mockReset().mockReturnValue(null)
  localServerPath.mockReset().mockReturnValue('/engine/bin/moss-server')
  emit.mockReset()
  registry = await import('@main/services/controlAdapters')
})

describe('control adapter registry', () => {
  it('registers a file the engine calls a control adapter, with its kinds and base model', async () => {
    const path = file('union.safetensors')
    requestEngineOnce.mockImplementation(async (_server: string, method: string, params: { path: string }) => ({
      hello: hello(),
      result: { ...controlReport(params.path), method },
    }))
    const entry = await registry.addControlAdapter({ path })
    expect(requestEngineOnce).toHaveBeenCalledWith('/engine/bin/moss-server', 'inspect', { path })
    expect(entry).toEqual({
      id: expect.stringMatching(/^control-[0-9a-f]{12}$/),
      name: 'union.safetensors',
      path,
      sizeBytes: 1234,
      controlKinds: ['depth', 'canny', 'pose'],
      baseModel: 'moss-image',
      addedAt: expect.any(String),
    })
    expect(registry.listControlAdapters()).toEqual([entry])
    expect(JSON.parse(readFileSync(join(dataRoot(), 'control-adapters.json'), 'utf8'))).toEqual([entry])
    expect(emit).toHaveBeenCalledWith(Events.modelsChanged, null)
  })

  it('asks a running moss-server first, without starting another one', async () => {
    const path = file('depth.safetensors')
    requestRunningEngine.mockReturnValue(Promise.resolve(controlReport(path)))
    await registry.addControlAdapter({ path })
    expect(requestRunningEngine).toHaveBeenCalledWith('inspect', { path })
    expect(requestEngineOnce).not.toHaveBeenCalled()
  })

  it('adding the same file again (also through a link) updates the one entry', async () => {
    const path = file('union.safetensors')
    requestEngineOnce.mockImplementation(async (_s: string, _m: string, params: { path: string }) => ({
      hello: hello(),
      result: controlReport(params.path),
    }))
    const first = await registry.addControlAdapter({ path })
    // A file symlink needs a privilege on Windows; the same path is the same file there.
    const link = join(models(), 'link.safetensors')
    if (process.platform !== 'win32') symlinkSync(path, link)
    const second = await registry.addControlAdapter({ path: process.platform === 'win32' ? path : link })
    expect(second.id).toBe(first.id)
    expect(second.addedAt).toBe(first.addedAt)
    expect(registry.listControlAdapters()).toHaveLength(1)
  })

  it.each([
    ['lora', '这是 LoRA，请在 LoRA 中添加'],
    ['dit', '这是主模型（DiT），请在模型中添加'],
    ['text_encoder', '这是文本编码器，请在模型中添加'],
    ['vae', '这是 VAE，请在模型中添加'],
    ['unknown', '这个文件不是控制适配器（not a safetensors file）'],
  ])('refuses a %s file and says where it belongs', async (kind, message) => {
    const path = file('x.safetensors')
    requestEngineOnce.mockResolvedValue({
      hello: hello(),
      result: { path, kind, loadable: true, note: kind === 'unknown' ? 'not a safetensors file' : '' },
    })
    await expect(registry.addControlAdapter({ path })).rejects.toMatchObject({ code: 'E_NOT_CONTROL_ADAPTER', message })
    expect(registry.listControlAdapters()).toEqual([])
    expect(emit).not.toHaveBeenCalled()
  })

  it('refuses a control adapter the engine cannot load', async () => {
    const path = file('broken.safetensors')
    requestEngineOnce.mockResolvedValue({ hello: hello(), result: { ...controlReport(path), loadable: false, note: 'unknown base model' } })
    await expect(registry.addControlAdapter({ path })).rejects.toMatchObject({ message: '引擎无法使用这个控制适配器：unknown base model' })
  })

  it('explains a missing file, a missing engine, an old engine and an unreadable file', async () => {
    await expect(registry.addControlAdapter({ path: join(models(), 'gone.safetensors') })).rejects.toMatchObject({ code: 'E_INPUT_PATH' })
    const path = file('x.safetensors')
    localServerPath.mockReturnValue(null)
    await expect(registry.addControlAdapter({ path })).rejects.toMatchObject({
      code: 'E_ENGINE',
      message: '需要先准备 MossInfer 引擎，才能识别控制适配器',
    })
    localServerPath.mockReturnValue('/engine/bin/moss-server')
    requestEngineOnce.mockRejectedValue(new Error('method_not_found: unknown method "inspect"'))
    await expect(registry.addControlAdapter({ path })).rejects.toMatchObject({ code: 'E_NOT_SUPPORTED' })
    requestEngineOnce.mockResolvedValue({ hello: hello({ inspect: false }), result: {} })
    await expect(registry.addControlAdapter({ path })).rejects.toMatchObject({ code: 'E_NOT_SUPPORTED' })
    requestEngineOnce.mockRejectedValue(new Error('io: cannot read x.safetensors'))
    await expect(registry.addControlAdapter({ path })).rejects.toMatchObject({
      code: 'E_INSPECT',
      message: '无法读取这个文件：cannot read x.safetensors',
    })
  })

  it('removes an entry by id and tells the renderer; an unknown id changes nothing', async () => {
    const path = file('union.safetensors')
    requestEngineOnce.mockResolvedValue({ hello: hello(), result: controlReport(path) })
    const entry = await registry.addControlAdapter({ path })
    emit.mockClear()
    expect(registry.removeControlAdapter({ id: 'nope' })).toBeNull()
    expect(emit).not.toHaveBeenCalled()
    registry.removeControlAdapter({ id: entry.id })
    expect(registry.listControlAdapters()).toEqual([])
    expect(emit).toHaveBeenCalledWith(Events.modelsChanged, null)
  })

  it('reads a damaged registry as empty and skips malformed entries', () => {
    writeFileSync(join(dataRoot(), 'control-adapters.json'), '{')
    expect(registry.listControlAdapters()).toEqual([])
    writeFileSync(
      join(dataRoot(), 'control-adapters.json'),
      JSON.stringify([{ id: 'x' }, { id: 'ok', name: 'a', path: '/a', sizeBytes: 1, controlKinds: ['depth'], addedAt: 't' }]),
    )
    expect(registry.listControlAdapters().map((entry) => entry.id)).toEqual(['ok'])
  })
})
