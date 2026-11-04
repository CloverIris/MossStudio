import { describe, expect, it, vi } from 'vitest'
import {
  ADAPTER_STRENGTH_DEFAULT,
  ADAPTER_STRENGTH_MAX,
  ADAPTER_STRENGTH_MIN,
  ADAPTERS_PER_CANVAS_MAX,
  AdapterResolutionError,
  type AdapterResolver,
  adapterStatuses,
  clampAdapterStrength,
  formatAdapterStrength,
  isAdapterId,
  isSelectableAdapter,
  normalizeCanvasAdapters,
  resolveAdapterSelection,
} from '@shared/adapters'
import type { AdapterEntry } from '@shared/types'

const entry = (id: string, overrides: Partial<AdapterEntry> = {}): AdapterEntry => ({
  id,
  name: id,
  provider: 'hf',
  repo: `org/${id}`,
  revision: 'main',
  kind: 'lora',
  license: 'apache-2.0',
  files: [`${id}.safetensors`],
  sizeBytes: 1,
  tags: [],
  installed: true,
  installedBytes: 1,
  ...overrides,
})

describe('isAdapterId', () => {
  it('accepts ids that are exactly one safe path segment', () => {
    expect(isAdapterId('style-anime-v2')).toBe(true)
    expect(isAdapterId('trained-artifact-test')).toBe(true)
    expect(isAdapterId('A.b_c-1')).toBe(true)
    expect(isAdapterId('9')).toBe(true)
  })

  it('rejects traversal, absolute, hidden and empty ids', () => {
    expect(isAdapterId('..')).toBe(false)
    expect(isAdapterId('../etc/passwd')).toBe(false)
    expect(isAdapterId('/abs/path')).toBe(false)
    expect(isAdapterId('a/b')).toBe(false)
    expect(isAdapterId('a\\b')).toBe(false)
    expect(isAdapterId('.hidden')).toBe(false)
    expect(isAdapterId('-dash')).toBe(false)
    expect(isAdapterId('_under')).toBe(false)
    expect(isAdapterId('')).toBe(false)
    expect(isAdapterId('has space')).toBe(false)
    expect(isAdapterId('风格')).toBe(false)
    expect(isAdapterId('trailing\n')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isAdapterId(42)).toBe(false)
    expect(isAdapterId(null)).toBe(false)
    expect(isAdapterId(undefined)).toBe(false)
    expect(isAdapterId({ id: 'x' })).toBe(false)
  })

  it('caps the id at 160 characters', () => {
    expect(isAdapterId('a'.repeat(160))).toBe(true)
    expect(isAdapterId('a'.repeat(161))).toBe(false)
  })
})

describe('clampAdapterStrength', () => {
  it('exposes a consistent range', () => {
    expect(ADAPTER_STRENGTH_MIN).toBe(0)
    expect(ADAPTER_STRENGTH_MAX).toBe(2)
    expect(ADAPTER_STRENGTH_DEFAULT).toBe(1)
  })

  it('clamps to 0–2 and rounds to the slider step', () => {
    expect(clampAdapterStrength(0.845)).toBe(0.85)
    expect(clampAdapterStrength(-3)).toBe(0)
    expect(clampAdapterStrength(9)).toBe(2)
    expect(clampAdapterStrength(0)).toBe(0)
    expect(clampAdapterStrength(2)).toBe(2)
    expect(clampAdapterStrength(0.123456)).toBe(0.12)
    expect(clampAdapterStrength(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampAdapterStrength(Number.NEGATIVE_INFINITY)).toBe(1)
  })

  it('parses numeric strings', () => {
    expect(clampAdapterStrength('1.5')).toBe(1.5)
    expect(clampAdapterStrength(' 0.25 ')).toBe(0.25)
    expect(clampAdapterStrength('5')).toBe(2)
  })

  it('uses the fallback for non-numeric input', () => {
    expect(clampAdapterStrength(undefined)).toBe(1)
    expect(clampAdapterStrength(Number.NaN)).toBe(1)
    expect(clampAdapterStrength('abc')).toBe(1)
    expect(clampAdapterStrength({})).toBe(1)
    expect(clampAdapterStrength('abc', 0.5)).toBe(0.5)
  })

  it('normalizes an out-of-range or invalid fallback too', () => {
    expect(clampAdapterStrength(undefined, 7)).toBe(2)
    expect(clampAdapterStrength(undefined, -1)).toBe(0)
    expect(clampAdapterStrength(undefined, 0.333)).toBe(0.33)
    expect(clampAdapterStrength(undefined, Number.NaN)).toBe(1)
  })
})

describe('formatAdapterStrength', () => {
  it('drops trailing zeros and the decimal point', () => {
    expect(formatAdapterStrength(1)).toBe('1')
    expect(formatAdapterStrength(2)).toBe('2')
    expect(formatAdapterStrength(0)).toBe('0')
    expect(formatAdapterStrength(0.8)).toBe('0.8')
    expect(formatAdapterStrength(1.5)).toBe('1.5')
    expect(formatAdapterStrength(0.05)).toBe('0.05')
  })

  it('rounds and clamps before formatting', () => {
    expect(formatAdapterStrength(0.855)).toBe('0.86')
    expect(formatAdapterStrength(0.85 + 1e-12)).toBe('0.85')
    expect(formatAdapterStrength(9)).toBe('2')
    expect(formatAdapterStrength(-1)).toBe('0')
    expect(formatAdapterStrength(Number.NaN)).toBe('1')
  })
})

describe('normalizeCanvasAdapters', () => {
  it('drops junk, dedupes and keeps the first occurrence', () => {
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
    expect(result).toEqual([
      { id: 'style-a', strength: 0.8 },
      { id: 'style-b', strength: 2 },
      { id: 'style-c', strength: 1, path: 'C:\\models\\c.safetensors' },
    ])
  })

  it('returns an empty list for anything that is not an array', () => {
    expect(normalizeCanvasAdapters(undefined)).toEqual([])
    expect(normalizeCanvasAdapters(null)).toEqual([])
    expect(normalizeCanvasAdapters({ id: 'style-a' })).toEqual([])
    expect(normalizeCanvasAdapters('style-a')).toEqual([])
  })

  it('trims ids and treats the trimmed id as the dedupe key', () => {
    expect(normalizeCanvasAdapters([{ id: '  style-a  ', strength: 1 }, { id: 'style-a', strength: 0.5 }])).toEqual([
      { id: 'style-a', strength: 1 },
    ])
  })

  it('ignores non-string ids and blank or non-string paths', () => {
    expect(
      normalizeCanvasAdapters([
        { id: 7, strength: 1 },
        { id: 'a', strength: 1, path: '   ' },
        { id: 'b', strength: 1, path: 42 },
      ]),
    ).toEqual([
      { id: 'a', strength: 1 },
      { id: 'b', strength: 1 },
    ])
  })

  it('defaults a missing strength and parses string strengths', () => {
    expect(normalizeCanvasAdapters([{ id: 'a' }, { id: 'b', strength: '0.4' }])).toEqual([
      { id: 'a', strength: 1 },
      { id: 'b', strength: 0.4 },
    ])
  })

  it('caps the list without letting rejected items consume the budget', () => {
    const many = Array.from({ length: ADAPTERS_PER_CANVAS_MAX + 5 }, (_, index) => ({ id: `lora-${index}`, strength: 1 }))
    const capped = normalizeCanvasAdapters(many)
    expect(capped).toHaveLength(ADAPTERS_PER_CANVAS_MAX)
    expect(capped.at(-1)?.id).toBe(`lora-${ADAPTERS_PER_CANVAS_MAX - 1}`)

    const withJunk = [null, { id: '..' }, ...many]
    expect(normalizeCanvasAdapters(withJunk).map((item) => item.id)).toEqual(capped.map((item) => item.id))
  })

  it('does not copy unknown fields from the input', () => {
    const [adapter] = normalizeCanvasAdapters([{ id: 'a', strength: 1, extra: 'x' }])
    expect(Object.keys(adapter ?? {})).toEqual(['id', 'strength'])
  })
})

describe('adapterStatuses', () => {
  const catalog: AdapterEntry[] = [
    entry('style-a', { name: '风格 A' }),
    entry('style-b', { name: '风格 B', installed: false }),
    entry('dmd8-sft', { name: '8-step DMD', kind: 'dmd' }),
    entry('nameless', { name: '' }),
  ]

  it('flags adapters that left the library', () => {
    const statuses = adapterStatuses(
      [{ id: 'style-a', strength: 0.8 }, { id: 'style-b', strength: 1 }, { id: 'gone', strength: 1 }],
      catalog,
    )
    expect(statuses.map((item) => [item.name, item.kind, item.installed])).toEqual([
      ['风格 A', 'lora', true],
      ['风格 B', 'lora', false],
      ['gone', null, false],
    ])
  })

  it('keeps the selected adapter object and order', () => {
    const selection = [{ id: 'dmd8-sft', strength: 0.3 }, { id: 'style-a', strength: 1 }]
    const statuses = adapterStatuses(selection, catalog)
    expect(statuses[0]?.adapter).toBe(selection[0])
    expect(statuses.map((item) => item.adapter.id)).toEqual(['dmd8-sft', 'style-a'])
  })

  it('falls back to the id when the catalog name is empty', () => {
    expect(adapterStatuses([{ id: 'nameless', strength: 1 }], catalog)[0]?.name).toBe('nameless')
  })

  it('treats a missing catalog as an empty library', () => {
    for (const missing of [null, undefined]) {
      expect(adapterStatuses([{ id: 'style-a', strength: 1 }], missing)).toEqual([
        { adapter: { id: 'style-a', strength: 1 }, name: 'style-a', kind: null, installed: false },
      ])
    }
  })
})

describe('isSelectableAdapter', () => {
  it('only offers installed, non-DMD adapters', () => {
    expect(isSelectableAdapter(entry('a'))).toBe(true)
    expect(isSelectableAdapter(entry('b', { kind: 'lycoris' }))).toBe(true)
    expect(isSelectableAdapter(entry('c', { installed: false }))).toBe(false)
    expect(isSelectableAdapter(entry('d', { kind: 'dmd' }))).toBe(false)
  })
})

describe('resolveAdapterSelection', () => {
  const files = new Map([
    ['style-a', '/models/adapters/style-a/a.safetensors'],
    ['style-c', '/models/adapters/style-c/c.safetensors'],
  ])
  const names = new Map([
    ['style-b', '风格 B'],
    ['gone', '幽灵 LoRA'],
  ])
  const resolver: AdapterResolver = {
    resolveFile: async (id) => files.get(id) ?? null,
    nameOf: async (id) => names.get(id) ?? id,
  }

  it('keeps order and strength', async () => {
    await expect(
      resolveAdapterSelection([{ id: 'style-c', strength: 0.4 }, { id: 'style-a', strength: 1.5 }], resolver),
    ).resolves.toEqual([
      { path: '/models/adapters/style-c/c.safetensors', strength: 0.4 },
      { path: '/models/adapters/style-a/a.safetensors', strength: 1.5 },
    ])
  })

  it('resolves an empty selection without touching the resolver', async () => {
    const spy: AdapterResolver = { resolveFile: vi.fn(resolver.resolveFile), nameOf: vi.fn(resolver.nameOf) }
    await expect(resolveAdapterSelection([], spy)).resolves.toEqual([])
    expect(spy.resolveFile).not.toHaveBeenCalled()
  })

  it('reports every missing adapter, including ones whose lookup throws', async () => {
    const failing: AdapterResolver = {
      resolveFile: async (id) => {
        if (id === 'boom') throw new Error('EACCES')
        return files.get(id) ?? null
      },
      nameOf: resolver.nameOf,
    }
    const error = await resolveAdapterSelection(
      [
        { id: 'style-a', strength: 1 },
        { id: 'style-b', strength: 1 },
        { id: 'gone', strength: 1 },
        { id: 'boom', strength: 1 },
      ],
      failing,
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AdapterResolutionError)
    expect(error).toBeInstanceOf(Error)
    const { message, name } = error as AdapterResolutionError
    expect(name).toBe('AdapterResolutionError')
    expect(message).toContain('「风格 B」「幽灵 LoRA」「boom」')
    expect(message).not.toContain('「style-a」')
    expect(message).toMatch(/未安装或权重文件缺失/)
  })

  it('treats an empty path as missing', async () => {
    const empty: AdapterResolver = { resolveFile: async () => '', nameOf: async (id) => id }
    await expect(resolveAdapterSelection([{ id: 'x', strength: 1 }], empty)).rejects.toThrow('「x」')
  })

  it('falls back to the id when the name lookup rejects', async () => {
    const noName: AdapterResolver = {
      resolveFile: async () => null,
      nameOf: async () => {
        throw new Error('catalog unavailable')
      },
    }
    await expect(resolveAdapterSelection([{ id: 'style-z', strength: 1 }], noName)).rejects.toThrow(
      AdapterResolutionError,
    )
    await expect(resolveAdapterSelection([{ id: 'style-z', strength: 1 }], noName)).rejects.toThrow('「style-z」')
  })

  it('only asks for names of the adapters that failed', async () => {
    const nameOf = vi.fn(async (id: string) => id)
    await expect(
      resolveAdapterSelection([{ id: 'style-a', strength: 1 }, { id: 'gone', strength: 1 }], {
        resolveFile: resolver.resolveFile,
        nameOf,
      }),
    ).rejects.toThrow(AdapterResolutionError)
    expect(nameOf.mock.calls).toEqual([['gone']])
  })
})
