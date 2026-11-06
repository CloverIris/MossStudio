import { describe, expect, it } from 'vitest'
import {
  commitText,
  createCommitGuard,
  integerInRange,
  optionalHfEndpoint,
  optionalHttpUrl,
  optionalProxyUrl,
  requiredText,
  singleLineToken,
  textOf,
} from '@renderer/lib/settingsDraft'

describe('validators', () => {
  it('accepts empty and http(s) URLs, rejects the rest with a reason', () => {
    expect(optionalHttpUrl('')).toBeNull()
    expect(optionalHttpUrl('  ')).toBeNull()
    expect(optionalHttpUrl('https://hf-mirror.com')).toBeNull()
    expect(optionalHttpUrl('ftp://x.test')).toMatch(/http/)
    expect(optionalHttpUrl('hf-mirror.com')).toMatch(/有效/)
    expect(optionalHttpUrl('https://user:pw@x.test')).toMatch(/用户名/)
  })

  it('rejects HF endpoints with a query or fragment', () => {
    expect(optionalHfEndpoint('https://hf-mirror.com')).toBeNull()
    expect(optionalHfEndpoint('https://hf-mirror.com/?a=1')).toMatch(/\?/)
  })

  it('checks proxy URLs', () => {
    expect(optionalProxyUrl('')).toBeNull()
    expect(optionalProxyUrl('socks5h://127.0.0.1:7890')).toBeNull()
    expect(optionalProxyUrl('http://127.0.0.1:7890/path')).toMatch(/只需要/)
    expect(optionalProxyUrl('ws://127.0.0.1')).toMatch(/socks5/)
  })

  it('checks integer ranges', () => {
    const port = integerInRange(1024, 65535, { optional: true })
    expect(port('')).toBeNull()
    expect(port('8080')).toBeNull()
    expect(port('80')).toMatch(/1024/)
    expect(port('8a')).toMatch(/整数/)
    expect(integerInRange(1, 16)('')).toMatch(/1 到 16/)
  })

  it('checks tokens and required text', () => {
    expect(singleLineToken('hf_abc')).toBeNull()
    expect(singleLineToken('hf_\nabc')).toMatch(/换行/)
    expect(requiredText('地址')('  ')).toBe('地址不能为空')
    expect(requiredText('地址')('x')).toBeNull()
  })
})

describe('commitText', () => {
  it('stores trimmed text, and empty as null (use the default)', () => {
    expect(commitText(' https://a.test ', null)).toEqual({ kind: 'save', value: 'https://a.test' })
    expect(commitText('', 'https://a.test')).toEqual({ kind: 'save', value: null })
  })

  it('does nothing when the value did not change', () => {
    expect(commitText('https://a.test', 'https://a.test')).toEqual({ kind: 'unchanged' })
    expect(commitText('', null)).toEqual({ kind: 'unchanged' })
  })

  it('keeps invalid input out of settings', () => {
    expect(commitText('nope', null, { validate: optionalHttpUrl })).toMatchObject({ kind: 'invalid' })
  })

  it('parses numbers', () => {
    expect(commitText('8', 4, { validate: integerInRange(1, 16), parse: Number })).toEqual({ kind: 'save', value: 8 })
    expect(commitText('4', 4, { parse: Number })).toEqual({ kind: 'unchanged' })
    expect(commitText('', 8080 as number | null, { parse: (text) => (text ? Number(text) : null) })).toEqual({ kind: 'save', value: null })
  })

  it('shows stored values as text', () => {
    expect(textOf(null)).toBe('')
    expect(textOf(4)).toBe('4')
    expect(textOf('x')).toBe('x')
  })
})

describe('createCommitGuard', () => {
  it('saves the same text once when Enter is followed by blur', () => {
    const guard = createCommitGuard()
    expect(guard.shouldCommit('hf_abc')).toBe(true)
    guard.sent('hf_abc')
    // Blur arrives before the saved value comes back.
    expect(guard.shouldCommit('hf_abc')).toBe(false)
  })

  it('allows new text, a retry after failure, and a reset', () => {
    const guard = createCommitGuard()
    guard.sent('a')
    expect(guard.shouldCommit('b')).toBe(true)
    guard.failed()
    expect(guard.shouldCommit('a')).toBe(true)
    guard.sent('a')
    guard.reset()
    expect(guard.shouldCommit('a')).toBe(true)
  })
})
