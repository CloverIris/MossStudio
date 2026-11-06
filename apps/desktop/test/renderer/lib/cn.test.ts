import { describe, expect, it } from 'vitest'
import { cn } from '@renderer/components/cn'

describe('cn', () => {
  it('keeps a theme font size next to a theme colour', () => {
    expect(cn('text-caption text-ink-2')).toBe('text-caption text-ink-2')
    for (const size of ['micro', 'caption', 'ui', 'control', 'section', 'title', 'display']) {
      expect(cn(`text-${size}`, 'text-danger')).toBe(`text-${size} text-danger`)
    }
  })

  it('lets a later class win for the same property', () => {
    expect(cn('text-ink', 'text-danger')).toBe('text-danger')
    expect(cn('bg-transparent text-ink enabled:hover:bg-well', 'text-danger')).toBe('bg-transparent enabled:hover:bg-well text-danger')
    expect(cn('size-8', 'size-7')).toBe('size-7')
    expect(cn('h-[30px] px-3', 'h-[26px] px-2')).toBe('h-[26px] px-2')
    expect(cn('text-caption', 'text-ui')).toBe('text-ui')
    expect(cn('bg-panel', 'bg-surface')).toBe('bg-surface')
    expect(cn('bg-well', 'bg-well-strong')).toBe('bg-well-strong')
  })

  it('knows the theme radii and shadow', () => {
    expect(cn('rounded-md', 'rounded-card')).toBe('rounded-card')
    expect(cn('shadow-float', 'shadow-none')).toBe('shadow-none')
    expect(cn('shadow-float bg-raised')).toBe('shadow-float bg-raised')
  })

  it('treats the legacy text colour aliases as colours', () => {
    expect(cn('text-caption text-secondary')).toBe('text-caption text-secondary')
    expect(cn('text-primary', 'text-ink')).toBe('text-ink')
  })

  it('skips falsy values and keeps classes it does not know', () => {
    expect(cn('ui-field', false, null, undefined, 'tabular selectable')).toBe('ui-field tabular selectable')
  })
})
