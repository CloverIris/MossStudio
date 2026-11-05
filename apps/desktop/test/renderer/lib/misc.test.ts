import { describe, expect, it } from 'vitest'
import { cloverUrl } from '@renderer/lib/clover'
import { t } from '@renderer/lib/i18n'

describe('lib/clover cloverUrl', () => {
  it('encodes Windows and POSIX paths into the clover:// protocol', () => {
    expect(cloverUrl('C:\\Users\\me\\out 1.png')).toBe('clover://local?path=C%3A%5CUsers%5Cme%5Cout%201.png')
    expect(cloverUrl('/tmp/a&b?.png')).toBe('clover://local?path=%2Ftmp%2Fa%26b%3F.png')
    expect(new URL(cloverUrl('/x/图.png')).searchParams.get('path')).toBe('/x/图.png')
  })
})

describe('lib/i18n t', () => {
  it('returns the message for a key', () => {
    expect(t('app.name')).toBe('MossStudio')
    expect(t('common.save')).toBe('保存')
  })
})
