import { describe, expect, it } from 'vitest'
import { STUDIO_TOOL_NAMES, STUDIO_TOOLS } from '@shared/mcp'
import { schemas } from '@shared/schemas'

interface JsonSchema {
  type?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  description?: string
}

const tool = (name: string) => {
  const found = STUDIO_TOOLS.find((item) => item.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found.inputSchema as JsonSchema
}

function walk(schema: JsonSchema, visit: (node: JsonSchema, path: string) => void, path = '$') {
  visit(schema, path)
  for (const [key, child] of Object.entries(schema.properties ?? {})) walk(child, visit, `${path}.${key}`)
}

describe('STUDIO_TOOLS', () => {
  it('exposes the expected tools with unique snake_case studio_ names', () => {
    const names = STUDIO_TOOLS.map((item) => item.name)
    expect(names).toEqual(['studio_read_context', 'studio_set_prompt', 'studio_set_sampler', 'studio_add_layer', 'studio_generate'])
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^studio_[a-z]+(?:_[a-z]+)*$/)
  })

  it('describes every tool in prose', () => {
    for (const item of STUDIO_TOOLS) expect(item.description.trim().length).toBeGreaterThan(20)
  })

  it('uses closed object schemas whose required fields exist', () => {
    for (const item of STUDIO_TOOLS) {
      walk(item.inputSchema as JsonSchema, (node, path) => {
        if (node.type !== 'object') return
        expect(node.additionalProperties, `${item.name} ${path}`).toBe(false)
        expect(node.properties, `${item.name} ${path}`).toBeDefined()
        for (const key of node.required ?? []) expect(Object.keys(node.properties ?? {}), `${item.name} ${path}`).toContain(key)
      })
    }
  })

  it('keeps numeric ranges well-formed', () => {
    for (const item of STUDIO_TOOLS) {
      walk(item.inputSchema as JsonSchema, (node, path) => {
        if (node.minimum !== undefined && node.maximum !== undefined) {
          expect(node.minimum, `${item.name} ${path}`).toBeLessThanOrEqual(node.maximum)
        }
      })
    }
  })

  it('advertises sampler limits the jobStart IPC schema accepts', () => {
    const sampler = tool('studio_set_sampler').properties!
    const base = { instanceId: 'i', prompt: 'p', width: 512, height: 512, steps: 20, cfg: 5, seed: 1 }
    for (const field of ['width', 'height', 'steps', 'cfg'] as const) {
      const { minimum, maximum } = sampler[field]!
      expect(schemas.jobStart.safeParse({ ...base, [field]: minimum }).success, `${field} min`).toBe(true)
      expect(schemas.jobStart.safeParse({ ...base, [field]: maximum }).success, `${field} max`).toBe(true)
    }
  })

  it('offers the same layer kinds a project layer can hold', () => {
    const labels = tool('studio_add_layer').properties!.label!.enum
    for (const kind of labels ?? []) {
      expect(
        schemas.projectLayer.safeParse({ id: 'l', kind, caption: '', bbox: [0, 0, 1, 1], visible: true, locked: false, opacity: 1 })
          .success,
      ).toBe(true)
    }
    expect(labels).toEqual(['object', 'character', 'text'])
  })

  it('requires a full normalised bbox when one is given', () => {
    const bbox = tool('studio_add_layer').properties!.bbox!
    expect(bbox.required).toEqual(['x', 'y', 'w', 'h'])
    expect(bbox.properties!.w!.minimum).toBeGreaterThan(0)
    for (const key of ['x', 'y', 'w', 'h']) expect(bbox.properties![key]!.maximum).toBe(1)
  })
})

describe('STUDIO_TOOL_NAMES', () => {
  it('mirrors the tool list', () => {
    expect([...STUDIO_TOOL_NAMES]).toEqual(STUDIO_TOOLS.map((item) => item.name))
    expect(STUDIO_TOOL_NAMES.has('studio_generate')).toBe(true)
    expect(STUDIO_TOOL_NAMES.has('studio_delete_everything')).toBe(false)
  })
})
