import { describe, expect, it } from 'vitest'
import { AGENT_TOOL_NAMES, AGENT_TOOLS, resolveToolset, toolByName, toolDefinitions, toolSchema } from '@shared/agent/registry'
import { TOOL_SCHEMAS } from '@shared/agent/schemas'
import { schemas } from '@shared/schemas'

interface JsonSchema {
  type?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
  minLength?: number
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  description?: string
}

const tool = (name: Parameters<typeof toolSchema>[0]) => toolSchema(name) as JsonSchema

function walk(schema: JsonSchema, visit: (node: JsonSchema, path: string) => void, path = '$') {
  visit(schema, path)
  for (const [key, child] of Object.entries(schema.properties ?? {})) walk(child, visit, `${path}.${key}`)
}

describe('agent tools', () => {
  it('names every tool once, in snake_case under the studio_ prefix', () => {
    const names = AGENT_TOOLS.map((item) => item.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...AGENT_TOOL_NAMES]).toEqual(names)
    for (const name of names) expect(name).toMatch(/^studio_[a-z]+(?:_[a-z]+)*$/)
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([...names].sort())
  })

  it('gives every tool a Chinese name, a pack and prose for the model', () => {
    for (const item of AGENT_TOOLS) {
      expect(item.title.trim(), item.name).not.toBe('')
      expect(item.description.trim().length, item.name).toBeGreaterThan(20)
      expect(item.summarize({}), item.name).not.toBe('')
    }
  })

  it('publishes one closed JSON Schema per tool, without the $schema key', () => {
    const definitions = toolDefinitions()
    expect(definitions.map((item) => item.name)).toEqual([...AGENT_TOOL_NAMES])
    for (const definition of definitions) {
      expect(definition.inputSchema.$schema, definition.name).toBeUndefined()
      const schema = definition.inputSchema as JsonSchema
      expect(schema.type, definition.name).toBe('object')
      expect(schema.additionalProperties, definition.name).toBe(false)
      walk(schema, (node, path) => {
        if (node.type !== 'object') return
        expect(node.additionalProperties, `${definition.name} ${path}`).toBe(false)
        for (const key of node.required ?? []) expect(Object.keys(node.properties ?? {}), `${definition.name} ${path}`).toContain(key)
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

  it('keeps text regions on their own tool, with both strings required', () => {
    expect(tool('studio_add_layer').properties!.label!.enum).toEqual(['object', 'character'])
    const text = tool('studio_add_text_layer')
    expect(text.properties!.label).toBeUndefined()
    expect(text.required).toEqual(['caption', 'text'])
    expect(text.properties!.text!.minLength).toBe(1)
  })

  it('addresses existing regions by index and treats every patch field as optional', () => {
    const update = tool('studio_update_layer')
    expect(update.required).toEqual(['index'])
    expect(update.properties!.index!.minimum).toBe(1)
    expect(Object.keys(update.properties!).sort()).toEqual(['bbox', 'caption', 'index', 'opacity', 'text', 'visible'])
    expect(tool('studio_remove_layer').required).toEqual(['index'])
  })

  it('requires a full normalised bbox when one is given', () => {
    const bbox = tool('studio_add_text_layer').properties!.bbox!
    expect(bbox.required).toEqual(['x', 'y', 'w', 'h'])
    expect(bbox.properties!.w!.minimum).toBeGreaterThan(0)
    for (const key of ['x', 'y', 'w', 'h']) expect(bbox.properties![key]!.maximum).toBe(1)
  })

  it('summarises a call in the words the chat shows', () => {
    expect(toolByName('studio_add_text_layer')!.summarize({ caption: 'gold', text: '新年快乐' })).toBe('文字「新年快乐」')
    expect(toolByName('studio_add_layer')!.summarize({ label: 'character', caption: 'Luo Tianyi' })).toBe('人物「Luo Tianyi」')
    expect(toolByName('studio_set_sampler')!.summarize({ width: 1024, height: 1024, steps: 8 })).toBe('参数 1024×1024 · 8 步')
    expect(toolByName('nothing_here')).toBeUndefined()
  })
})

describe('resolveToolset', () => {
  it('mounts nothing for a provider that cannot call tools', () => {
    expect(resolveToolset({ toolsSupported: false })).toEqual([])
  })

  it('mounts the canvas tools on the Studio and only reads elsewhere', () => {
    expect(resolveToolset().map((item) => item.name)).toEqual([...AGENT_TOOL_NAMES])
    expect(resolveToolset({ page: 'studio' })).toHaveLength(AGENT_TOOLS.length)
    expect(resolveToolset({ page: 'models' }).every((item) => item.pack === 'canvas.read')).toBe(true)
  })

  it('mounts the same tools in both modes: the mode changes how they apply', () => {
    expect(resolveToolset({ mode: 'advanced' })).toEqual(resolveToolset({ mode: 'auto' }))
  })
})
