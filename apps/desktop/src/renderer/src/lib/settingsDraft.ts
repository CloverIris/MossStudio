/**
 * Settings use one save model: switches and choices save the moment they
 * change, text fields save when they lose focus or on Enter. These helpers
 * decide what a typed value means before it is sent to the main process.
 */

/** Returns an error message for the person, or null when the value is fine. */
export type Validator = (value: string) => string | null

/** Empty is allowed (it means "use the default"); otherwise an http(s) address without credentials. */
export const optionalHttpUrl: Validator = (value) => {
  const text = value.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '地址需要以 http:// 或 https:// 开头'
    if (url.username || url.password) return '地址里不能包含用户名或密码'
    return null
  } catch {
    return '这不是有效的网址，例如 https://hf-mirror.com'
  }
}

/** HF endpoints are also rejected by the main process when they carry a query or a fragment. */
export const optionalHfEndpoint: Validator = (value) => {
  const base = optionalHttpUrl(value)
  if (base || !value.trim()) return base
  const url = new URL(value.trim())
  return url.search || url.hash ? '地址不能包含 ? 或 # 之后的部分' : null
}

export const optionalProxyUrl: Validator = (value) => {
  const text = value.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    const allowed = ['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']
    if (!allowed.includes(url.protocol) || !url.hostname) return '代理需要 http、https 或 socks5 地址，例如 socks5h://127.0.0.1:7890'
    if (url.search || url.hash || (url.pathname && url.pathname !== '/')) return '代理地址只需要协议、主机和端口'
    return null
  } catch {
    return '这不是有效的代理地址，例如 socks5h://127.0.0.1:7890'
  }
}

export function integerInRange(min: number, max: number, options: { optional?: boolean } = {}): Validator {
  return (value) => {
    const text = value.trim()
    if (!text) return options.optional ? null : `请输入 ${min} 到 ${max} 之间的整数`
    if (!/^\d+$/.test(text)) return '只能填写整数'
    const number = Number(text)
    return number < min || number > max ? `请输入 ${min} 到 ${max} 之间的整数` : null
  }
}

/** Tokens are pasted, so stray whitespace is trimmed; line breaks mean the paste went wrong. */
export const singleLineToken: Validator = (value) =>
  /[\r\n\0]/.test(value) ? 'Token 不能包含换行' : value.trim().length > 2048 ? 'Token 太长了' : null

export const requiredText = (label: string): Validator => (value) => value.trim() ? null : `${label}不能为空`

export type TextCommit<T> =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; message: string }
  | { kind: 'save'; value: T }

/**
 * Decide what to do with a text field when it is committed (blur or Enter).
 * `parse` turns the trimmed text into the stored value; the default stores
 * empty text as null ("use the default").
 */
export function commitText<T = string | null>(
  raw: string,
  saved: T,
  options: { validate?: Validator; parse?: (text: string) => T } = {},
): TextCommit<T> {
  const message = options.validate?.(raw) ?? null
  if (message) return { kind: 'invalid', message }
  const text = raw.trim()
  const value = options.parse ? options.parse(text) : ((text || null) as T)
  return Object.is(value, saved) || JSON.stringify(value) === JSON.stringify(saved)
    ? { kind: 'unchanged' }
    : { kind: 'save', value }
}

/** How a stored value is shown in its text field. */
export function textOf(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * Enter commits a field and the blur that usually follows commits it again,
 * before the saved value has come back. The guard remembers the text already
 * sent so the same text is saved once; typing (or a failed save) clears it.
 */
export interface CommitGuard {
  /** False when exactly this text was already sent. */
  shouldCommit: (draft: string) => boolean
  sent: (draft: string) => void
  failed: () => void
  reset: () => void
}

export function createCommitGuard(): CommitGuard {
  let last: string | null = null
  return {
    shouldCommit: (draft) => draft !== last,
    sent: (draft) => { last = draft },
    failed: () => { last = null },
    reset: () => { last = null },
  }
}
