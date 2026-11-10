import { describe, expect, it } from 'vitest'
import { GBC_MAX_REGIONS, PARSE_CHECKING, gbcBlocker, gbcCanUse, regionsFromGraph, type GbcGraph, type GbcVertex } from '@shared/gbc'

const box = (left: number, top: number, right: number, bottom: number): GbcVertex['bbox'] => ({
  left,
  top,
  right,
  bottom,
  confidence: null,
})
const fromImage = [{ source: '', text: 'cat', target: 'cat' }]

// The shape ml-gbc writes: the image vertex has id "", its captions carry `label`.
const graph: GbcGraph = {
  vertices: [
    {
      vertex_id: '',
      label: 'image',
      bbox: box(0, 0, 1, 1),
      descs: [
        { text: 'A cat asleep on a sill.', label: 'short' },
        { text: 'An orange cat sleeps on a sunny window sill beside a white mug.', label: 'detail' },
      ],
    },
    {
      vertex_id: 'cat',
      label: 'entity',
      bbox: box(0.3, 0.5, 0.75, 0.72),
      descs: [
        { text: 'an orange cat curled up, eyes closed, fur lit by the sun', label: 'detail' },
        { text: 'a sleeping orange cat', label: 'short' },
      ],
      in_edges: fromImage,
    },
    {
      vertex_id: 'mug',
      label: 'entity',
      bbox: box(0.8, 0.6, 0.92, 0.72),
      descs: [{ text: 'a white mug', label: 'short' }],
      in_edges: [{ source: '', text: 'mug', target: 'mug' }],
    },
    // A part of the cat: under the cat, not the image, so it would only crowd the 画面.
    {
      vertex_id: 'cat/ear',
      label: 'entity',
      bbox: box(0.32, 0.5, 0.4, 0.56),
      descs: [{ text: 'a pointed ear', label: 'short' }],
      in_edges: [{ source: 'cat', text: 'ear', target: 'cat/ear' }],
    },
    { vertex_id: 'rel', label: 'relation', bbox: box(0.3, 0.5, 0.92, 0.72), descs: [{ text: 'the mug is beside the cat' }] },
  ],
}

describe('regionsFromGraph', () => {
  it('turns the objects the picture names into regions, largest first, with their short captions', () => {
    const result = regionsFromGraph(graph)
    expect(result.summary).toBe('An orange cat sleeps on a sunny window sill beside a white mug.')
    expect(result.regions.map((region) => region.caption)).toEqual(['a sleeping orange cat', 'a white mug'])
    expect(result.regions[0]!.bbox.x).toBeCloseTo(0.3)
    expect(result.regions[0]!.bbox.y).toBeCloseTo(0.5)
    expect(result.regions[0]!.bbox.w).toBeCloseTo(0.45)
    expect(result.regions[0]!.bbox.h).toBeCloseTo(0.22)
  })

  it('keeps every entity when the graph does not say which are top level', () => {
    const flat: GbcGraph = { vertices: graph.vertices!.map(({ in_edges: _edges, ...vertex }) => vertex) }
    expect(regionsFromGraph(flat).regions.map((region) => region.caption)).toEqual([
      'a sleeping orange cat',
      'a white mug',
      'a pointed ear',
    ])
  })

  it('reads captions written with `kind` and falls back to the first caption', () => {
    const result = regionsFromGraph({
      vertices: [
        { vertex_id: 'img', label: 'image', descs: [{ text: 'a room', kind: 'long' }] },
        {
          vertex_id: 'lamp',
          label: 'entity',
          bbox: box(0.1, 0.1, 0.3, 0.5),
          descs: [{ text: 'a tall lamp' }],
          in_edges: [{ source: 'img' }],
        },
      ],
    })
    expect(result.summary).toBe('a room')
    expect(result.regions).toEqual([{ caption: 'a tall lamp', bbox: { x: 0.1, y: 0.1, w: expect.closeTo(0.2), h: expect.closeTo(0.4) } }])
  })

  it('drops boxes that cover the whole picture, have no size or no words, and pulls boxes inside the picture', () => {
    const result = regionsFromGraph({
      vertices: [
        { vertex_id: 'whole', label: 'entity', bbox: box(0, 0, 1, 0.98), descs: [{ text: 'the scene' }] },
        { vertex_id: 'flat', label: 'entity', bbox: box(0.2, 0.2, 0.2, 0.6), descs: [{ text: 'a line' }] },
        { vertex_id: 'mute', label: 'entity', bbox: box(0.1, 0.1, 0.4, 0.4), descs: [{ text: '  ' }] },
        { vertex_id: 'edge', label: 'entity', bbox: box(-0.2, 0.5, 0.3, 1.4), descs: [{ text: 'a chair' }] },
      ],
    })
    expect(result.summary).toBe('')
    expect(result.regions).toEqual([{ caption: 'a chair', bbox: { x: 0, y: 0.5, w: 0.3, h: 0.5 } }])
  })

  it(`keeps at most ${GBC_MAX_REGIONS} regions, the largest`, () => {
    const vertices: GbcVertex[] = Array.from({ length: GBC_MAX_REGIONS + 3 }, (_, index) => ({
      vertex_id: `v${index}`,
      label: 'entity',
      bbox: box(0, 0, 0.05 + index * 0.01, 0.5),
      descs: [{ text: `thing ${index}` }],
    }))
    const regions = regionsFromGraph({ vertices }).regions
    expect(regions).toHaveLength(GBC_MAX_REGIONS)
    expect(regions[0]!.caption).toBe(`thing ${GBC_MAX_REGIONS + 2}`)
    expect(regions.some((region) => region.caption === 'thing 0')).toBe(false)
  })

  it('gives nothing for an empty graph', () => {
    expect(regionsFromGraph({})).toEqual({ summary: '', regions: [] })
  })
})

describe('gbcBlocker', () => {
  const claude = { kind: 'anthropic', hasKey: true }

  it('only an OpenAI-compatible or Anthropic model with a key can read pictures', () => {
    expect(gbcCanUse(claude)).toBe(true)
    expect(gbcCanUse({ kind: 'openai', hasKey: true })).toBe(true)
    expect(gbcCanUse({ kind: 'openai', hasKey: false })).toBe(false)
    expect(gbcCanUse({ kind: 'ollama', hasKey: true })).toBe(false)
    expect(gbcCanUse({ kind: 'gemini', hasKey: true })).toBe(false)
  })

  it('says what is missing, in the order the person fixes it', () => {
    expect(gbcBlocker(undefined, [])).toBe(PARSE_CHECKING)
    expect(gbcBlocker({ available: true }, [{ kind: 'ollama', hasKey: true }])).toBe('先给助手加一个模型')
    expect(gbcBlocker({ available: false }, [claude])).toBe('看图还没装好')
    expect(gbcBlocker(null, [claude])).toBe('看图还没装好')
    expect(gbcBlocker({ available: true }, [claude])).toBeNull()
  })
})
