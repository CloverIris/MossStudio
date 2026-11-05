import { describe, expect, it } from 'vitest'
import type { AdapterEntry, Catalog, EngineReadiness, ModelBundle, ModelEntry } from '@shared/types'
import { bundleInstalled, deriveReadiness, installedBundles, rerunEligibility, resolveBundle, updateRequiredReason, type ReadinessInput } from '@renderer/pages/studio/readiness'
import { cliEngineFeatures } from '@shared/cliEngine'
import { engineFeaturesFixture } from '@test/mocks/backend'
import { canvas, layer } from './fixtures'

const model = (id: string, installed = true): ModelEntry => ({
  id, name: id, provider: 'hf', repo: id, revision: 'main', role: 'dit', precision: 'bf16', sizeBytes: 1,
  license: 'x', tags: [], installed, installedBytes: installed ? 1 : 0,
})
const bundle = (id: string, patch: Partial<ModelBundle> = {}): ModelBundle => ({
  id, name: id.toUpperCase(), description: '', components: { dit: `${id}-dit`, textEncoder: 'te', vae: 'vae' }, support: 'cfg', ...patch,
})
const adapter = (id: string, installed = true): AdapterEntry => ({
  id, name: `LoRA ${id}`, provider: 'local', repo: '', revision: '', kind: 'lora', license: '', files: [], sizeBytes: 1, tags: [], installed, installedBytes: 1,
})

function catalog(patch: Partial<Catalog> = {}): Catalog {
  return {
    bundles: [bundle('sft'), bundle('rl', { recommended: true }), bundle('big')],
    models: [model('sft-dit'), model('rl-dit'), model('big-dit', false), model('te'), model('vae'), model('cfg')],
    adapters: [adapter('style'), adapter('gone', false)],
    updatedAt: '',
    source: 'builtin',
    ...patch,
  }
}

const ready: EngineReadiness = { state: 'ready', path: '/engine' }

function input(patch: Partial<ReadinessInput> = {}): ReadinessInput {
  const cat = catalog()
  return {
    canvas: canvas({ prompt: 'a street' }),
    catalog: cat,
    bundle: resolveBundle(cat, undefined, null),
    engine: ready,
    setupDone: true,
    remote: null,
    ...patch,
  }
}

describe('studio/readiness bundles', () => {
  it('counts a bundle as installed only when every file is there', () => {
    const cat = catalog()
    expect(bundleInstalled(cat.bundles[0]!, cat.models)).toBe(true)
    expect(bundleInstalled(cat.bundles[2]!, cat.models)).toBe(false)
    expect(installedBundles(cat).map((item) => item.id)).toEqual(['sft', 'rl'])
  })

  it('resolves the canvas model, then the last pick, then the recommended one', () => {
    const cat = catalog()
    expect(resolveBundle(cat, 'big', null)).toMatchObject({ bundle: { id: 'big' }, installed: false, unavailable: false })
    expect(resolveBundle(cat, 'deleted', null)).toMatchObject({ bundle: null, unavailable: true })
    expect(resolveBundle(cat, undefined, 'sft').bundle?.id).toBe('sft')
    expect(resolveBundle(cat, undefined, 'big').bundle?.id).toBe('rl')
    expect(resolveBundle(catalog({ models: [] }), undefined, null)).toMatchObject({ bundle: null, installed: false })
    expect(resolveBundle(null, 'sft', null)).toEqual({ bundle: null, installed: false, unavailable: false })
  })
})

describe('studio/readiness deriveReadiness', () => {
  it('has no blockers when everything is in place', () => {
    const result = deriveReadiness(input())
    expect(result.blockers).toEqual([])
    expect(result.prompt?.ok).toBe(true)
  })

  it('sends the user to 模型 when no model is installed', () => {
    const cat = catalog({ models: [] })
    const [first] = deriveReadiness(input({ catalog: cat, bundle: resolveBundle(cat, undefined, null) })).blockers
    expect(first).toEqual({ id: 'model-none', message: '还没有可用的模型', action: { label: '去下载', to: '/models' } })
  })

  it('names a model that is not downloaded yet', () => {
    const cat = catalog()
    const blockers = deriveReadiness(input({ bundle: resolveBundle(cat, 'big', null) })).blockers
    expect(blockers[0]).toMatchObject({ id: 'model-missing', message: '「BIG」还没有下载完' })
  })

  it('does not block while the catalog or engine state is still loading', () => {
    expect(deriveReadiness(input({ catalog: null, bundle: resolveBundle(null, undefined, null), engine: null })).blockers).toEqual([])
  })

  it('points an engine problem at settings, or at first-run setup before it is done', () => {
    const missing: EngineReadiness = { state: 'missing', path: null }
    expect(deriveReadiness(input({ engine: missing })).blockers).toEqual([{ id: 'engine', message: '引擎未就绪', action: { label: '去设置', to: '/settings/devices' } }])
    expect(deriveReadiness(input({ engine: missing, setupDone: false })).blockers[0]?.action?.to).toBe('/setup')
    const installing: EngineReadiness = { state: 'missing', path: null, installing: { percent: 41.6 } as EngineReadiness['installing'] }
    expect(deriveReadiness(input({ engine: installing })).blockers[0]?.message).toBe('引擎正在安装 · 42%')
  })

  it('ignores the local engine for remote runs but needs the remote model location', () => {
    const missing: EngineReadiness = { state: 'missing', path: null }
    expect(deriveReadiness(input({ engine: missing, remote: { name: 'gpu-box', modelPath: '/models' } })).blockers).toEqual([])
    expect(deriveReadiness(input({ remote: { name: 'gpu-box' } })).blockers[0]).toMatchObject({ id: 'remote-path', action: { to: '/settings/devices' } })
  })

  it('names missing LoRAs and refuses LoRAs on remote runs', () => {
    const withLora = canvas({ prompt: 'x', adapters: [{ id: 'style', strength: 1 }, { id: 'gone', strength: 1 }] })
    const local = deriveReadiness(input({ canvas: withLora })).blockers
    expect(local.map((item) => item.id)).toEqual(['adapters'])
    expect(local[0]!.message).toContain('「LoRA gone」')
    const remote = deriveReadiness(input({ canvas: canvas({ prompt: 'x', adapters: [{ id: 'style', strength: 1 }] }), remote: { name: 'r', modelPath: '/m' } })).blockers
    expect(remote.map((item) => item.id)).toEqual(['remote-adapters'])
  })

  it('reports an incomplete description last', () => {
    const blockers = deriveReadiness(input({ canvas: canvas() })).blockers
    expect(blockers).toEqual([{ id: 'prompt', message: '先写一句描述' }])
  })
})

describe('studio/readiness rerunEligibility', () => {
  it('lets a region-only canvas run again even though its prompt field is empty', () => {
    const regionOnly = canvas({ prompt: '', summary: { caption: 'poster', meta: [], canvas: 'single' }, layers: [layer()] })
    expect(regionOnly.prompt).toBe('')
    expect(rerunEligibility(regionOnly, { busy: false, submitting: false })).toEqual({ ok: true })
  })

  it('blocks while busy or submitting, and when the layout is incomplete', () => {
    const ok = canvas({ prompt: 'x' })
    expect(rerunEligibility(ok, { busy: true, submitting: false }).ok).toBe(false)
    expect(rerunEligibility(ok, { busy: false, submitting: true }).ok).toBe(false)
    expect(rerunEligibility(canvas(), { busy: false, submitting: false })).toMatchObject({ ok: false, reason: '先写一句描述' })
  })
})

describe('studio/readiness input blockers', () => {
  it('lists the canvas input problems before an incomplete description', () => {
    const inputBlockers = [{ id: 'input-source' as const, message: '起始图「画面 2」还没生成' }]
    const { blockers } = deriveReadiness(input({ canvas: canvas({ prompt: '' }), inputBlockers }))
    expect(blockers.map((blocker) => blocker.id)).toEqual(['input-source', 'prompt'])
    expect(blockers[0]!.message).toBe('起始图「画面 2」还没生成')
  })

  it('ignores input blockers when no layout canvas is selected', () => {
    expect(deriveReadiness(input({ canvas: null, inputBlockers: [{ id: 'input-invalid', message: 'x' }] })).blockers).toEqual([])
  })
})

describe('update-required blocker', () => {
  it('blocks 生成 first when this version may no longer generate, opening the update popover', () => {
    const readiness = deriveReadiness(input({ update: { supported: true, required: true, minimumVersion: '1.2.0' } }))
    expect(readiness.blockers[0]).toEqual({
      id: 'update-required',
      message: '必须更新到 1.2.0 才能继续生成',
      action: { label: '更新', to: '/settings/updates', opens: 'update' },
    })
  })

  it('sends a copy that cannot update itself to 设置 instead, and words a missing minimum plainly', () => {
    const readiness = deriveReadiness(input({ update: { supported: false, required: true, minimumVersion: null } }))
    expect(readiness.blockers[0]).toEqual({ id: 'update-required', message: '必须更新后才能继续生成', action: { label: '查看', to: '/settings/updates' } })
  })

  it('adds nothing when the update is not required or the state is unknown', () => {
    expect(deriveReadiness(input({ update: { supported: true, required: false, minimumVersion: '1.0.0' } })).blockers).toEqual([])
    expect(deriveReadiness(input({ update: null })).blockers).toEqual([])
    expect(deriveReadiness(input()).blockers).toEqual([])
  })
})

describe('studio/readiness rerunEligibility with a required update', () => {
  const card = canvas({ prompt: 'a street' })

  it('disables the rerun with the same reason as 生成, before anything else', () => {
    const update = { supported: true, required: true, minimumVersion: '1.2.0' }
    expect(rerunEligibility(card, { busy: false, submitting: false, update })).toEqual({ ok: false, reason: '必须更新到 1.2.0 才能继续生成' })
    // Even while busy or submitting, the update is the reason that matters.
    expect(rerunEligibility(card, { busy: true, submitting: true, update }).reason).toBe('必须更新到 1.2.0 才能继续生成')
    expect(rerunEligibility(card, { busy: false, submitting: false, update: { ...update, minimumVersion: null } }).reason).toBe('必须更新后才能继续生成')
  })

  it('reruns as before when no update is required or the state is unknown', () => {
    expect(rerunEligibility(card, { busy: false, submitting: false, update: { supported: true, required: false, minimumVersion: '1.0.0' } })).toEqual({ ok: true })
    expect(rerunEligibility(card, { busy: false, submitting: false, update: null })).toEqual({ ok: true })
    expect(rerunEligibility(card, { busy: false, submitting: false })).toEqual({ ok: true })
  })

  it('updateRequiredReason is the one wording for both', () => {
    expect(updateRequiredReason({ supported: false, required: true, minimumVersion: '2.0.0' })).toBe('必须更新到 2.0.0 才能继续生成')
    expect(updateRequiredReason({ supported: true, required: false, minimumVersion: '2.0.0' })).toBeNull()
    expect(updateRequiredReason(undefined)).toBeNull()
  })
})

describe('studio/readiness on a CLI engine (兼容模式 / AMD 原生)', () => {
  const lora = canvas({ prompt: 'a street', adapters: [{ id: 'style', strength: 1 }] })

  it('blocks LoRAs with the engine named, and only when the engine cannot load them', () => {
    expect(deriveReadiness(input({ canvas: lora, features: cliEngineFeatures('vulkan') })).blockers)
      .toEqual([{ id: 'lora-unsupported', message: '兼容模式引擎不支持 LoRA，请移除 LoRA 后再生成' }])
    expect(deriveReadiness(input({ canvas: lora, features: cliEngineFeatures('hip') })).blockers[0]!.message)
      .toBe('AMD 原生引擎不支持 LoRA，请移除 LoRA 后再生成')
    expect(deriveReadiness(input({ canvas: lora, features: engineFeaturesFixture() })).blockers).toEqual([])
    // Unknown (still reading) or no engine: nothing is known to be unsupported.
    expect(deriveReadiness(input({ canvas: lora, features: undefined })).blockers).toEqual([])
    expect(deriveReadiness(input({ canvas: lora, features: null })).blockers).toEqual([])
  })

  it('a remote run keeps its own LoRA message', () => {
    const { blockers } = deriveReadiness(input({ canvas: lora, features: cliEngineFeatures('vulkan'), remote: { name: 'Lab', modelPath: '/m' } }))
    expect(blockers.map((blocker) => blocker.id)).toEqual(['remote-adapters'])
  })

  it('blocks a bundle that is not a bf16 diffusers folder, with where to fix it', () => {
    const cat = catalog({
      bundles: [bundle('fp16'), bundle('comfy'), bundle('sft')],
      models: [
        model('fp16-dit'), model('comfy-dit'), model('sft-dit'), model('te'), model('vae'), model('cfg'),
      ].map((entry) => entry.id === 'fp16-dit' ? { ...entry, precision: 'fp16' } : entry.id === 'comfy-dit' ? { ...entry, format: 'comfyui' as const } : entry),
    })
    const pick = (id: string) => input({ catalog: cat, bundle: resolveBundle(cat, id, null), features: cliEngineFeatures('vulkan') })
    expect(deriveReadiness(pick('fp16')).blockers).toEqual([{
      id: 'model-engine', message: '「FP16」不是 bf16 模型，兼容模式引擎只能用 bf16 的 MOSS-Image，请换一个模型', action: { label: '去下载', to: '/models' },
    }])
    expect(deriveReadiness(pick('comfy')).blockers[0]).toMatchObject({ id: 'model-engine', message: expect.stringContaining('扫描到的单个模型文件') })
    expect(deriveReadiness(pick('sft')).blockers).toEqual([])
    // The server engine runs all of them.
    expect(deriveReadiness({ ...pick('fp16'), features: engineFeaturesFixture() }).blockers).toEqual([])
  })
})
