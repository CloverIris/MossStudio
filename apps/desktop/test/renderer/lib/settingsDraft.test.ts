import { describe, expect, it } from 'vitest'
import {
  commitText,
  integerInRange,
  optionalHfEndpoint,
  optionalHttpUrl,
  optionalProxyUrl,
  requiredText,
  singleLineToken,
  textOf,
} from '@renderer/lib/settingsDraft'

describe('lib/settingsDraft validators', () => {
  it.each([
    ['', null],
    ['   ', null],
    ['https://hf-mirror.com', null],
    [' http://10.0.0.2:8080/path ', null],
    ['ftp://example.com', '地址需要以 http:// 或 https:// 开头'],
    ['https://user:pw@example.com', '地址里不能包含用户名或密码'],
    ['https://user@example.com', '地址里不能包含用户名或密码'],
    ['hf-mirror.com', '这不是有效的网址，例如 https://hf-mirror.com'],
  ])('optionalHttpUrl(%j) -> %j', (value, expected) => {
    expect(optionalHttpUrl(value)).toBe(expected)
  })

  it.each([
    ['', null],
    ['https://hf-mirror.com', null],
    ['https://hf-mirror.com/', null],
    ['https://hf-mirror.com/?x=1', '地址不能包含 ? 或 # 之后的部分'],
    ['https://hf-mirror.com/#top', '地址不能包含 ? 或 # 之后的部分'],
    ['socks5://x', '地址需要以 http:// 或 https:// 开头'],
  ])('optionalHfEndpoint(%j) -> %j', (value, expected) => {
    expect(optionalHfEndpoint(value)).toBe(expected)
  })

  it.each([
    ['', null],
    ['socks5h://127.0.0.1:7890', null],
    ['socks4a://proxy:1080', null],
    ['http://proxy:3128/', null],
    ['https://user:pw@proxy:443', null],
    ['ftp://proxy:21', '代理需要 http、https 或 socks5 地址，例如 socks5h://127.0.0.1:7890'],
    ['http://proxy:3128/path', '代理地址只需要协议、主机和端口'],
    ['http://proxy:3128?x=1', '代理地址只需要协议、主机和端口'],
    ['127.0.0.1:7890', '这不是有效的代理地址，例如 socks5h://127.0.0.1:7890'],
    ['localhost:7890', '代理需要 http、https 或 socks5 地址，例如 socks5h://127.0.0.1:7890'],
    ['not a url', '这不是有效的代理地址，例如 socks5h://127.0.0.1:7890'],
  ])('optionalProxyUrl(%j) -> %j', (value, expected) => {
    expect(optionalProxyUrl(value)).toBe(expected)
  })

  it('integerInRange enforces digits and bounds, optionally allowing empty', () => {
    const port = integerInRange(1, 65535)
    expect(port('22')).toBeNull()
    expect(port(' 65535 ')).toBeNull()
    expect(port('0')).toBe('请输入 1 到 65535 之间的整数')
    expect(port('65536')).toBe('请输入 1 到 65535 之间的整数')
    expect(port('')).toBe('请输入 1 到 65535 之间的整数')
    for (const bad of ['-1', '1.5', '1e3', '0x10', '2 2']) expect(port(bad), bad).toBe('只能填写整数')
    expect(integerInRange(1, 16, { optional: true })('  ')).toBeNull()
  })

  it('singleLineToken rejects line breaks, NULs and overlong tokens', () => {
    expect(singleLineToken('  hf_abc  ')).toBeNull()
    expect(singleLineToken('hf_a\nb')).toBe('Token 不能包含换行')
    expect(singleLineToken('hf_a\rb')).toBe('Token 不能包含换行')
    expect(singleLineToken('hf\0')).toBe('Token 不能包含换行')
    expect(singleLineToken('x'.repeat(2048))).toBeNull()
    expect(singleLineToken(` ${'x'.repeat(2048)} `)).toBeNull()
    expect(singleLineToken('x'.repeat(2049))).toBe('Token 太长了')
  })

  it('requiredText names the field', () => {
    expect(requiredText('主机名')('  ')).toBe('主机名不能为空')
    expect(requiredText('主机名')('gpu')).toBeNull()
  })
})

describe('lib/settingsDraft commitText', () => {
  it('stores trimmed text, and empty text as null', () => {
    expect(commitText('  https://a.test  ', null)).toEqual({ kind: 'save', value: 'https://a.test' })
    expect(commitText('   ', 'https://a.test')).toEqual({ kind: 'save', value: null })
  })

  it('reports unchanged values, including after trimming', () => {
    expect(commitText(' x ', 'x')).toEqual({ kind: 'unchanged' })
    expect(commitText('', null)).toEqual({ kind: 'unchanged' })
  })

  it('validates the raw text before parsing', () => {
    let parsed = false
    const result = commitText('abc', 1, { validate: integerInRange(1, 9), parse: (text) => { parsed = true; return Number(text) } })
    expect(result).toEqual({ kind: 'invalid', message: '只能填写整数' })
    expect(parsed).toBe(false)
  })

  it('uses the parser and compares structurally', () => {
    expect(commitText(' 8 ', 4, { parse: Number })).toEqual({ kind: 'save', value: 8 })
    expect(commitText('4', 4, { parse: Number })).toEqual({ kind: 'unchanged' })
    const parse = (text: string) => text.split(',').map((item) => item.trim()).filter(Boolean)
    expect(commitText('a, b', ['a', 'b'], { parse })).toEqual({ kind: 'unchanged' })
    expect(commitText('b, a', ['a', 'b'], { parse })).toEqual({ kind: 'save', value: ['b', 'a'] })
  })

  it('treats NaN as unchanged against NaN', () => {
    expect(commitText('x', Number.NaN, { parse: Number })).toEqual({ kind: 'unchanged' })
  })
})

describe('lib/settingsDraft textOf', () => {
  it.each([[null, ''], [undefined, ''], ['', ''], ['a', 'a'], [0, '0'], [7890, '7890']])('textOf(%j) = %j', (value, expected) => {
    expect(textOf(value)).toBe(expected)
  })
})
