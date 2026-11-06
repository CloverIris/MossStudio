import { describe, expect, it } from 'vitest'
import { legacyWarning } from '@shared/setup'

describe('legacyWarning', () => {
  const legacy = { warnings: { reuse: '请不要删除这个文件夹', fresh: '可以手动删除这个文件夹' } }
  it('shows the note of the chosen mode, and none in place', () => {
    expect(legacyWarning(legacy, 'reuse', false)).toBe('请不要删除这个文件夹')
    expect(legacyWarning(legacy, 'fresh', false)).toBe('可以手动删除这个文件夹')
    expect(legacyWarning(legacy, 'reuse', true)).toBeNull()
    expect(legacyWarning(legacy, 'fresh', true)).toBeNull()
  })
})
