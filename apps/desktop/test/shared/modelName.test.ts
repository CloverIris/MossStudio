import { describe, expect, it } from 'vitest'
import catalog from '../../resources/models.json'
import { nameParts } from '@shared/modelName'

describe('nameParts', () => {
  it('splits the variant words off the end of the name', () => {
    expect(nameParts({ name: 'MOSS-Image SFT Turbo INT8 8 步', variant: ['INT8', '8 步'] })).toEqual({
      base: 'MOSS-Image SFT Turbo',
      variant: ['INT8', '8 步'],
    })
    expect(nameParts({ name: 'MOSS-Image SFT' })).toEqual({ base: 'MOSS-Image SFT', variant: [] })
  })

  it('shows a name whole when it does not end with its variant words', () => {
    expect(nameParts({ name: 'SFT · INT8', variant: ['INT4'] })).toEqual({ base: 'SFT · INT8', variant: [] })
    expect(nameParts({ name: 'INT8', variant: ['INT8'] })).toEqual({ base: 'INT8', variant: [] })
  })

  it('every name in the shipped catalog ends with its variant and has no "·"', () => {
    const items = [...catalog.models, ...catalog.bundles, ...catalog.single_file_bundles]
    for (const item of items) {
      expect(item.name, item.id).not.toContain('·')
      const variant = 'variant' in item ? (item.variant as string[]) : []
      if (variant.length) expect(nameParts({ name: item.name, variant }).variant, item.id).toEqual(variant)
    }
  })
})
