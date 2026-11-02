import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADAPTERS_PER_CANVAS_MAX,
  AdapterResolutionError,
  adapterStatuses,
  clampAdapterStrength,
  formatAdapterStrength,
  isAdapterId,
  isSelectableAdapter,
  normalizeCanvasAdapters,
  resolveAdapterSelection,
} from '../apps/desktop/src/shared/adapters.ts'

test('adapter ids stay inside a single path segment', () => {
  assert.equal(isAdapterId('style-anime-v2'), true)
  assert.equal(isAdapterId('trained-artifact-test'), true)
  assert.equal(isAdapterId('..'), false)
  assert.equal(isAdapterId('../etc/passwd'), false)
  assert.equal(isAdapterId('/abs/path'), false)
  assert.equal(isAdapterId('.hidden'), false)
  assert.equal(isAdapterId(''), false)
  assert.equal(isAdapterId(42), false)
})

test('strength is clamped to 0–2 and rounded to the slider step', () => {
  assert.equal(clampAdapterStrength(0.845), 0.85)
  assert.equal(clampAdapterStrength(-3), 0)
  assert.equal(clampAdapterStrength(9), 2)
  assert.equal(clampAdapterStrength('1.5'), 1.5)
  assert.equal(clampAdapterStrength(undefined), 1)
  assert.equal(clampAdapterStrength(Number.NaN), 1)
  assert.equal(formatAdapterStrength(1), '1')
  assert.equal(formatAdapterStrength(0.8), '0.8')
  assert.equal(formatAdapterStrength(0.855), '0.86')
})

test('normalize drops junk, dedupes and caps the list', () => {
  const result = normalizeCanvasAdapters([
    { id: 'style-a', strength: 0.8 },
    { id: 'style-a', strength: 1.4 },
    { id: '..', strength: 1 },
    { id: '', strength: 1 },
    null,
    'style-b',
    { id: 'style-b', strength: 5 },
    { id: 'style-c', strength: Number.NaN, path: ' C:\\models\\c.safetensors ' },
  ])
  assert.deepEqual(result, [
    { id: 'style-a', strength: 0.8 },
    { id: 'style-b', strength: 2 },
    { id: 'style-c', strength: 1, path: 'C:\\models\\c.safetensors' },
  ])
  assert.deepEqual(normalizeCanvasAdapters(undefined), [])
  assert.deepEqual(normalizeCanvasAdapters({ id: 'style-a' }), [])

  const many = Array.from({ length: ADAPTERS_PER_CANVAS_MAX + 5 }, (_, index) => ({ id: `lora-${index}`, strength: 1 }))
  assert.equal(normalizeCanvasAdapters(many).length, ADAPTERS_PER_CANVAS_MAX)
})

test('statuses flag adapters that left the library', () => {
  const catalog = [
    { id: 'style-a', name: '风格 A', kind: 'lora', installed: true },
    { id: 'style-b', name: '风格 B', kind: 'lora', installed: false },
    { id: 'dmd8-sft', name: '8-step DMD', kind: 'dmd', installed: true },
  ]
  const statuses = adapterStatuses([{ id: 'style-a', strength: 0.8 }, { id: 'style-b', strength: 1 }, { id: 'gone', strength: 1 }], catalog)
  assert.deepEqual(statuses.map((item) => [item.name, item.installed]), [
    ['风格 A', true],
    ['风格 B', false],
    ['gone', false],
  ])
  assert.equal(isSelectableAdapter(catalog[0]), true)
  assert.equal(isSelectableAdapter(catalog[1]), false)
  assert.equal(isSelectableAdapter(catalog[2]), false)
})

test('resolution keeps order and strength, and reports every missing adapter', async () => {
  const files = new Map([['style-a', '/models/adapters/style-a/a.safetensors'], ['style-c', '/models/adapters/style-c/c.safetensors']])
  const names = new Map([['style-b', '风格 B'], ['gone', '幽灵 LoRA']])
  const resolver = {
    resolveFile: async (id) => files.get(id) ?? null,
    nameOf: async (id) => names.get(id) ?? id,
  }

  assert.deepEqual(
    await resolveAdapterSelection([{ id: 'style-c', strength: 0.4 }, { id: 'style-a', strength: 1.5 }], resolver),
    [
      { path: '/models/adapters/style-c/c.safetensors', strength: 0.4 },
      { path: '/models/adapters/style-a/a.safetensors', strength: 1.5 },
    ],
  )
  assert.deepEqual(await resolveAdapterSelection([], resolver), [])

  // One unreadable lookup must not abort the others; the error names both.
  const failing = {
    resolveFile: async (id) => {
      if (id === 'boom') throw new Error('EACCES')
      return files.get(id) ?? null
    },
    nameOf: resolver.nameOf,
  }
  await assert.rejects(
    () => resolveAdapterSelection([{ id: 'style-a', strength: 1 }, { id: 'style-b', strength: 1 }, { id: 'gone', strength: 1 }, { id: 'boom', strength: 1 }], failing),
    (error) => {
      assert.equal(error instanceof AdapterResolutionError, true)
      assert.match(error.message, /「风格 B」/)
      assert.match(error.message, /「幽灵 LoRA」/)
      assert.match(error.message, /「boom」/)
      assert.doesNotMatch(error.message, /「style-a」/)
      assert.match(error.message, /未安装或权重文件缺失/)
      return true
    },
  )
})
