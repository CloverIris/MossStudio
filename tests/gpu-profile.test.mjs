import assert from 'node:assert/strict'
import test from 'node:test'
import { recommendGpuMemoryMode, resolveGpuProfile, settingsForGpuProfile } from '../apps/desktop/src/shared/gpuProfile.ts'

const gpu = (uuid, memoryTotalBytes) => ({
  uuid,
  index: 0,
  name: 'Test GPU',
  memoryTotalBytes,
})

const settings = (overrides = {}, mode = 'auto') => ({
  gpuProfileMode: mode,
  gpuProfileOverrides: overrides,
  mossInferMemoryMode: 'balanced',
  mossInferTier: 'high',
})

test('GPU memory recommendations use total VRAM thresholds', () => {
  assert.equal(recommendGpuMemoryMode(gpu('under-six', 6 * 1024 ** 3 - 1)), 'min_memory')
  assert.equal(recommendGpuMemoryMode(gpu('six', 6 * 1024 ** 3)), 'balanced')
  assert.equal(recommendGpuMemoryMode(gpu('eight', 8 * 1024 ** 3)), 'balanced')
  assert.equal(recommendGpuMemoryMode(gpu('medium', 16 * 1024 ** 3)), 'balanced')
  assert.equal(recommendGpuMemoryMode(gpu('large', 24 * 1024 ** 3)), 'max_speed')
  assert.equal(recommendGpuMemoryMode(gpu('unknown', undefined)), null)
})

test('automatic profile falls back to global values when VRAM is unknown', () => {
  assert.deepEqual(resolveGpuProfile(settings(), gpu('unknown', undefined)), {
    memoryMode: 'balanced',
    tier: 'high',
    source: 'global',
  })
})

test('automatic profile selects recommended memory mode without changing tier', () => {
  assert.deepEqual(resolveGpuProfile(settings(), gpu('large', 24 * 1024 ** 3)), {
    memoryMode: 'max_speed',
    tier: 'high',
    source: 'recommended',
  })
})

test('per-GPU overrides take precedence and do not mutate settings', () => {
  const before = settings({ device: { memoryMode: 'min_memory', tier: 'reference' } })
  const result = resolveGpuProfile(before, gpu('device', 24 * 1024 ** 3))
  assert.deepEqual(result, {
    memoryMode: 'min_memory',
    tier: 'reference',
    source: 'gpu-override',
  })
  assert.equal(before.mossInferMemoryMode, 'balanced')
  assert.equal(before.mossInferTier, 'high')
})

test('execution settings only apply selected memory mode and tier', () => {
  const original = {
    ...settings(),
    mossInferServerPath: 'server.exe',
    inferenceBackend: 'mossinfer',
    gpuSelection: { uuid: 'device' },
  }
  const profile = resolveGpuProfile(settings(), gpu('device', 24 * 1024 ** 3))
  const execution = settingsForGpuProfile(original, profile)
  assert.equal(execution.mossInferMemoryMode, 'max_speed')
  assert.equal(execution.mossInferTier, 'high')
  assert.equal(execution.mossInferServerPath, original.mossInferServerPath)
  assert.deepEqual(execution.gpuSelection, original.gpuSelection)
  assert.equal(original.mossInferMemoryMode, 'balanced')
})

test('custom global profile is the fallback for GPUs without overrides', () => {
  const custom = { ...settings({}, 'custom'), mossInferMemoryMode: 'min_memory', mossInferTier: 'turbo' }
  assert.deepEqual(resolveGpuProfile(custom, gpu('device', 24 * 1024 ** 3)), {
    memoryMode: 'min_memory',
    tier: 'turbo',
    source: 'global',
  })
})
