import { describe, expect, it } from 'vitest'
import { AI_PROVIDER_PRESETS } from '@shared/ai'
import { schemas } from '@shared/schemas'

describe('AI_PROVIDER_PRESETS', () => {
  it('has unique names', () => {
    const names = AI_PROVIDER_PRESETS.map((preset) => preset.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('covers every provider kind', () => {
    expect(new Set(AI_PROVIDER_PRESETS.map((preset) => preset.kind))).toEqual(new Set(['openai', 'anthropic', 'gemini', 'ollama']))
  })

  it('can be saved as-is through the provider IPC schema', () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      const parsed = schemas.aiProviderSave.safeParse(preset)
      expect(parsed.success, preset.name).toBe(true)
    }
  })

  it('uses http(s) base URLs without a trailing slash', () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      expect(preset.baseUrl, preset.name).toMatch(/^https?:\/\/[^/]+/)
      expect(preset.baseUrl.endsWith('/'), preset.name).toBe(false)
    }
  })

  it('only uses plain http for the local Ollama endpoint', () => {
    for (const preset of AI_PROVIDER_PRESETS.filter((item) => item.baseUrl.startsWith('http://'))) {
      expect(preset.kind).toBe('ollama')
      expect(new URL(preset.baseUrl).hostname).toBe('127.0.0.1')
    }
  })

  it('names a model for every preset', () => {
    for (const preset of AI_PROVIDER_PRESETS) expect(preset.model.trim(), preset.name).not.toBe('')
  })
})
